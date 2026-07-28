/**
 * M4 — IVR menu digit destination change
 * (docs/ai-support-agent/specs/M4_IVR_ENTRY_DEST_SPEC.md).
 *
 * Changes which destination one digit of a tenant's IVR profile points at, via
 * Connect's own custom-context IVR (AstDB-published — live, no dialplan regen).
 * Same safety class as M1. The api door enforces the full hardening matrix
 * (per-type ref shape, custom allow-list, sub-menu loop guard, tenant ownership);
 * this op adds the X1 snapshot/verify/revert pipeline on top.
 *
 * Simulate mode: DB reads only via injected prisma; ZERO HTTP.
 */
import { z } from "zod";
import type { ModifyOp, ModifyOpCtx, ModifyClientLike, ModifyCatalogDeps } from "../modifyCatalog";

const nonEmpty = z.string().min(1);
const IVR_TYPES = ["extension", "queue", "ring_group", "voicemail", "ivr", "announcement", "external_number", "terminate", "custom"] as const;

/** Native VitalPBX IVR target types (2026-07-28; helper verifies tenant ownership). */
export const M4_NATIVE_TARGET_TYPES = ["extension", "queue", "ring_group", "ivr", "time_condition", "custom_application"] as const;

export const M4_SCHEMA = z
  .object({
    tenantId: nonEmpty,
    /** Connect-IVR contract: objectId is "<profileId>:<digit>".
     *  Native contract: "ivr:<ivrId>:<option>" or "ivr:<ivrId>:welcome". */
    objectId: nonEmpty,
    action: z.enum(["set", "clear", "native_set_entry", "native_clear_entry", "native_set_welcome"]),
    profileId: nonEmpty.optional(),
    optionDigit: z.enum(["0","1","2","3","4","5","6","7","8","9","star","hash"]).optional(),
    destinationType: z.enum(IVR_TYPES).optional(),
    destinationRef: z.string().min(1).max(200).optional(),
    label: z.string().max(60).nullable().optional(),
    // Native VitalPBX IVR (ombu_ivrs) fields:
    ivrId: nonEmpty.optional(),
    option: z.string().regex(/^(?:\d|\*|#)$/).optional(),
    targetType: z.enum(M4_NATIVE_TARGET_TYPES).optional(),
    targetId: nonEmpty.optional(),
    targetLabel: z.string().max(120).optional(),
    recordingId: nonEmpty.optional(),
  })
  .refine((v) => v.action.startsWith("native_") || (!!v.profileId && !!v.optionDigit), { message: "profileId + optionDigit required for Connect IVR actions" })
  .refine((v) => v.action.startsWith("native_") || v.objectId === `${v.profileId}:${v.optionDigit}`, { message: "objectId must be '<profileId>:<digit>'" })
  .refine((v) => v.action !== "set" || (!!v.destinationType && !!v.destinationRef), { message: "destinationType + destinationRef required for set" })
  .refine((v) => !v.action.startsWith("native_") || !!v.ivrId, { message: "ivrId required for native actions" })
  .refine((v) => !["native_set_entry", "native_clear_entry"].includes(v.action) || (!!v.option && v.objectId === `ivr:${v.ivrId}:${v.option}`), { message: "objectId must be 'ivr:<ivrId>:<option>'" })
  .refine((v) => v.action !== "native_set_entry" || (!!v.targetType && !!v.targetId), { message: "targetType + targetId required for native_set_entry" })
  .refine((v) => v.action !== "native_set_welcome" || (!!v.recordingId && v.objectId === `ivr:${v.ivrId}:welcome`), { message: "recordingId + objectId 'ivr:<ivrId>:welcome' required for native_set_welcome" });

export interface M4Snapshot {
  connectTenantId: string;
  profileId: string;
  optionDigit: string;
  /** Prior option for this digit, or null when the digit was unassigned. */
  option: { destinationType: string; destinationRef: string; label: string | null } | null;
}

/** Snapshot for native VitalPBX IVR actions (entry or welcome). */
export interface M4NativeSnapshot {
  native: true;
  ivrId: string;
  /** entry ops: prior target for the option (null = unassigned). */
  option?: string;
  before?: { type: string; targetId: string | null; label: string | null } | null;
  /** welcome op: prior welcome recording id (null = none). */
  beforeWelcomeRecordingId?: number | null;
}

async function resolveConnectTenant(prisma: any, vitalTenantId: string): Promise<string | null> {
  const link = await prisma.tenantPbxLink.findFirst({ where: { pbxTenantId: String(vitalTenantId) }, select: { tenantId: true } });
  return link?.tenantId ?? null;
}

export function makeM4Op(deps: ModifyCatalogDeps & { ivrApi: { call(body: Record<string, unknown>): Promise<any> } }): ModifyOp {
  const ivrApi = deps.ivrApi;
  return {
    id: "M4",
    capabilityId: "pbx.M4",
    kind: "ivr_option",
    title: "Change an IVR menu digit's destination",
    schema: M4_SCHEMA,
    feasibility: "astdb",
    risk: "medium",

    async snapshot(_client: ModifyClientLike, params: Record<string, any>, _ctx: ModifyOpCtx) {
      if (String(params.action).startsWith("native_")) {
        if (_ctx.simulate) {
          const state: M4NativeSnapshot = { native: true, ivrId: String(params.ivrId), option: params.option, before: null, beforeWelcomeRecordingId: null };
          return { state };
        }
        // Live: read the tenant's real IVR inventory from the PBX (tenant-scoped
        // on the helper) and capture the current entry/welcome for revert.
        const resp = await ivrApi.call({ tenantId: String(params.tenantId), action: "native_list", agentActionId: _ctx.actionId ?? "snapshot" });
        const ivr = (resp.catalog?.ivrs ?? []).find((i: any) => String(i.id) === String(params.ivrId));
        if (!ivr) throw new Error(`IVR '${params.ivrId}' not found for tenant — refusing (ownership fence)`);
        if (params.action === "native_set_welcome") {
          const state: M4NativeSnapshot = { native: true, ivrId: String(params.ivrId), beforeWelcomeRecordingId: ivr.welcomeRecordingId ?? null };
          return { state };
        }
        const entry = (ivr.entries ?? []).find((e: any) => String(e.option) === String(params.option));
        const state: M4NativeSnapshot = {
          native: true,
          ivrId: String(params.ivrId),
          option: String(params.option),
          before: entry?.target ? { type: String(entry.target.type), targetId: entry.target.targetId != null ? String(entry.target.targetId) : null, label: entry.target.label ?? null } : null,
        };
        return { state };
      }
      const connectTenantId = await resolveConnectTenant(deps.prisma, params.tenantId);
      if (!connectTenantId) return null;
      // Profile must belong to the tenant (clean check — ivrRouteProfile.tenantId).
      const profile = await deps.prisma.ivrRouteProfile.findFirst({
        where: { id: params.profileId, tenantId: connectTenantId },
        select: { id: true },
      });
      if (!profile) throw new Error(`IVR profile '${params.profileId}' not found in tenant — refusing (ownership fence)`);
      const prev = await deps.prisma.ivrOptionRoute.findFirst({
        where: { profileId: params.profileId, optionDigit: params.optionDigit },
        select: { destinationType: true, destinationRef: true, label: true },
      });
      const state: M4Snapshot = {
        connectTenantId,
        profileId: params.profileId,
        optionDigit: params.optionDigit,
        option: prev ? { destinationType: prev.destinationType, destinationRef: prev.destinationRef, label: prev.label ?? null } : null,
      };
      return { state };
    },

    async dispatch(_client: ModifyClientLike, params: Record<string, any>, ctx: ModifyOpCtx) {
      if (ctx.simulate) {
        return { simulated: true, action: params.action, profileId: params.profileId ?? null, ivrId: params.ivrId ?? null, optionDigit: params.optionDigit ?? params.option ?? null, destinationType: params.destinationType ?? params.targetType ?? null };
      }
      if (String(params.action).startsWith("native_")) {
        const resp = await ivrApi.call({
          tenantId: String(params.tenantId),
          action: params.action,
          ivrId: String(params.ivrId),
          ...(params.option ? { option: String(params.option) } : {}),
          ...(params.targetType ? { targetType: String(params.targetType) } : {}),
          ...(params.targetId ? { targetId: String(params.targetId) } : {}),
          ...(params.recordingId ? { recordingId: String(params.recordingId) } : {}),
          agentActionId: ctx.actionId ?? "unknown",
        });
        return { action: params.action, ivrId: String(params.ivrId), option: params.option ?? null, result: resp.result ?? null };
      }
      const resp = await ivrApi.call({
        tenantId: String(params.tenantId),
        action: params.action === "set" ? "set_option" : "clear_option",
        profileId: params.profileId,
        optionDigit: params.optionDigit,
        destinationType: params.destinationType,
        destinationRef: params.destinationRef,
        label: params.label ?? null,
        agentActionId: ctx.actionId ?? "unknown",
      });
      return { action: params.action, profileId: params.profileId, optionDigit: params.optionDigit, destinationType: params.destinationType ?? null, publish: resp.publishResult ?? null, publishError: resp.publishError ?? null };
    },

    async verify(_client: ModifyClientLike, params: Record<string, any>, written: any, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { ok: true, observed: { simulated: true } };
      if (String(params.action).startsWith("native_")) {
        // Read back the live inventory and confirm the entry/welcome landed.
        const resp = await ivrApi.call({ tenantId: String(params.tenantId), action: "native_list", agentActionId: ctx.actionId ?? "verify" });
        const ivr = (resp.catalog?.ivrs ?? []).find((i: any) => String(i.id) === String(params.ivrId));
        if (!ivr) return { ok: false, detail: "IVR vanished during execution" };
        if (params.action === "native_set_welcome") {
          if (String(ivr.welcomeRecordingId ?? "") !== String(params.recordingId)) {
            return { ok: false, observed: { welcomeRecordingId: ivr.welcomeRecordingId }, detail: "IVR welcome recording did not take" };
          }
          return { ok: true, observed: { welcomeRecordingId: ivr.welcomeRecordingId } };
        }
        const entry = (ivr.entries ?? []).find((e: any) => String(e.option) === String(params.option));
        if (params.action === "native_set_entry") {
          if (!entry?.target || String(entry.target.type) !== String(params.targetType) || String(entry.target.targetId) !== String(params.targetId)) {
            return { ok: false, observed: entry ?? null, detail: "IVR option does not reflect the requested target" };
          }
        } else if (entry) {
          return { ok: false, observed: entry, detail: "IVR option still present after clear" };
        }
        return { ok: true, observed: { option: params.option ?? null } };
      }
      if (written?.publishError) return { ok: false, detail: `publish failed: ${written.publishError}` };
      const row = await deps.prisma.ivrOptionRoute.findFirst({
        where: { profileId: params.profileId, optionDigit: params.optionDigit },
        select: { destinationType: true, destinationRef: true },
      });
      if (params.action === "set") {
        if (!row || row.destinationType !== params.destinationType || row.destinationRef !== params.destinationRef) {
          return { ok: false, observed: row, detail: "option does not reflect the requested destination" };
        }
      } else if (row) {
        return { ok: false, observed: row, detail: "option still present after clear" };
      }
      return { ok: true, observed: { digit: params.optionDigit } };
    },

    async revert(_client: ModifyClientLike, params: Record<string, any>, snapshotState: any, ctx: ModifyOpCtx) {
      if (String(params.action).startsWith("native_")) {
        const snap = snapshotState as M4NativeSnapshot;
        if (ctx.simulate) return { restored: snap?.before ?? snap?.beforeWelcomeRecordingId ?? { cleared: true } };
        if (params.action === "native_set_welcome") {
          if (snap?.beforeWelcomeRecordingId == null) {
            // No prior welcome to restore — a null welcome cannot be re-set via
            // set_welcome; report non-restorable rather than guessing.
            throw new Error("no prior welcome recording captured — revert not possible");
          }
          return ivrApi.call({ tenantId: String(params.tenantId), action: "native_set_welcome", ivrId: String(params.ivrId), recordingId: String(snap.beforeWelcomeRecordingId), agentActionId: ctx.actionId ?? "revert" });
        }
        if (snap?.before?.type && snap.before.targetId) {
          return ivrApi.call({ tenantId: String(params.tenantId), action: "native_set_entry", ivrId: String(params.ivrId), option: String(params.option), targetType: snap.before.type, targetId: String(snap.before.targetId), agentActionId: ctx.actionId ?? "revert" });
        }
        return ivrApi.call({ tenantId: String(params.tenantId), action: "native_clear_entry", ivrId: String(params.ivrId), option: String(params.option), agentActionId: ctx.actionId ?? "revert" });
      }
      const prev = (snapshotState as M4Snapshot)?.option;
      if (ctx.simulate) return { restored: prev ?? { cleared: true } };
      if (prev) {
        return ivrApi.call({
          tenantId: String(params.tenantId),
          action: "set_option",
          profileId: params.profileId,
          optionDigit: params.optionDigit,
          destinationType: prev.destinationType,
          destinationRef: prev.destinationRef,
          label: prev.label,
          agentActionId: ctx.actionId ?? "revert",
        });
      }
      return ivrApi.call({
        tenantId: String(params.tenantId),
        action: "clear_option",
        profileId: params.profileId,
        optionDigit: params.optionDigit,
        agentActionId: ctx.actionId ?? "revert",
      });
    },
  };
}
