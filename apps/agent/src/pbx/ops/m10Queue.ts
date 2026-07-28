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
    /** objectId is the queue id (native ops may pass the dialable queue extension). */
    objectId: nonEmpty,
    /** Omitted action = legacy field patch (official VitalPBX API).
     *  Native ops (2026-07-28) go via the PBX helper: DB write + real regen. */
    action: z.enum(["patch", "member_add", "member_remove", "set_moh", "set_announcement"]).optional(),
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
    }).strict().refine((v) => Object.keys(v).length > 0, { message: "patch must change at least one field" }).optional(),
    /** member_add / member_remove: the member extension number. */
    extension: z.string().regex(/^\d{1,10}$/).optional(),
    penalty: z.number().int().min(0).max(99).optional(),
    /** set_moh: "default", "mohN" or a Connect class "connect_*". */
    mohClass: z.string().min(1).max(80).optional(),
    /** set_announcement: which announcement slot + native recording id (null clears). */
    slot: z.enum(["announcement", "periodic", "join"]).optional(),
    recordingId: z.string().min(1).nullable().optional(),
    /** Human label for replies/audit only. */
    queueLabel: z.string().max(120).optional(),
  })
  .refine((v) => (v.action ?? "patch") !== "patch" || !!v.patch, { message: "patch required for patch action" })
  .refine((v) => !["member_add", "member_remove"].includes(v.action ?? "") || !!v.extension, { message: "extension required for member ops" })
  .refine((v) => v.action !== "set_moh" || !!v.mohClass, { message: "mohClass required for set_moh" })
  .refine((v) => v.action !== "set_announcement" || !!v.slot, { message: "slot required for set_announcement" });

export interface M10Snapshot {
  /** The queue's allow-listed fields BEFORE the change (only the keys in patch). */
  before: Record<string, unknown>;
}

/** Snapshot for native queue ops (member/moh/announcement) from the PBX catalog. */
export interface M10NativeSnapshot {
  native: true;
  queueId: number;
  queueExtension: string;
  wasMember?: boolean;
  beforeMusicGroupId?: number | null;
  beforeMohClass?: string | null;
  beforeRecordingId?: number | null;
}

