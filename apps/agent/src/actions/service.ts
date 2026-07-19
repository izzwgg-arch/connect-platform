/**
 * Action + Approval lifecycle (PLAN.md §6). The state machine every catalog
 * action (A1–A12) and every PBX provisioning action (P1–P14) flows through.
 *
 *   DRAFT ─create─► PENDING_APPROVAL ─approve─► APPROVED ─execute─► EXECUTING
 *                        │                                              │
 *                     deny│                                        success│fail
 *                        ▼                                              ▼
 *                     DENIED                              EXECUTED ──(revertAt)──► REVERTED
 *                        └────────── EXPIRED (ttl) ◄──────────────────┘
 *
 * Owner-requested actions may be auto-approved (owner's word), but pre-flight,
 * audit, and the confirmation email still run. Execution is delegated to a
 * backend keyed by capability prefix ("pbx." → Scoped Executor). Auto-revert is
 * DB-backed via revertAt and survives restarts.
 */
import type { AuditLog } from "../audit/audit";
import type { Notifier } from "../notify/notifier";
import { makeApprovalToken } from "./tokens";

export type ActionStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "EXECUTING"
  | "EXECUTED"
  | "REVERTED"
  | "DENIED"
  | "EXPIRED"
  | "FAILED";

export interface ExecuteBackend {
  /** Perform the real work for an approved action. Returns a result snapshot. */
  execute(action: any, opts: { live: boolean }): Promise<{ ok: boolean; snapshot?: unknown; error?: string }>;
  /** Optional revert of a previously executed action. */
  revert?(action: any): Promise<{ ok: boolean; error?: string }>;
}

export interface CreateActionInput {
  tenantId: string;
  capabilityId: string;
  params: Record<string, unknown>;
  summary: string;
  requestedBy: string;
  requestedRole: "owner" | "customer";
  conversationId?: string;
  /** hours until auto-revert (temporary actions); omitted = permanent */
  revertAfterHours?: number;
  /** owner-mode auto-approval */
  autoApprove?: boolean;
  riskTier?: string;
}

export class ActionService {
  constructor(
    private prisma: any,
    private audit: AuditLog,
    private notifier: Notifier,
    private backends: Record<string, ExecuteBackend>,
    private opts: { approvalBaseUrl?: string; liveWrites?: boolean } = {},
  ) {}

  private backendFor(capabilityId: string): ExecuteBackend | null {
    const prefix = capabilityId.split(".")[0] + ".";
    return this.backends[prefix] ?? this.backends[capabilityId] ?? null;
  }

  async create(input: CreateActionInput): Promise<any> {
    const revertAt = input.revertAfterHours ? new Date(Date.now() + input.revertAfterHours * 3600 * 1000) : null;
    const action = await this.prisma.agentAction.create({
      data: {
        tenantId: input.tenantId,
        conversationId: input.conversationId ?? null,
        capabilityId: input.capabilityId,
        params: input.params as any,
        riskTier: input.riskTier ?? "low",
        status: "PENDING_APPROVAL",
        summary: input.summary,
        requestedBy: input.requestedBy,
        requestedRole: input.requestedRole,
        revertAt,
        approvalToken: null,
      },
    });
    await this.audit.record({ actor: input.requestedRole, event: "action.created", tenantId: input.tenantId, actionId: action.id, capabilityId: input.capabilityId, payload: { summary: input.summary } });

    if (input.autoApprove && input.requestedRole === "owner") {
      return this.approve(action.id, `owner:${input.requestedBy}`, { auto: true });
    }
    await this.sendApprovalEmail(action);
    return action;
  }

  private async sendApprovalEmail(action: any): Promise<void> {
    const base = this.opts.approvalBaseUrl ?? "";
    const approve = base ? `${base}/agent-api/approve?token=${makeApprovalToken(action.id, "approve")}` : "(portal Approvals page)";
    const deny = base ? `${base}/agent-api/approve?token=${makeApprovalToken(action.id, "deny")}` : "(portal Approvals page)";
    await this.notifier.send({
      kind: "approval_request",
      to: this.notifier.ownerRecipients(),
      subject: `[APPROVE] ${action.summary}`,
      text: `Action ${action.id}\nTenant: ${action.tenantId}\nCapability: ${action.capabilityId}\n\n${action.summary}\n\nApprove: ${approve}\nDeny: ${deny}\n\n(Expires in 4h. Also available on the portal Approvals page.)`,
    });
  }

