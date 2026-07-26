/**
 * Modify Executor (X1 — docs/ai-support-agent/specs/X1_MODIFY_EXECUTOR_SPEC.md).
 *
 * The ONLY code path that will ever be allowed to MODIFY pre-existing PBX
 * objects (roadmap Groups 1/2/4). It is the strictly-stronger sibling of the
 * additive-only ScopedPbxExecutor, which stays untouched for the P-series.
 *
 * Gate chain (every refusal is an audit row; order per spec §3.3):
 *   G0   kill switch
 *   G0b  master switch (AGENT_MODIFY_ENABLED, fail-closed)
 *   G1   capability in MODIFY_CATALOG (EMPTY in X1 ⇒ everything refuses here)
 *   G2   zod schema
 *   G3   scope fence — object ownership proven against the Connect DB mirror
 *        (fail-closed: no resolver wired ⇒ refuse)
 *   G4   rate fence — global live-write budget/hour
 *   G5   protected extensions
 *   G6   live tenant allow-list (AGENT_PBX_LIVE_TENANTS, fail-closed)
 *   G7   feasibility — only proven-real paths ("db"+regen is unrepresentable)
 *   G8   approval binding — live requires an action row that is EXECUTING with
 *        its single-use approval consumed and a params-hash that matches BOTH
 *        the row and this call's params
 *   G9   snapshot — full pre-state captured + checksummed, or hard refuse
 *   G10  dispatch — via injected client factory (X1 wiring: simulate-only)
 *   G11  verify — re-read + diff; mismatch ⇒ automatic revert from snapshot
 *
 * X1 ships with an EMPTY catalog and a simulate-only client factory: this file
 * being merged enables NOTHING on the PBX.
 */
import type { AuditLog } from "../audit/audit";
import { killSwitchEngaged } from "../config";
import { computeParamsHash } from "../actions/bindings";
import { MODIFY_CATALOG, type ModifyClientLike, type ModifyOp } from "./modifyCatalog";
import { SnapshotStore } from "./snapshotStore";

export type ModifyMode = "simulate" | "live";

export interface ModifyExecInput {
  capabilityId: string; // e.g. "pbx.M1"
  params: Record<string, unknown>;
  requestedBy: string; // "customer:<id>" | "owner:<id>"
  requestedRole: "owner" | "customer";
  actionId?: string; // required for live
  mode?: ModifyMode;
}

export interface ModifyExecResult {
  ok: boolean;
  capabilityId: string;
  mode: ModifyMode;
  gate?: string; // gate that refused
  refusedReason?: string;
  snapshotId?: string;
  written?: unknown;
  verified?: boolean;
  autoReverted?: boolean;
}

export interface ModifyRevertResult {
  ok: boolean;
  refusedReason?: string;
  restored?: unknown;
}

/** Proves (tenant, objectType, objectId, requester) line up in the Connect DB mirror. */
export type ScopeCheck = (input: {
  tenantId: string;
  objectType: string;
  objectId: string;
  requestedBy: string;
  requestedRole: "owner" | "customer";
  /** Full validated op params — lets mappings check referenced objects (e.g. M1 profileId). */
  params?: Record<string, any>;
}) => Promise<boolean>;

