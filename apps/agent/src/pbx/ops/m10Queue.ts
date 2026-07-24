/**
 * M10 — Queue configuration edit (docs/ai-support-agent/specs/M10_QUEUE_CONFIG_SPEC.md).
 *
 * Edits a queue's config (strategy, timeouts, etc.) via the OFFICIAL VitalPBX
 * queue API — the one object VitalPBX exposes full CRUD for, so VitalPBX owns
 * its own regen and the agent NEVER runs gen-conf. The api door enforces the
 * field allow-list + queue ownership; this op adds snapshot/verify/revert.
 *
 * Simulate mode: NO HTTP (returns deterministic sim results; snapshot uses the
 * injected api's list only in live mode). To keep simulate zero-contact, the
 * snapshot in sim returns an empty prior — the executor still exercises the full
 * gate chain; live snapshot reads the real queue.
 */
import { z } from "zod";
import type { ModifyOp, ModifyOpCtx, ModifyClientLike, ModifyCatalogDeps } from "../modifyCatalog";

const nonEmpty = z.string().min(1);
const STRATEGIES = ["ringall", "leastrecent", "fewestcalls", "random", "rrmemory", "linear", "wrandom", "rrordered"] as const;

export const M10_SCHEMA = z
  .object({
    tenantId: nonEmpty,
    /** objectId is the queue id. */
    objectId: nonEmpty,
    patch: z.object({
      strategy: z.enum(STRATEGIES).optional(),
      timeout: z.number().int().min(0).max(600).optional(),
      wrapuptime: z.number().int().min(0).max(600).optional(),
      retry: z.number().int().min(0).max(60).optional(),
      maxlen: z.number().int().min(0).max(1000).optional(),
      servicelevel: z.number().int().min(0).max(3600).optional(),
      ringinuse: z.enum(["yes", "no"]).optional(),
      skip_busy: z.enum(["yes", "no"]).optional(),
      answered_elsewhere: z.enum(["yes", "no"]).optional(),
    }).strict().refine((v) => Object.keys(v).length > 0, { message: "patch must change at least one field" }),
  });

export interface M10Snapshot {
  /** The queue's allow-listed fields BEFORE the change (only the keys in patch). */
  before: Record<string, unknown>;
}

export function makeM10Op(deps: ModifyCatalogDeps & { queueApi: { call(body: Record<string, unknown>): Promise<any> } }): ModifyOp {
  const queueApi = deps.queueApi;

  async function readQueueFields(tenantId: string, queueId: string): Promise<Record<string, unknown> | null> {
    const resp = await queueApi.call({ tenantId: String(tenantId), action: "list", agentActionId: "read" });
    const q = (resp.queues || []).find((x: any) => String(x.id) === String(queueId));
    return q ? (q.fields ?? {}) : null;
  }

  return {
    id: "M10",
    capabilityId: "pbx.M10",
    kind: "queue",
    title: "Edit a queue's configuration (official VitalPBX API)",
    schema: M10_SCHEMA,
    feasibility: "api",
    risk: "medium",

    async snapshot(_client: ModifyClientLike, params: Record<string, any>, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { state: { before: {} } as M10Snapshot };
      const fields = await readQueueFields(params.tenantId, params.objectId);
      if (fields === null) throw new Error(`queue '${params.objectId}' not found for tenant — refusing (ownership fence)`);
      // Capture only the keys we're about to change, so revert restores exactly those.
      const before: Record<string, unknown> = {};
      for (const k of Object.keys(params.patch)) before[k] = (fields as any)[k];
      return { state: { before } as M10Snapshot };
    },

    async dispatch(_client: ModifyClientLike, params: Record<string, any>, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { simulated: true, queueId: params.objectId, patch: params.patch };
      const resp = await queueApi.call({ tenantId: String(params.tenantId), action: "update", queueId: String(params.objectId), patch: params.patch, agentActionId: ctx.actionId ?? "unknown" });
      return { queueId: params.objectId, patch: params.patch, fields: resp.queue?.fields ?? null };
    },

    async verify(_client: ModifyClientLike, params: Record<string, any>, _written: any, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { ok: true, observed: { simulated: true } };
      const fields = await readQueueFields(params.tenantId, params.objectId);
      if (!fields) return { ok: false, detail: "queue vanished during execution" };
      for (const [k, v] of Object.entries(params.patch)) {
        if (String((fields as any)[k]) !== String(v)) return { ok: false, observed: fields, detail: `field '${k}' did not take (${(fields as any)[k]} != ${v})` };
      }
      return { ok: true, observed: { queueId: params.objectId } };
    },

    async revert(_client: ModifyClientLike, params: Record<string, any>, snapshotState: any, ctx: ModifyOpCtx) {
      const before = (snapshotState as M10Snapshot)?.before ?? {};
      if (ctx.simulate) return { restored: before };
      // Restore only the fields we changed. Skip keys that were undefined before
      // (no prior value to restore to — leave as-is rather than guess a default).
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(before)) if (v !== undefined && v !== null) patch[k] = v;
      if (Object.keys(patch).length === 0) return { restored: "nothing to restore" };
      return queueApi.call({ tenantId: String(params.tenantId), action: "update", queueId: String(params.objectId), patch, agentActionId: ctx.actionId ?? "revert" });
    },
  };
}
