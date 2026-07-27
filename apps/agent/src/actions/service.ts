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
import { makeApprovalToken, verifyApprovalToken } from "./tokens";
import { requiresBinding, computeParamsHash, makeBoundApprovalToken, verifyBoundApprovalToken } from "./bindings";

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

/**
 * OWNER MANDATE (Izzy, 2026-07-26): putting a phone IN or OUT of DND executes
 * immediately when a user asks — no approval loop. Scope is EXACTLY pbx.M11
 * with feature=DND; call-forwards (CFU/CFB/CFN/CFI) and every other capability
 * keep the normal Izzy-approval flow. The X1 binding contract still holds: the
 * action row stays params-hash-bound and its approval is consumed single-use,
 * so the modify executor's G8 gate verifies unchanged. Every other fence
 * (scope, protected extensions, live tenant allow-list, rate budget,
 * snapshot/verify/auto-revert, audit, result email) still applies.
 * Kill switch: AGENT_DND_AUTO_APPROVE=0.
 */
export function dndAutoApproveMandate(capabilityId: string, params: Record<string, unknown>): boolean {
  if (process.env.AGENT_DND_AUTO_APPROVE === "0") return false;
  return capabilityId === "pbx.M11" && String((params as any)?.feature ?? "") === "DND";
}

/**
 * OWNER MANDATE (Izzy, 2026-07-26 #2, extended #3): hold-music changes execute
 * immediately when the tenant asks — tenant-wide (M1: switch/deactivate/timed
 * expiry/scheduled windows) AND per-extension (M2: set/clear). Same contract
 * as the DND mandate: params-hash binding, scope fence (own tenant + own MOH
 * profiles only), live-tenant allow-list, rate budget, snapshot/verify/
 * auto-revert, audit, and result email all still apply.
 * Kill switch: AGENT_MOH_AUTO_APPROVE=0 (covers both M1 and M2).
 */
export function mohAutoApproveMandate(capabilityId: string): boolean {
  if (process.env.AGENT_MOH_AUTO_APPROVE === "0") return false;
  return capabilityId === "pbx.M1" || capabilityId === "pbx.M2";
}

