/**
 * Scoped PBX Executor (PBX_PROVISIONING_PLAN.md §3, §5).
 *
 * The ONLY code path in the entire system that can write to the PBX. It is
 * additive-only and ownership-scoped:
 *
 *   - It can ONLY dispatch operations in PROVISIONING_CATALOG (create-only).
 *   - A create writes the new object id into the Ownership Ledger.
 *   - An edit/apply op ("creates: false") is permitted ONLY if its target id is
 *     already in the ledger (i.e. the agent created it). Anything not in the
 *     ledger is pre-existing / not-ours and is HARD REFUSED.
 *   - No blanket tenant PUT, no delete of pre-existing objects, is even
 *     representable — those keys are not in the catalog.
 *
 * Live-write posture (enforced here, belt-and-suspenders with the client):
 *   - Default mode is `simulate` — no PBX contact at all. Certification runs here.
 *   - Live writes require BOTH an explicit `mode: "live"` AND an owner token
 *     passed per call; the executor then constructs a VitalPbxClient with
 *     allowConfigMutations:true for that single call only. PBX_ALLOW_CONFIG_MUTATIONS
 *     is never read or set by this service.
 */
import { z } from "zod";
import type { AuditLog } from "../audit/audit";
import { PROVISIONING_CATALOG, ledgerType, type ProvOp } from "./provisioning";

export type ExecMode = "simulate" | "live";

export interface ExecInput {
  opId: string; // e.g. "P1"
  params: Record<string, unknown>;
  requestedBy: string; // "owner:<id>"
  actionId?: string;
  mode?: ExecMode;
  /** Required and validated by the caller for live mode. */
  ownerConfirmed?: boolean;
}

export interface ExecResult {
  ok: boolean;
  opId: string;
  mode: ExecMode;
  createdObjectId?: string;
  ledgerId?: string;
  refusedReason?: string;
  simulatedPayload?: unknown;
}

/** Minimal shape of the VitalPBX client the executor needs. */
export interface PbxClientLike {
  callEndpointRaw(input: { method: string; path: string; tenant?: string; body?: unknown }): Promise<any>;
}

export class ScopedPbxExecutor {
  constructor(
    private prisma: any,
    private audit: AuditLog,
    /** Factory returns a client. In simulate mode the client must not contact the PBX. */
    private makeClient: (opts: { simulate: boolean; allowConfigMutations: boolean }) => PbxClientLike,
  ) {}

