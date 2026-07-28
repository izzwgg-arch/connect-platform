/**
 * M3 — Inbound route destination change
 * (docs/ai-support-agent/specs/M3_INBOUND_ROUTE_DEST_SPEC.md).
 *
 * Point an existing DID at a DIFFERENT destination the tenant already has set
 * up (any PBX destination type), or restore the previous destination. Uses the
 * existing route helper's inspect/retarget/restore + durable snapshot.
 *
 * SAFETY (rock-solid mandate):
 *  - The DID must belong to the requester's tenant (G3 `inbound_route` mapping).
 *  - The TARGET destination must be tenant-VERIFIED — proven to belong to the
 *    same tenant by H2's per-module resolver. The agent only ever offers /
 *    accepts destinations H2 positively verified; unknown ⇒ refused.
 *  - Connect-routing-mode DIDs are HARD-REFUSED (protect Connect MOH/routing).
 *  - Live path is UNAVAILABLE until H2 is installed (routeApi stub throws).
 *
 * Simulate mode: ZERO api/helper contact; synthetic state so the full gate
 * chain + revert certify offline.
 */
import { z } from "zod";
import type { ModifyOp, ModifyOpCtx, ModifyClientLike, ModifyCatalogDeps } from "../modifyCatalog";

const nonEmpty = z.string().min(1);

/** Native target types the v2 retarget accepts (helper verifies tenant ownership). */
export const M3_TARGET_TYPES = ["extension", "queue", "ring_group", "ivr", "time_condition", "custom_application"] as const;

export const M3_SCHEMA = z
  .object({
    tenantId: nonEmpty,
    /** Single-object contract: the DID (E.164 or digits) IS the object. */
    objectId: nonEmpty,
    action: z.enum(["retarget", "retarget_v2", "restore"]),
    /** Required for legacy retarget: a destination id H2 verified belongs to the tenant. */
    destinationId: nonEmpty.optional(),
    /** v2 retarget (2026-07-28): route to ANY tenant-owned object by type + id.
     *  Ownership verified on the PBX; destination row find-or-created like the GUI. */
    targetType: z.enum(M3_TARGET_TYPES).optional(),
    targetId: nonEmpty.optional(),
    /** Human label for the target (reply/audit text only, not trusted for routing). */
    targetLabel: z.string().max(120).optional(),
    reason: z.string().max(500).optional(),
  })
  .refine((v) => v.action !== "retarget" || !!v.destinationId, { message: "destinationId required for retarget" })
  .refine((v) => v.action !== "retarget_v2" || (!!v.targetType && !!v.targetId), { message: "targetType + targetId required for retarget_v2" });

export interface M3Snapshot {
  did: string;
  /** Route state at capture: current destination + Connect-vs-PBX mode + full original row. */
  routeId: number | null;
  currentDestinationId: string | null;
  mode: "connect" | "pbx" | "unknown";
  originalRow: unknown;
}