/** Owner-mandate label for a capability/params combo, or null when none applies. */
export function ownerMandateFor(capabilityId: string, params: Record<string, unknown>): string | null {
  if (dndAutoApproveMandate(capabilityId, params)) return "dnd-2026-07-26";
  if (mohAutoApproveMandate(capabilityId)) return "moh-2026-07-26";
  return null;
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
  /** minute-level auto-revert (e.g. extension MOH "for 15 minutes"); wins over hours */
  revertAfterMinutes?: number;
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
    // Exact id first, then LONGEST matching prefix ("pbx.M" beats "pbx." for
    // "pbx.M1" so modify capabilities route to the Modify Executor while the
    // P-series keeps routing to the additive Scoped Executor).
    if (this.backends[capabilityId]) return this.backends[capabilityId];
    const prefixes = Object.keys(this.backends)
      .filter((k) => capabilityId.startsWith(k))
      .sort((a, b) => b.length - a.length);
    return prefixes.length ? this.backends[prefixes[0]] : null;
  }

  async create(input: CreateActionInput): Promise<any> {
    const revertMs = input.revertAfterMinutes
      ? input.revertAfterMinutes * 60_000
      : input.revertAfterHours
        ? input.revertAfterHours * 3600_000
        : null;
    const revertAt = revertMs ? new Date(Date.now() + revertMs) : null;

    // X1: modify/repair capabilities are params-hash-bound, capped, and not
    // auto-approved — every live write goes through Izzy's explicit approval.
    // SOLE exception: the DND owner mandate (dndAutoApproveMandate above).
    const bound = requiresBinding(input.capabilityId);
    let paramsHash: string | null = null;
    if (bound) {
      const maxPending = Number(process.env.AGENT_MODIFY_MAX_PENDING_PER_TENANT ?? 3);
      const pending = await this.prisma.agentAction.count({
        where: { tenantId: input.tenantId, status: "PENDING_APPROVAL", paramsHash: { not: null } },
      });
      if (pending >= maxPending) {
        const denied = await this.prisma.agentAction.create({
          data: {
            tenantId: input.tenantId,
            conversationId: input.conversationId ?? null,
            capabilityId: input.capabilityId,
            params: input.params as any,
            riskTier: input.riskTier ?? "medium",
            status: "DENIED",
            deniedReason: `modify_pending_cap: ${maxPending} changes already awaiting approval for this tenant`,
            summary: input.summary,
            requestedBy: input.requestedBy,
            requestedRole: input.requestedRole,
            revertAt: null,
            approvalToken: null,
            paramsHash: null,
          },
        });
        await this.audit.record({ actor: "system", event: "action.denied_pending_cap", tenantId: input.tenantId, actionId: denied.id, capabilityId: input.capabilityId, payload: { maxPending } });
        return denied;
      }
      paramsHash = computeParamsHash(input.capabilityId, input.tenantId, input.params);
    }

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
        paramsHash,
      },
    });
    if (bound) {
      // Post-create re-check closes the check-then-create race: every creator
      // counts AFTER its own row exists, so any row that pushes the pending set
      // over the cap sees the excess and demotes itself. Pending can therefore
      // never settle above the cap regardless of interleaving.
      const maxPending = Number(process.env.AGENT_MODIFY_MAX_PENDING_PER_TENANT ?? 3);
      const nowPending = await this.prisma.agentAction.count({
        where: { tenantId: input.tenantId, status: "PENDING_APPROVAL", paramsHash: { not: null } },
      });
      if (nowPending > maxPending) {
        const demoted = await this.prisma.agentAction.update({
          where: { id: action.id },
          data: { status: "DENIED", deniedReason: `modify_pending_cap: ${maxPending} changes already awaiting approval for this tenant` },
        });
        await this.audit.record({ actor: "system", event: "action.denied_pending_cap", tenantId: input.tenantId, actionId: action.id, capabilityId: input.capabilityId, payload: { maxPending, race: true } });
        return demoted;
      }
    }

    await this.audit.record({ actor: input.requestedRole, event: "action.created", tenantId: input.tenantId, actionId: action.id, capabilityId: input.capabilityId, payload: { summary: input.summary, bound } });

    // Owner-mandate exceptions to the "bound is never auto-approved" rule —
    // see dndAutoApproveMandate / mohAutoApproveMandate above.
    const mandate = bound ? ownerMandateFor(input.capabilityId, input.params) : null;
    if (mandate) {
      await this.audit.record({
        actor: "system",
        event: "action.owner_mandate_auto_approve",
        tenantId: input.tenantId,
        actionId: action.id,
        capabilityId: input.capabilityId,
        payload: { mandate, requestedBy: input.requestedBy, requestedRole: input.requestedRole },
      });
      return this.approve(action.id, `owner-mandate:${mandate}`, { auto: true });
    }

    if (input.autoApprove && input.requestedRole === "owner" && !bound) {
      return this.approve(action.id, `owner:${input.requestedBy}`, { auto: true });
    }
    await this.sendApprovalEmail(action);
    return action;
  }

  private async sendApprovalEmail(action: any): Promise<void> {
    const base = this.opts.approvalBaseUrl ?? "";
    // Bound (modify/repair) actions get params-hash-bound tokens: the link can
    // only ever approve the exact change described in this email, exactly once.
    const mk = (decision: "approve" | "deny") =>
      action.paramsHash ? makeBoundApprovalToken(action.id, decision, action.paramsHash) : makeApprovalToken(action.id, decision);
    const approve = base ? `${base}/agent-api/approve?token=${mk("approve")}` : "(portal Approvals page)";
    const deny = base ? `${base}/agent-api/approve?token=${mk("deny")}` : "(portal Approvals page)";
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
    if (action.paramsHash) {
      // X1 single-use consume: atomically claim APPROVED → EXECUTING. If another
      // worker (or a replayed link) already claimed it, refuse — one approval
      // executes exactly once.
      const claimed = await this.prisma.agentAction.updateMany({
        where: { id: action.id, status: "APPROVED", approvalConsumedAt: null },
        data: { status: "EXECUTING", approvalConsumedAt: new Date() },
      });
      if (!claimed || claimed.count === 0) {
        await this.audit.record({ actor: "system", event: "action.duplicate_execute_blocked", actionId: action.id, capabilityId: action.capabilityId });
        return this.prisma.agentAction.findUnique({ where: { id: action.id } });
      }
    } else {
      await this.prisma.agentAction.update({ where: { id: action.id }, data: { status: "EXECUTING" } });
    }
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

  /**
   * Redeem an email approve/deny link (X1-aware). Bound (modify/repair) actions
   * REQUIRE a bound token whose params-hash matches the frozen row — a legacy
   * unbound token can never decide a bound action.
   */
  async redeemEmailDecision(token: string): Promise<{ ok: boolean; decision?: "approve" | "deny"; error?: string; action?: any }> {
    const bound = verifyBoundApprovalToken(token);
    const legacy = bound ? null : verifyApprovalToken(token);
    const v = bound ?? legacy;
    if (!v) return { ok: false, error: "invalid_or_expired_token" };
    const row = await this.prisma.agentAction.findUnique({ where: { id: v.actionId } });
    if (!row) return { ok: false, error: "action_not_found" };
    if (row.paramsHash) {
      if (!bound) return { ok: false, error: "bound_token_required" };
      if (bound.paramsHash !== row.paramsHash) {
        await this.audit.record({ actor: "system", event: "action.bound_token_mismatch", actionId: row.id, payload: { reason: "params_hash_mismatch" } });
        return { ok: false, error: "token_binding_mismatch" };
      }
    }
    const action = v.decision === "approve" ? await this.approve(v.actionId, "email-link") : await this.deny(v.actionId, "email-link");
    return { ok: true, decision: v.decision, action };
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