export function makeM10Op(deps: ModifyCatalogDeps & { queueApi: { call(body: Record<string, unknown>): Promise<any> } }): ModifyOp {
  const queueApi = deps.queueApi;

  async function readQueueFields(tenantId: string, queueId: string): Promise<Record<string, unknown> | null> {
    const resp = await queueApi.call({ tenantId: String(tenantId), action: "list", agentActionId: "read" });
    const q = (resp.queues || []).find((x: any) => String(x.id) === String(queueId));
    return q ? (q.fields ?? {}) : null;
  }

  /** Native catalog read: find the queue by PK or dialable extension. */
  async function readNativeQueue(tenantId: string, ref: string): Promise<any | null> {
    const resp = await queueApi.call({ tenantId: String(tenantId), action: "native_list", agentActionId: "read" });
    return (resp.catalog?.queues ?? []).find((q: any) => String(q.id) === String(ref) || String(q.extension) === String(ref)) ?? null;
  }

  function isNative(params: Record<string, any>): boolean {
    return ["member_add", "member_remove", "set_moh", "set_announcement"].includes(String(params.action ?? ""));
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
      if (isNative(params)) {
        if (ctx.simulate) return { state: { native: true, queueId: 0, queueExtension: String(params.objectId) } as M10NativeSnapshot };
        const q = await readNativeQueue(params.tenantId, params.objectId);
        if (!q) throw new Error(`queue '${params.objectId}' not found for tenant — refusing (ownership fence)`);
        const state: M10NativeSnapshot = { native: true, queueId: Number(q.id), queueExtension: String(q.extension) };
        if (params.action === "member_add" || params.action === "member_remove") {
          state.wasMember = (q.members ?? []).some((m: any) => String(m.extension) === String(params.extension));
        } else if (params.action === "set_moh") {
          state.beforeMusicGroupId = q.musicGroupId ?? null;
        } else if (params.action === "set_announcement") {
          const slotKey = params.slot === "periodic" ? "periodicAnnouncementId" : params.slot === "join" ? "joinAnnouncementId" : "announcementId";
          state.beforeRecordingId = q[slotKey] ?? null;
        }
        return { state };
      }
      if (ctx.simulate) return { state: { before: {} } as M10Snapshot };
      const fields = await readQueueFields(params.tenantId, params.objectId);
      if (fields === null) throw new Error(`queue '${params.objectId}' not found for tenant — refusing (ownership fence)`);
      // Capture only the keys we're about to change, so revert restores exactly those.
      const before: Record<string, unknown> = {};
      for (const k of Object.keys(params.patch)) before[k] = (fields as any)[k];
      return { state: { before } as M10Snapshot };
    },

    async dispatch(_client: ModifyClientLike, params: Record<string, any>, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { simulated: true, queueId: params.objectId, action: params.action ?? "patch", patch: params.patch ?? null };
      if (isNative(params)) {
        const action = params.action === "member_add" ? "members_add" : params.action === "member_remove" ? "members_remove" : params.action;
        const resp = await queueApi.call({
          tenantId: String(params.tenantId),
          action,
          // objectId may be the PK or the dialable extension; the door forwards
          // whichever to the helper (queueId if numeric PK match, else extension).
          ...(String(params.objectId).length <= 10 ? { queueExtension: String(params.objectId) } : { queueId: String(params.objectId) }),
          ...(params.extension ? { extension: String(params.extension) } : {}),
          ...(params.penalty != null ? { penalty: params.penalty } : {}),
          ...(params.mohClass ? { mohClass: String(params.mohClass) } : {}),
          ...(params.slot ? { slot: String(params.slot) } : {}),
          ...(params.recordingId !== undefined ? { recordingId: params.recordingId } : {}),
          agentActionId: ctx.actionId ?? "unknown",
        });
        return { queueId: params.objectId, action: params.action, result: resp.result ?? null };
      }
      const resp = await queueApi.call({ tenantId: String(params.tenantId), action: "update", queueId: String(params.objectId), patch: params.patch, agentActionId: ctx.actionId ?? "unknown" });
      return { queueId: params.objectId, patch: params.patch, fields: resp.queue?.fields ?? null };
    },

    async verify(_client: ModifyClientLike, params: Record<string, any>, _written: any, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { ok: true, observed: { simulated: true } };
      if (isNative(params)) {
        const q = await readNativeQueue(params.tenantId, params.objectId);
        if (!q) return { ok: false, detail: "queue vanished during execution" };
        if (params.action === "member_add" || params.action === "member_remove") {
          const isMember = (q.members ?? []).some((m: any) => String(m.extension) === String(params.extension));
          if (params.action === "member_add" && !isMember) return { ok: false, observed: { members: q.members }, detail: "extension did not appear in queue members" };
          if (params.action === "member_remove" && isMember) return { ok: false, observed: { members: q.members }, detail: "extension still in queue members" };
          return { ok: true, observed: { members: (q.members ?? []).map((m: any) => m.extension) } };
        }
        if (params.action === "set_moh") {
          // Native class ⇒ musicGroupId reflects it; connect_* class lives in
          // the patched conf + AstDB (the dispatch result carries evidence).
          const m = String(params.mohClass).match(/^(?:moh(\d+)|(\d+))$/);
          if (m) {
            const expected = Number(m[1] ?? m[2]);
            if (Number(q.musicGroupId) !== expected) return { ok: false, observed: { musicGroupId: q.musicGroupId }, detail: "queue music group did not take" };
          } else if (String(params.mohClass) !== "default" && !(_written?.result?.patched >= 0)) {
            return { ok: false, observed: _written?.result ?? null, detail: "connect MOH class patch evidence missing" };
          }
          return { ok: true, observed: { musicGroupId: q.musicGroupId, mohClass: params.mohClass } };
        }
        // set_announcement
        const slotKey = params.slot === "periodic" ? "periodicAnnouncementId" : params.slot === "join" ? "joinAnnouncementId" : "announcementId";
        const now = q[slotKey] ?? null;
        const expected = params.recordingId == null ? null : Number(params.recordingId);
        if ((now ?? null) !== (expected ?? null) && String(now) !== String(expected)) {
          return { ok: false, observed: { [slotKey]: now }, detail: "queue announcement did not take" };
        }
        return { ok: true, observed: { [slotKey]: now } };
      }
      const fields = await readQueueFields(params.tenantId, params.objectId);
      if (!fields) return { ok: false, detail: "queue vanished during execution" };
      for (const [k, v] of Object.entries(params.patch)) {
        if (String((fields as any)[k]) !== String(v)) return { ok: false, observed: fields, detail: `field '${k}' did not take (${(fields as any)[k]} != ${v})` };
      }
      return { ok: true, observed: { queueId: params.objectId } };
    },

    async revert(_client: ModifyClientLike, params: Record<string, any>, snapshotState: any, ctx: ModifyOpCtx) {
      if (isNative(params)) {
        const snap = snapshotState as M10NativeSnapshot;
        if (ctx.simulate) return { restored: snap ?? {} };
        const ref = snap?.queueExtension ?? String(params.objectId);
        if (params.action === "member_add" || params.action === "member_remove") {
          // Inverse membership op, but only when the prior state differed.
          const inverse = params.action === "member_add" ? "members_remove" : "members_add";
          const shouldRestore = params.action === "member_add" ? snap?.wasMember === false : snap?.wasMember === true;
          if (!shouldRestore) return { restored: "membership already matched prior state" };
          return queueApi.call({ tenantId: String(params.tenantId), action: inverse, queueExtension: ref, extension: String(params.extension), agentActionId: ctx.actionId ?? "revert" });
        }
        if (params.action === "set_moh") {
          if (snap?.beforeMusicGroupId == null) throw new Error("no prior music group captured — revert not possible");
          return queueApi.call({ tenantId: String(params.tenantId), action: "set_moh", queueExtension: ref, mohClass: String(snap.beforeMusicGroupId), agentActionId: ctx.actionId ?? "revert" });
        }
        // set_announcement: restore prior recording id (null clears).
        return queueApi.call({ tenantId: String(params.tenantId), action: "set_announcement", queueExtension: ref, slot: String(params.slot), recordingId: snap?.beforeRecordingId != null ? String(snap.beforeRecordingId) : null, agentActionId: ctx.actionId ?? "revert" });
      }
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