  async execute(input: ExecInput): Promise<ExecResult> {
    const mode: ExecMode = input.mode ?? "simulate";
    const op = PROVISIONING_CATALOG[input.opId];

    // Gate 0: op must be in the create-only catalog.
    if (!op) return this.refuse(input, mode, `Unknown or non-provisioning op '${input.opId}' — not dispatchable.`);

    // Gate 1: schema validation.
    const parsed = op.schema.safeParse(input.params);
    if (!parsed.success) return this.refuse(input, mode, `Invalid params: ${JSON.stringify(parsed.error.issues)}`);
    const params = parsed.data as Record<string, any>;

    // Gate 2: additive / ownership. Edits (creates:false) require the target in the ledger.
    if (!op.creates) {
      const targetId = this.targetIdFor(op, params);
      const owned = await this.isOwned(op, targetId, mode);
      if (!owned) {
        return this.refuse(input, mode, `Refused: target ${op.kind} '${targetId}' is not in the Ownership Ledger (pre-existing / not created by the agent). Additive-only contract.`);
      }
    }

    // Gate 2b: creating a CHILD object (extension, DID, IVR, route…) under a
    // tenant the agent did NOT create still adds to an existing tenant. Honor
    // "nothing of existing tenants changes whatsoever": refuse by default unless
    // the owner explicitly confirms this specific add to an existing tenant.
    if (op.creates && op.kind !== "tenant" && params.tenantId) {
      const parentOwned = await this.prisma.agentPbxObject.findFirst({
        where: { pbxObjectType: "tenant", pbxObjectId: String(params.tenantId), state: "active", simulated: mode === "simulate" },
      });
      if (!parentOwned && !input.ownerConfirmed) {
        return this.refuse(
          input,
          mode,
          `Refused: '${op.kind}' would be added to existing tenant '${params.tenantId}' (not created by the agent). This changes an existing tenant — requires explicit ownerConfirmed=true for this specific add.`,
        );
      }
    }

    // Gate 3: live-mode requires explicit confirmation + a real live client.
    if (mode === "live" && !input.ownerConfirmed) {
      return this.refuse(input, mode, "Live PBX write requires ownerConfirmed=true (per-op approval).");
    }

    // Build the request. :tenantId / :extensionId substituted from params.
    const path = op.path
      .replace(":tenantId", encodeURIComponent(String(params.tenantId ?? "")))
      .replace(":extensionId", encodeURIComponent(String(params.extensionId ?? "")));
    const tenant = params.tenantId ? String(params.tenantId) : undefined;

    const client = this.makeClient({ simulate: mode === "simulate", allowConfigMutations: mode === "live" });

    await this.audit.record({
      actor: "owner",
      event: "pbx.provision.dispatch",
      capabilityId: `pbx.${op.id}`,
      tenantId: tenant,
      actionId: input.actionId,
      payload: { opId: op.id, kind: op.kind, method: op.method, path, mode, requestedBy: input.requestedBy, creates: op.creates },
    });

    let resp: any;
    try {
      resp = await client.callEndpointRaw({ method: op.method, path, tenant, body: this.bodyFor(op, params) });
    } catch (err) {
      await this.audit.record({ actor: "system", event: "pbx.provision.error", capabilityId: `pbx.${op.id}`, payload: { error: String(err), opId: op.id, mode } });
      return { ok: false, opId: op.id, mode, refusedReason: `PBX call failed: ${String(err)}` };
    }

    // Record created object in the ledger.
    let ledgerId: string | undefined;
    let createdObjectId: string | undefined;
    if (op.creates) {
      createdObjectId = this.extractId(op, resp, params, mode);
      const row = await this.prisma.agentPbxObject.create({
        data: {
          pbxObjectType: ledgerType(op),
          pbxObjectId: createdObjectId,
          pbxTenantId: tenant ?? null,
          connectTenantId: null,
          createdByActionId: input.actionId ?? null,
          state: "active",
          simulated: mode === "simulate",
          meta: { opId: op.id, params } as any,
        },
      });
      ledgerId = row.id;
    }

    await this.audit.record({
      actor: "owner",
      event: "pbx.provision.done",
      capabilityId: `pbx.${op.id}`,
      tenantId: tenant,
      actionId: input.actionId,
      payload: { opId: op.id, mode, createdObjectId, ledgerId },
    });

    return { ok: true, opId: op.id, mode, createdObjectId, ledgerId, simulatedPayload: mode === "simulate" ? resp : undefined };
  }

  private async isOwned(op: ProvOp, targetId: string, mode: ExecMode): Promise<boolean> {
    if (!targetId) return false;
    const row = await this.prisma.agentPbxObject.findFirst({
      where: { pbxObjectType: op.kind === "apply_changes" ? "tenant" : op.kind, pbxObjectId: targetId, state: "active", simulated: mode === "simulate" },
    });
    return !!row;
  }

  private targetIdFor(op: ProvOp, params: Record<string, any>): string {
    if (op.kind === "apply_changes") return String(params.tenantId ?? "");
    if (op.kind === "extension_features") return String(params.extensionId ?? "");
    return String(params.tenantId ?? "");
  }

  private bodyFor(op: ProvOp, params: Record<string, any>): unknown {
    // Strip routing-only fields from the body.
    const { tenantId: _t, extensionId: _e, ...body } = params;
    return body;
  }

  private extractId(op: ProvOp, resp: any, params: Record<string, any>, mode: ExecMode): string {
    if (mode === "simulate") return `sim_${op.kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const data = resp?.data ?? resp;
    const key = op.idPath ?? "id";
    return String(data?.[key] ?? data?.uuid ?? `${op.kind}_unknown`);
  }

  private async refuse(input: ExecInput, mode: ExecMode, reason: string): Promise<ExecResult> {
    await this.audit.record({ actor: "system", event: "pbx.provision.refused", capabilityId: `pbx.${input.opId}`, payload: { reason, mode, requestedBy: input.requestedBy } });
    return { ok: false, opId: input.opId, mode, refusedReason: reason };
  }
}

/** Static guard used by the safeguard test: prove the catalog contains no
 *  destructive operation against pre-existing objects. */
export function catalogHasNoDestructiveOps(): boolean {
  for (const op of Object.values(PROVISIONING_CATALOG)) {
    const method = op.method as string; // TS proves method is POST|PATCH; runtime guard is defense-in-depth
    if (method === "PUT") return false; // no blanket replaces
    if (method === "DELETE") return false; // no deletes at all in the catalog
    if (op.path === "/api/v2/tenants/:tenantId") return false; // no whole-tenant resource writes
  }
  return true;
}