  async approve(actionId: string, approvedBy: string, meta: { auto?: boolean } = {}): Promise<any> {
    const action = await this.prisma.agentAction.findUnique({ where: { id: actionId } });
    if (!action) throw new Error("action_not_found");
    if (action.status !== "PENDING_APPROVAL") return action; // idempotent / already decided
    const approved = await this.prisma.agentAction.update({ where: { id: actionId }, data: { status: "APPROVED", approvedBy } });
    await this.audit.record({ actor: meta.auto ? "owner" : "owner", event: meta.auto ? "action.auto_approved" : "action.approved", tenantId: action.tenantId, actionId, capabilityId: action.capabilityId, payload: { approvedBy } });
    return this.executeApproved(approved);
  }

  async deny(actionId: string, deniedBy: string, reason = "denied"): Promise<any> {
    const action = await this.prisma.agentAction.findUnique({ where: { id: actionId } });
    if (!action || action.status !== "PENDING_APPROVAL") return action;
    const denied = await this.prisma.agentAction.update({ where: { id: actionId }, data: { status: "DENIED", deniedReason: reason, approvedBy: deniedBy } });
    await this.audit.record({ actor: "owner", event: "action.denied", tenantId: action.tenantId, actionId, payload: { deniedBy, reason } });
    return denied;
  }

  private async executeApproved(action: any): Promise<any> {
    const backend = this.backendFor(action.capabilityId);
    if (!backend) {
      const failed = await this.prisma.agentAction.update({ where: { id: action.id }, data: { status: "FAILED", errorDetail: "no_backend" } });
      await this.audit.record({ actor: "system", event: "action.failed", actionId: action.id, payload: { reason: "no_backend" } });
      return failed;
    }
    await this.prisma.agentAction.update({ where: { id: action.id }, data: { status: "EXECUTING" } });
    const live = !!this.opts.liveWrites;
    let res: { ok: boolean; snapshot?: unknown; error?: string };
    try {
      res = await backend.execute(action, { live });
    } catch (err) {
      res = { ok: false, error: String(err) };
    }
    if (!res.ok) {
      const failed = await this.prisma.agentAction.update({ where: { id: action.id }, data: { status: "FAILED", errorDetail: res.error ?? "execute_failed" } });
      await this.audit.record({ actor: "agent", event: "action.execute_failed", tenantId: action.tenantId, actionId: action.id, payload: { error: res.error } });
      await this.notifier.send({ kind: "action_failed", to: this.notifier.ownerRecipients(), subject: `[Agent] Action FAILED: ${action.summary}`, text: `Action ${action.id} failed: ${res.error}` });
      return failed;
    }
    const done = await this.prisma.agentAction.update({ where: { id: action.id }, data: { status: "EXECUTED", executedAt: new Date(), resultSnapshot: (res.snapshot ?? {}) as any } });
    await this.audit.record({ actor: "agent", event: "action.executed", tenantId: action.tenantId, actionId: action.id, capabilityId: action.capabilityId, payload: { live } });
    await this.notifier.send({ kind: "action_executed", to: this.notifier.ownerRecipients(), subject: `[Agent] Done: ${action.summary}`, text: `Action ${action.id} executed${action.revertAt ? `, auto-reverts ${action.revertAt.toISOString?.() ?? action.revertAt}` : ""}.` });
    return done;
  }

  /** Scheduler tick — expire stale pending actions, auto-revert due ones. DB-backed. */
  async tick(now = new Date()): Promise<{ expired: number; reverted: number }> {
    const fourHAgo = new Date(now.getTime() - 4 * 3600 * 1000);
    const stale = await this.prisma.agentAction.findMany({ where: { status: "PENDING_APPROVAL", createdAt: { lt: fourHAgo } } });
    for (const a of stale) {
      await this.prisma.agentAction.update({ where: { id: a.id }, data: { status: "EXPIRED" } });
      await this.audit.record({ actor: "system", event: "action.expired", actionId: a.id });
    }
    const due = await this.prisma.agentAction.findMany({ where: { status: "EXECUTED", revertAt: { not: null, lte: now } } });
    let reverted = 0;
    for (const a of due) {
      const backend = this.backendFor(a.capabilityId);
      const r = backend?.revert ? await backend.revert(a) : { ok: true };
      if (r.ok) {
        await this.prisma.agentAction.update({ where: { id: a.id }, data: { status: "REVERTED", revertedAt: now } });
        await this.audit.record({ actor: "agent", event: "action.reverted", actionId: a.id, tenantId: a.tenantId });
        await this.notifier.send({ kind: "action_reverted", to: this.notifier.ownerRecipients(), subject: `[Agent] Reverted: ${a.summary}`, text: `Action ${a.id} auto-reverted on schedule.` });
        reverted++;
      } else {
        await this.audit.record({ actor: "system", event: "action.revert_failed", actionId: a.id, payload: { error: r.error } });
      }
    }
    return { expired: stale.length, reverted };
  }
}
