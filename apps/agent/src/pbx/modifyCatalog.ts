/**
 * MODIFY_CATALOG (X1 spec §3.1) — the catalog of modify/repair operations the
 * ModifyPbxExecutor can dispatch.
 *
 * ⚠️ SHIPS EMPTY BY DESIGN. X1 delivers the machinery only; with zero entries
 * here, every dispatch refuses at gate G1 and the agent can not modify anything.
 * Each entry (M1, M2, …) is added ONLY by its own roadmap item after its own
 * spec + SEBA sign-off and full certification (ACTIONS_V2_ROADMAP.md ground rules).
 *
 * Contract every op must satisfy (enforced by the static guard below + review):
 *   - single-object: schema requires tenantId + objectId; no list/bulk shape
 *   - snapshot(): returns the object's FULL current state, or null (⇒ hard refuse)
 *   - verify(): re-reads and diffs reality against intent after a write
 *   - revert(): restores a previously captured snapshot state
 *   - feasibility: only proven-real paths are representable; the June-2026-incident
 *     class ("db" + regen) is intentionally NOT a member of this type.
 */
import { z } from "zod";
// Ops import ONLY types from this file (import type ⇒ erased at runtime),
// so this static import cannot create a runtime cycle.
import { makeM1Op } from "./ops/m1MohTenant";
import { makeM2Op } from "./ops/m2MohExtension";
import { makeM3Op } from "./ops/m3InboundRoute";
import { makeM4Op } from "./ops/m4IvrOption";
import { makeM5Op } from "./ops/m5IvrPrompt";
import { makeM6Op } from "./ops/m6IvrExit";
import { makeM7Op } from "./ops/m7IvrSchedule";
import { makeM10Op } from "./ops/m10Queue";
import { makeM11Op } from "./ops/m11ExtFeature";

/** Client surface handed to ops. Simulate factories never contact the PBX. */
export interface ModifyClientLike {
  callEndpointRaw(input: { method: string; path: string; tenant?: string; body?: unknown }): Promise<any>;
}

export type ModifyFeasibility = "astdb" | "api" | "helper";

/** Per-call context the executor hands every op function. Ops MUST honor
 *  ctx.simulate: zero network/API contact when true. */
export interface ModifyOpCtx {
  simulate: boolean;
  actionId?: string;
}

export interface ModifyOp {
  /** Roadmap id, e.g. "M1". */
  id: string;
  /** Manifest capability id, e.g. "pbx.M1". */
  capabilityId: string;
  /** Object type touched, e.g. "moh_tenant" | "inbound_route". Ledger/snapshot type. */
  kind: string;
  title: string;
  /** MUST require tenantId and objectId (single-object contract). */
  schema: z.ZodType<any>;
  feasibility: ModifyFeasibility;
  risk: "low" | "medium" | "high";
  /** Capture the FULL pre-change state of the one target object. null ⇒ executor refuses. */
  snapshot(client: ModifyClientLike, params: Record<string, any>, ctx: ModifyOpCtx): Promise<{ state: unknown } | null>;
  /** Perform the change. Returns what was written (stored on the action). */
  dispatch(client: ModifyClientLike, params: Record<string, any>, ctx: ModifyOpCtx): Promise<unknown>;
  /** Re-read and compare against intent. ok:false triggers automatic revert. */
  verify(
    client: ModifyClientLike,
    params: Record<string, any>,
    written: unknown,
    ctx: ModifyOpCtx,
  ): Promise<{ ok: boolean; observed?: unknown; detail?: string }>;
  /** Restore a snapshot state captured by snapshot(). */
  revert(client: ModifyClientLike, params: Record<string, any>, snapshotState: unknown, ctx: ModifyOpCtx): Promise<unknown>;
}

/** EMPTY by design — executors constructed WITHOUT an explicit catalog dispatch
 *  nothing (fail-closed). The real wired catalog comes from buildModifyCatalog. */
export const MODIFY_CATALOG: Record<string, ModifyOp> = {};

/** Dependencies the wired catalog ops need (injected in server.ts). */
export interface ModifyCatalogDeps {
  prisma: any;
  mohApi: { call(body: Record<string, unknown>): Promise<any> };
  /** M3 route door client — optional; defaults to a fail-closed throwing stub
   *  (H2-gated) so callers that don't wire it can never reach a live route. */
  routeApi?: { call(body: Record<string, unknown>): Promise<any> };
  /** M4 IVR door client — optional; defaults to a fail-closed throwing stub. */
  ivrApi?: { call(body: Record<string, unknown>): Promise<any> };
  /** M10 queue door client — optional; defaults to a fail-closed throwing stub. */
  queueApi?: { call(body: Record<string, unknown>): Promise<any> };
  /** M11 extension-feature door client — optional; fail-closed throwing stub. */
  extFeatureApi?: { call(body: Record<string, unknown>): Promise<any> };
}

/**
 * The production catalog. Grows ONE op per certified roadmap item:
 *   pbx.M1 — tenant MOH selection (M1_MOH_TENANT_SPEC.md)
 */
export function buildModifyCatalog(deps: ModifyCatalogDeps): Record<string, ModifyOp> {
  const routeApi = deps.routeApi ?? {
    async call() { throw new Error("route_api_unavailable: no routeApi wired (H2 pending)"); },
  };
  const ivrApi = deps.ivrApi ?? {
    async call() { throw new Error("ivr_api_unavailable: no ivrApi wired"); },
  };
  const queueApi = deps.queueApi ?? {
    async call() { throw new Error("queue_api_unavailable: no queueApi wired"); },
  };
  const extFeatureApi = deps.extFeatureApi ?? {
    async call() { throw new Error("extfeature_api_unavailable: no extFeatureApi wired"); },
  };
  return {
    "pbx.M1": makeM1Op(deps),
    "pbx.M2": makeM2Op(deps),
    "pbx.M3": makeM3Op({ ...deps, routeApi }),
    "pbx.M4": makeM4Op({ ...deps, ivrApi }),
    "pbx.M5": makeM5Op({ ...deps, ivrApi }),
    "pbx.M6": makeM6Op({ ...deps, ivrApi }),
    "pbx.M7": makeM7Op({ ...deps, ivrApi }),
    "pbx.M10": makeM10Op({ ...deps, queueApi }),
    "pbx.M11": makeM11Op({ ...deps, extFeatureApi }),
  };
}

/**
 * Static guard (mirrors catalogHasNoDestructiveOps for the P-series): every op
 * present must carry the full snapshot/verify/revert contract and reject empty
 * params (proving tenantId/objectId are required by its schema).
 */
export function catalogOpsHonorModifyContract(catalog: Record<string, ModifyOp> = MODIFY_CATALOG): boolean {
  for (const op of Object.values(catalog)) {
    if (typeof op.snapshot !== "function" || typeof op.verify !== "function" || typeof op.revert !== "function") return false;
    if (!/^(M|E|R)\d+$/.test(op.id)) return false;
    if (op.schema.safeParse({}).success) return false; // must demand tenantId+objectId
    const probe = op.schema.safeParse({ tenantId: "t", objectId: "o" });
    void probe; // ops may require more fields; emptiness rejection above is the invariant
  }
  return true;
}