export interface ModifyExecutorOpts {
  catalog?: Record<string, ModifyOp>;
  /** Fail-closed default: refuses everything until a real resolver is wired (per-op, from M1 on). */
  scopeCheck?: ScopeCheck;
  killSwitch?: () => boolean;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export class ModifyPbxExecutor {
  private catalog: Record<string, ModifyOp>;
  private scopeCheck: ScopeCheck;
  private killSwitch: () => boolean;
  private env: Record<string, string | undefined>;
  private now: () => number;
  /** Sliding-hour global live-write budget (G4). */
  private liveWindowStart = 0;
  private liveWindowCount = 0;

  constructor(
    private prisma: any,
    private audit: AuditLog,
    private snapshots: SnapshotStore,
    /** X1 wiring passes a factory that ALWAYS returns a simulate client. */
    private makeClient: (opts: { simulate: boolean }) => ModifyClientLike,
    opts: ModifyExecutorOpts = {},
  ) {
    this.catalog = opts.catalog ?? MODIFY_CATALOG;
    this.scopeCheck = opts.scopeCheck ?? (async () => false);
    this.killSwitch = opts.killSwitch ?? killSwitchEngaged;
    this.env = opts.env ?? (process.env as Record<string, string | undefined>);
    this.now = opts.now ?? Date.now;
  }

  /** Roll the sliding hour window if it has elapsed. Synchronous. */
  private rollLiveWindow(now: number): void {
    if (now - this.liveWindowStart >= 3600_000) {
      this.liveWindowStart = now;
      this.liveWindowCount = 0;
    }
  }

  /** Read-only "is the budget already spent?" for the advisory G4 early-fail. */
  private liveBudgetFull(now: number): boolean {
    this.rollLiveWindow(now);
    const cap = Number(this.env.AGENT_PBX_LIVE_WRITES_PER_HOUR ?? 10);
    return this.liveWindowCount >= cap;
  }

  /**
   * Atomic check-and-increment of the live-write budget. MUST stay fully
   * synchronous (no await) so concurrent callers cannot both observe the same
   * pre-increment count — this is what makes the cap hold under concurrency.
   * Returns false (and reserves nothing) when the window is full.
   */
  private reserveLiveSlot(now: number): boolean {
    this.rollLiveWindow(now);
    const cap = Number(this.env.AGENT_PBX_LIVE_WRITES_PER_HOUR ?? 10);
    if (this.liveWindowCount >= cap) return false;
    this.liveWindowCount++;
    return true;
  }

  async execute(input: ModifyExecInput): Promise<ModifyExecResult> {
    const mode: ModifyMode = input.mode ?? "simulate";

    // G0: kill switch.
    if (this.killSwitch()) return this.refuse(input, mode, "G0", "Kill switch engaged — all modify operations halted.");

    // G0b: master switch, fail-closed.
    if (this.env.AGENT_MODIFY_ENABLED !== "1") {
      return this.refuse(input, mode, "G0b", "Modify pipeline disabled (AGENT_MODIFY_ENABLED != 1).");
    }

    // G1: capability must be in the catalog (empty in X1 ⇒ always refuses here).
    const op = this.catalog[input.capabilityId];
    if (!op) return this.refuse(input, mode, "G1", `Capability '${input.capabilityId}' is not in MODIFY_CATALOG — not dispatchable.`);

    // G2: schema.
    const parsed = op.schema.safeParse(input.params);
    if (!parsed.success) return this.refuse(input, mode, "G2", `Invalid params: ${JSON.stringify(parsed.error.issues)}`);
    const params = parsed.data as Record<string, any>;
    const tenantId = String(params.tenantId ?? "");
    const objectId = String(params.objectId ?? "");
    if (!tenantId || !objectId) return this.refuse(input, mode, "G2", "Single-object contract: tenantId and objectId are required.");

    // G3: scope fence — the object must provably belong to the requesting tenant.
    const inScope = await this.scopeCheck({ tenantId, objectType: op.kind, objectId, requestedBy: input.requestedBy, requestedRole: input.requestedRole, params });
    if (!inScope) {
      return this.refuse(input, mode, "G3", `Scope fence: ${op.kind} '${objectId}' not verified as belonging to tenant '${tenantId}' for ${input.requestedBy} (fail-closed).`);
    }

    // G4: global live-write budget (live only). ADVISORY early-fail only — the
    // AUTHORITATIVE, concurrency-safe reservation happens atomically just before
    // dispatch (see reserveLiveSlot). This early check just avoids doing snapshot
    // work for an op that is already obviously over budget.
    if (mode === "live" && this.liveBudgetFull(this.now())) {
      const cap = Number(this.env.AGENT_PBX_LIVE_WRITES_PER_HOUR ?? 10);
      return this.refuse(input, mode, "G4", `Global live-write budget reached (${cap}/hour). Queued work waits for the next window.`);
    }

    // G5: protected extensions.
    const protectedExts = (this.env.AGENT_PBX_PROTECTED_EXTS ?? "101").split(",").map((s) => s.trim()).filter(Boolean);
    const ext = String(params.extension ?? (op.kind.startsWith("extension") ? objectId : ""));
    if (ext && protectedExts.includes(ext)) {
      return this.refuse(input, mode, "G5", `Target extension '${ext}' is protected — refused.`);
    }

    // G6: live tenant allow-list, fail-closed. "*" opens every linked tenant
    // (owner mandate 2026-07-26: DND live for all tenants) — the G3 scope
    // fence still proves per-tenant object ownership on every call, so a
    // wildcard never allows cross-tenant writes. Empty/unset stays fail-closed.
    if (mode === "live") {
      const allow = (this.env.AGENT_PBX_LIVE_TENANTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!allow.includes("*") && !allow.includes(tenantId)) {
        return this.refuse(input, mode, "G6", `Live write to tenant '${tenantId}' refused: not in AGENT_PBX_LIVE_TENANTS allow-list (fail-closed).`);
      }
    }

    // G7: feasibility — the type system already excludes "db"; re-assert at runtime.
    if (!["astdb", "api", "helper"].includes(op.feasibility)) {
      return this.refuse(input, mode, "G7", `Feasibility '${op.feasibility}' is not live-proven — refused.`);
    }

    // G8: approval binding (live). The ActionService consumed the single-use
    // approval (CAS → EXECUTING + approvalConsumedAt); we re-verify everything.
    if (mode === "live") {
      if (!input.actionId) return this.refuse(input, mode, "G8", "Live modify requires an approved action (no actionId).");
      const action = await this.prisma.agentAction.findUnique({ where: { id: input.actionId } });
      if (!action) return this.refuse(input, mode, "G8", "Approval action row not found.");
      if (action.status !== "EXECUTING" || !action.approvalConsumedAt) {
        return this.refuse(input, mode, "G8", `Approval not consumed (status=${action?.status}) — single-use contract.`);
      }
      const expected = computeParamsHash(input.capabilityId, tenantId, input.params);
      if (action.paramsHash !== expected || action.capabilityId !== input.capabilityId || String(action.tenantId) !== tenantId) {
        return this.refuse(input, mode, "G8", "Params-hash mismatch: this is not the exact change that was approved.");
      }
    }

    // G9: snapshot before write — no snapshot, no write. Snapshots use a
    // read-capable client; in simulate mode that client never contacts the PBX.
    const client = this.makeClient({ simulate: mode === "simulate" });
    const opCtx = { simulate: mode === "simulate", actionId: input.actionId };
    let snap: { state: unknown } | null;
    try {
      snap = await op.snapshot(client, params, opCtx);
    } catch (err) {
      return this.refuse(input, mode, "G9", `Snapshot capture failed: ${String(err)} — refusing to write without a before-state.`);
    }
    if (!snap) return this.refuse(input, mode, "G9", "Snapshot returned no state — refusing to write without a before-state.");
    const stored = await this.snapshots.capture({
      actionId: input.actionId ?? `adhoc_${this.now()}_${Math.random().toString(36).slice(2, 8)}`,
      capabilityId: input.capabilityId,
      tenantId,
      objectType: op.kind,
      objectId,
      state: snap.state,
      source: op.feasibility,
      simulated: mode === "simulate",
    });

    await this.audit.record({
      actor: input.requestedRole,
      event: "pbx.modify.dispatch",
      capabilityId: input.capabilityId,
      tenantId,
      actionId: input.actionId,
      payload: { opId: op.id, kind: op.kind, objectId, mode, requestedBy: input.requestedBy, snapshotId: stored.id },
    });

    // G10: dispatch. Reserve the live-write budget slot ATOMICALLY here — a
    // synchronous check-and-increment with NO await between them, so concurrent
    // ops that all passed the advisory G4 gate cannot collectively exceed the
    // cap: exactly `cap` of them win the reservation, the rest refuse. (The
    // reservation counts the ATTEMPT that reaches the write; auto-revert does
    // not go through execute(), so it never consumes budget.)
    if (mode === "live" && !this.reserveLiveSlot(this.now())) {
      const cap = Number(this.env.AGENT_PBX_LIVE_WRITES_PER_HOUR ?? 10);
      return this.refuse(input, mode, "G4", `Global live-write budget reached (${cap}/hour) at dispatch reservation. Queued work waits for the next window.`);
    }
    let written: unknown;
    try {
      written = await op.dispatch(client, params, opCtx);
    } catch (err) {
      await this.audit.record({ actor: "system", event: "pbx.modify.error", capabilityId: input.capabilityId, tenantId, actionId: input.actionId, payload: { error: String(err), phase: "dispatch" } });
      return { ok: false, capabilityId: input.capabilityId, mode, gate: "G10", refusedReason: `Dispatch failed: ${String(err)}. No retry — outcome recorded for review.`, snapshotId: stored.id };
    }

    // G11: verify after write; mismatch ⇒ automatic revert from the snapshot.
    let verified = false;
    try {
      const v = await op.verify(client, params, written, opCtx);
      verified = v.ok;
      if (!v.ok) {
        let autoReverted = false;
        try {
          await op.revert(client, params, snap.state, opCtx);
          await this.snapshots.markRestored(stored.id);
          autoReverted = true;
        } catch (err) {
          await this.audit.record({ actor: "system", event: "pbx.modify.revert_failed", capabilityId: input.capabilityId, tenantId, actionId: input.actionId, payload: { error: String(err) } });
        }
        await this.audit.record({
          actor: "system",
          event: "pbx.modify.verify_mismatch",
          capabilityId: input.capabilityId,
          tenantId,
          actionId: input.actionId,
          payload: { detail: v.detail, observed: v.observed, autoReverted },
        });
        return { ok: false, capabilityId: input.capabilityId, mode, gate: "G11", refusedReason: `Verify mismatch: ${v.detail ?? "post-write state differs from intent"}${autoReverted ? " — automatically reverted from snapshot." : " — AUTOMATIC REVERT FAILED, owner alerted."}`, snapshotId: stored.id, written, verified: false, autoReverted };
      }
    } catch (err) {
      await this.audit.record({ actor: "system", event: "pbx.modify.error", capabilityId: input.capabilityId, tenantId, actionId: input.actionId, payload: { error: String(err), phase: "verify" } });
      return { ok: false, capabilityId: input.capabilityId, mode, gate: "G11", refusedReason: `Verify step failed: ${String(err)} — outcome UNKNOWN, owner review required.`, snapshotId: stored.id, written };
    }

    // Budget already reserved atomically at dispatch — do NOT double-count here.

    await this.audit.record({
      actor: input.requestedRole,
      event: "pbx.modify.done",
      capabilityId: input.capabilityId,
      tenantId,
      actionId: input.actionId,
      payload: { opId: op.id, mode, objectId, snapshotId: stored.id, verified },
    });
    return { ok: true, capabilityId: input.capabilityId, mode, snapshotId: stored.id, written, verified };
  }

  /**
   * One-click revert (spec §3.5). Restores the action's snapshot IF: within the
   * revert window, snapshot integrity verified, and the object has not been
   * edited by someone else since our write (three-way-diff rule — refuse+alert
   * rather than blindly overwrite).
   */
  async revert(actionId: string, requestedBy: string): Promise<ModifyRevertResult> {
    const action = await this.prisma.agentAction.findUnique({ where: { id: actionId } });
    if (!action) return { ok: false, refusedReason: "action_not_found" };
    const op = this.catalog[action.capabilityId];
    if (!op) return { ok: false, refusedReason: `Capability '${action.capabilityId}' not in catalog.` };
    const snapRow = await this.snapshots.getForAction(actionId);
    if (!snapRow) return { ok: false, refusedReason: "No snapshot stored for this action." };
    if (new Date(snapRow.expiresAt).getTime() < this.now()) {
      return { ok: false, refusedReason: "Revert window expired — restore must be done manually from the archived snapshot." };
    }
    if (!this.snapshots.integrityOk(snapRow)) {
      await this.audit.record({ actor: "system", event: "pbx.modify.snapshot_corrupt", actionId, payload: { snapshotId: snapRow.id } });
      return { ok: false, refusedReason: "Snapshot integrity check FAILED — refusing to restore from a corrupted snapshot." };
    }

    const mode: ModifyMode = snapRow.simulated ? "simulate" : "live";
    const client = this.makeClient({ simulate: mode === "simulate" });
    const params = action.params as Record<string, any>;

    // Three-way diff: current state must still equal what OUR write left behind.
    const written = (action.resultSnapshot as any)?.written;
    const revertCtx = { simulate: mode === "simulate", actionId };
    const current = await op.verify(client, params, written, revertCtx);
    if (!current.ok) {
      await this.audit.record({ actor: "system", event: "pbx.modify.revert_refused_drift", actionId, payload: { detail: current.detail } });
      return { ok: false, refusedReason: "Object was changed by someone else after our write (GUI edit?) — refusing to overwrite their change. Owner review required." };
    }

    try {
      const restored = await op.revert(client, params, snapRow.stateJson, revertCtx);
      await this.snapshots.markRestored(snapRow.id);
      await this.audit.record({ actor: "owner", event: "pbx.modify.reverted", actionId, tenantId: action.tenantId, capabilityId: action.capabilityId, payload: { requestedBy, snapshotId: snapRow.id, mode } });
      return { ok: true, restored };
    } catch (err) {
      await this.audit.record({ actor: "system", event: "pbx.modify.revert_failed", actionId, payload: { error: String(err) } });
      return { ok: false, refusedReason: `Revert dispatch failed: ${String(err)}` };
    }
  }

  private async refuse(input: ModifyExecInput, mode: ModifyMode, gate: string, reason: string): Promise<ModifyExecResult> {
    await this.audit.record({
      actor: "system",
      event: "pbx.modify.refused",
      capabilityId: input.capabilityId,
      payload: { gate, reason, mode, requestedBy: input.requestedBy },
    });
    return { ok: false, capabilityId: input.capabilityId, mode, gate, refusedReason: reason };
  }
}
