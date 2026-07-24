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

export const M4_SCHEMA = z
  .object({
    tenantId: nonEmpty,
    /** Single-object contract: objectId is "<profileId>:<digit>". */
    objectId: nonEmpty,
    action: z.enum(["set", "clear"]),
    profileId: nonEmpty,
    optionDigit: z.enum(["0","1","2","3","4","5","6","7","8","9","star","hash"]),
    destinationType: z.enum(IVR_TYPES).optional(),
    destinationRef: z.string().min(1).max(200).optional(),
    label: z.string().max(60).nullable().optional(),
  })
  .refine((v) => v.objectId === `${v.profileId}:${v.optionDigit}`, { message: "objectId must be '<profileId>:<digit>'" })
  .refine((v) => v.action !== "set" || (!!v.destinationType && !!v.destinationRef), { message: "destinationType + destinationRef required for set" });

export interface M4Snapshot {
  connectTenantId: string;
  profileId: string;
  optionDigit: string;
  /** Prior option for this digit, or null when the digit was unassigned. */
  option: { destinationType: string; destinationRef: string; label: string | null } | null;
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
        return { simulated: true, action: params.action, profileId: params.profileId, optionDigit: params.optionDigit, destinationType: params.destinationType ?? null };
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