export function makeM3Op(deps: ModifyCatalogDeps & { routeApi: { call(body: Record<string, unknown>): Promise<any> } }): ModifyOp {
  const routeApi = deps.routeApi;
  return {
    id: "M3",
    capabilityId: "pbx.M3",
    kind: "inbound_route",
    title: "Change where a phone number (DID) routes — to any destination the tenant has set up",
    schema: M3_SCHEMA,
    feasibility: "helper",
    risk: "medium",

    async snapshot(_client: ModifyClientLike, params: Record<string, any>, ctx: ModifyOpCtx) {
      const did = String(params.objectId);
      if (ctx.simulate) {
        // No live route state offline — synthetic, non-null so the chain proceeds.
        const state: M3Snapshot = { did, routeId: null, currentDestinationId: "sim_current", mode: "pbx", originalRow: { simulated: true } };
        return { state };
      }
      const resp = await routeApi.call({ action: "route_inspect", tenantId: String(params.tenantId), did, agentActionId: ctx.actionId ?? "inspect" });
      const r = resp.route ?? {};
      const state: M3Snapshot = {
        did,
        routeId: r.inbound_route_id ?? null,
        currentDestinationId: r.destination_id != null ? String(r.destination_id) : null,
        mode: resp.mode === "connect" ? "connect" : resp.mode === "pbx" ? "pbx" : "unknown",
        originalRow: r,
      };
      // HARD-REFUSE connect-mode DIDs (protect Connect routing/MOH). Snapshot
      // returning null makes the executor refuse at G9 before any write.
      if (state.mode === "connect") return null;
      return { state };
    },

    async dispatch(_client: ModifyClientLike, params: Record<string, any>, ctx: ModifyOpCtx) {
      if (ctx.simulate) {
        return { simulated: true, action: params.action, did: String(params.objectId), destinationId: params.destinationId ?? null };
      }
      if (params.action === "retarget_v2") {
        // v2: tenant-owned target by TYPE + ID. Helper verifies ownership,
        // find-or-creates the destination row, runs the REAL per-tenant regen.
        const resp = await routeApi.call({
          action: "route_retarget_v2",
          tenantId: String(params.tenantId),
          did: String(params.objectId),
          targetType: String(params.targetType),
          targetId: String(params.targetId),
          reason: params.reason ?? "agent M3 route change (v2)",
          agentActionId: ctx.actionId ?? "unknown",
        });
        const afterDest = resp.after?.destination_id != null ? String(resp.after.destination_id) : null;
        return { action: "retarget_v2", did: String(params.objectId), targetType: String(params.targetType), targetId: String(params.targetId), afterDestinationId: afterDest, target: resp.target ?? null, after: resp.after ?? null, apply: resp.apply ?? null };
      }
      if (params.action === "retarget") {
        // The api door (with H2) tenant-verifies destinationId BEFORE switching.
        const resp = await routeApi.call({
          action: "route_retarget",
          tenantId: String(params.tenantId),
          did: String(params.objectId),
          destinationId: String(params.destinationId),
          reason: params.reason ?? "agent M3 route change",
          agentActionId: ctx.actionId ?? "unknown",
        });
        return { action: "retarget", did: String(params.objectId), destinationId: String(params.destinationId), after: resp.after ?? null, apply: resp.apply ?? null };
      }
      const resp = await routeApi.call({ action: "route_restore", tenantId: String(params.tenantId), did: String(params.objectId), reason: params.reason ?? "agent M3 restore", agentActionId: ctx.actionId ?? "unknown" });
      return { action: "restore", did: String(params.objectId), after: resp.after ?? null, apply: resp.apply ?? null };
    },

    async verify(_client: ModifyClientLike, params: Record<string, any>, written: any, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { ok: true, observed: { simulated: true } };
      if (written?.apply && written.apply.ran && Number(written.apply.exitCode) !== 0) {
        return { ok: false, detail: `helper apply failed (exit ${written.apply.exitCode})` };
      }
      const resp = await routeApi.call({ action: "route_inspect", tenantId: String(params.tenantId), did: String(params.objectId), agentActionId: ctx.actionId ?? "verify" });
      const nowDest = resp.route?.destination_id != null ? String(resp.route.destination_id) : null;
      if (params.action === "retarget") {
        if (nowDest !== String(params.destinationId)) {
          return { ok: false, observed: { nowDest }, detail: "route destination did not change to the requested target" };
        }
      }
      if (params.action === "retarget_v2") {
        // The helper reports the destination row it ensured + wrote; the live
        // route must now carry exactly that id.
        const expected = written?.afterDestinationId != null ? String(written.afterDestinationId) : null;
        if (!expected || nowDest !== expected) {
          return { ok: false, observed: { nowDest, expected }, detail: "route destination did not change to the requested target (v2)" };
        }
      }
      return { ok: true, observed: { nowDest, mode: resp.mode } };
    },

    async revert(_client: ModifyClientLike, params: Record<string, any>, snapshotState: any, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { restored: (snapshotState as M3Snapshot)?.currentDestinationId ?? null };
      // Restore the previous destination via the helper's durable snapshot.
      return routeApi.call({ action: "route_restore", tenantId: String(params.tenantId), did: String(params.objectId), reason: "agent M3 revert", agentActionId: ctx.actionId ?? "revert" });
    },
  };
}
