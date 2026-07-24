/**
 * M6 — IVR timeout / invalid (fall-through) destination change
 * (docs/ai-support-agent/specs/M6_IVR_EXIT_DEST_SPEC.md).
 *
 * Changes where a caller goes on timeout (silent) or invalid (wrong key), for an
 * IVR profile — via the same AstDB publish path as M4/M5. Live, no dialplan
 * regen, M1-safety-class. The api door reuses M4's full hardening validator
 * (per-type, custom allow-list, loop guard, ownership); this op adds
 * snapshot/verify/revert.
 *
 * Simulate mode: DB reads only via injected prisma; ZERO HTTP.
 */
import { z } from "zod";
import type { ModifyOp, ModifyOpCtx, ModifyClientLike, ModifyCatalogDeps } from "../modifyCatalog";

const nonEmpty = z.string().min(1);
export const IVR_EXIT_SLOTS = ["timeout", "invalid"] as const;
const IVR_TYPES = ["extension", "queue", "ring_group", "voicemail", "ivr", "announcement", "external_number", "terminate", "custom"] as const;
const SLOT_FIELDS: Record<string, { type: string; ref: string }> = {
  timeout: { type: "timeoutDestinationType", ref: "timeoutDestinationRef" },
  invalid: { type: "invalidDestinationType", ref: "invalidDestinationRef" },
};

export const M6_SCHEMA = z
  .object({
    tenantId: nonEmpty,
    /** objectId is "<profileId>:<slot>". */
    objectId: nonEmpty,
    profileId: nonEmpty,
    exitSlot: z.enum(IVR_EXIT_SLOTS),
    action: z.enum(["set", "clear"]),
    destinationType: z.enum(IVR_TYPES).optional(),
    destinationRef: z.string().min(1).max(200).optional(),
  })
  .refine((v) => v.objectId === `${v.profileId}:${v.exitSlot}`, { message: "objectId must be '<profileId>:<slot>'" })
  .refine((v) => v.action !== "set" || (!!v.destinationType && !!v.destinationRef), { message: "destinationType+destinationRef required for set" });

export interface M6Snapshot {
  connectTenantId: string;
  profileId: string;
  exitSlot: string;
  destinationType: string | null;
  destinationRef: string | null;
}

async function resolveConnectTenant(prisma: any, vitalTenantId: string): Promise<string | null> {
  const link = await prisma.tenantPbxLink.findFirst({ where: { pbxTenantId: String(vitalTenantId) }, select: { tenantId: true } });
  return link?.tenantId ?? null;
}

export function makeM6Op(deps: ModifyCatalogDeps & { ivrApi: { call(body: Record<string, unknown>): Promise<any> } }): ModifyOp {
  const ivrApi = deps.ivrApi;
  return {
    id: "M6",
    capabilityId: "pbx.M6",
    kind: "ivr_exit",
    title: "Change an IVR timeout / invalid destination",
    schema: M6_SCHEMA,
    feasibility: "astdb",
    risk: "medium",

    async snapshot(_client: ModifyClientLike, params: Record<string, any>, _ctx: ModifyOpCtx) {
      const connectTenantId = await resolveConnectTenant(deps.prisma, params.tenantId);
      if (!connectTenantId) return null;
      const f = SLOT_FIELDS[params.exitSlot];
      const profile = await deps.prisma.ivrRouteProfile.findFirst({
        where: { id: params.profileId, tenantId: connectTenantId },
        select: { id: true, timeoutDestinationType: true, timeoutDestinationRef: true, invalidDestinationType: true, invalidDestinationRef: true },
      });
      if (!profile) throw new Error(`IVR profile '${params.profileId}' not found in tenant — refusing (ownership fence)`);
      const state: M6Snapshot = {
        connectTenantId,
        profileId: params.profileId,
        exitSlot: params.exitSlot,
        destinationType: (profile as any)[f.type] ?? null,
        destinationRef: (profile as any)[f.ref] ?? null,
      };
      return { state };
    },

    async dispatch(_client: ModifyClientLike, params: Record<string, any>, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { simulated: true, profileId: params.profileId, exitSlot: params.exitSlot, action: params.action };
      const resp = await ivrApi.call({
        tenantId: String(params.tenantId),
        action: "set_exit",
        profileId: params.profileId,
        exitSlot: params.exitSlot,
        destinationType: params.action === "set" ? params.destinationType : undefined,
        destinationRef: params.action === "set" ? params.destinationRef : undefined,
        agentActionId: ctx.actionId ?? "unknown",
      });
      return { profileId: params.profileId, exitSlot: params.exitSlot, action: params.action, publish: resp.publishResult ?? null, publishError: resp.publishError ?? null };
    },

    async verify(_client: ModifyClientLike, params: Record<string, any>, written: any, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { ok: true, observed: { simulated: true } };
      if (written?.publishError) return { ok: false, detail: `publish failed: ${written.publishError}` };
      const connectTenantId = await resolveConnectTenant(deps.prisma, params.tenantId);
      if (!connectTenantId) return { ok: false, detail: "tenant link vanished during execution" };
      const f = SLOT_FIELDS[params.exitSlot];
      const profile = await deps.prisma.ivrRouteProfile.findFirst({ where: { id: params.profileId, tenantId: connectTenantId }, select: { [f.type]: true, [f.ref]: true } as any });
      const wantType = params.action === "set" ? params.destinationType : null;
      const wantRef = params.action === "set" ? params.destinationRef : null;
      const gotType = profile ? ((profile as any)[f.type] ?? null) : undefined;
      const gotRef = profile ? ((profile as any)[f.ref] ?? null) : undefined;
      if (gotType !== wantType || gotRef !== wantRef) return { ok: false, observed: { gotType, gotRef }, detail: "exit destination does not reflect intent" };
      return { ok: true, observed: { slot: params.exitSlot } };
    },

    async revert(_client: ModifyClientLike, params: Record<string, any>, snapshotState: any, ctx: ModifyOpCtx) {
      const prev = snapshotState as M6Snapshot;
      if (ctx.simulate) return { restored: prev?.destinationType ?? null };
      if (prev?.destinationType && prev?.destinationRef) {
        return ivrApi.call({
          tenantId: String(params.tenantId), action: "set_exit", profileId: params.profileId, exitSlot: params.exitSlot,
          destinationType: prev.destinationType, destinationRef: prev.destinationRef, agentActionId: ctx.actionId ?? "revert",
        });
      }
      return ivrApi.call({ tenantId: String(params.tenantId), action: "set_exit", profileId: params.profileId, exitSlot: params.exitSlot, agentActionId: ctx.actionId ?? "revert" });
    },
  };
}
