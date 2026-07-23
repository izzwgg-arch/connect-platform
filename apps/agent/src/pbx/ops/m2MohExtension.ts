/**
 * M2 — Per-extension music-on-hold selection
 * (docs/ai-support-agent/specs/M2_MOH_EXTENSION_SPEC.md).
 *
 * The per-extension sibling of M1. Sets or clears ONE extension's hold-music
 * override via the api's internal door (the portal's own extension-override
 * path). No queue coverage (an extension override never touches queues).
 * Object type is `extension`, so X2's scope resolver + the protected-extension
 * gate (G5, ext 101) already apply with no new plumbing.
 *
 * Simulate mode (certification): DB reads only via injected prisma; ZERO HTTP.
 */
import { z } from "zod";
import type { ModifyOp, ModifyOpCtx, ModifyClientLike, ModifyCatalogDeps } from "../modifyCatalog";

const nonEmpty = z.string().min(1);

export const M2_SCHEMA = z
  .object({
    tenantId: nonEmpty,
    /** Single-object contract: the extension number IS the object. */
    objectId: nonEmpty,
    action: z.enum(["set", "clear"]),
    /** Required for set; must be a profile owned by the tenant. */
    profileId: nonEmpty.optional(),
    reason: z.string().max(500).optional(),
  })
  .refine((v) => v.action !== "set" || !!v.profileId, { message: "profileId required for set" });

export interface M2Snapshot {
  connectTenantId: string;
  extension: string;
  /** Previous override, or null when the extension was inheriting the tenant default. */
  override: { enabled: boolean; profileId: string | null; vitalPbxMohClassName: string | null } | null;
  targetClass: string | null;
}

async function resolveConnectTenant(prisma: any, vitalTenantId: string): Promise<string | null> {
  const link = await prisma.tenantPbxLink.findFirst({ where: { pbxTenantId: String(vitalTenantId) }, select: { tenantId: true } });
  return link?.tenantId ?? null;
}

export function makeM2Op(deps: ModifyCatalogDeps): ModifyOp {
  return {
    id: "M2",
    capabilityId: "pbx.M2",
    kind: "extension",
    title: "Change one extension's music-on-hold (override / inherit)",
    schema: M2_SCHEMA,
    feasibility: "astdb",
    risk: "low",

    async snapshot(_client: ModifyClientLike, params: Record<string, any>, _ctx: ModifyOpCtx) {
      const connectTenantId = await resolveConnectTenant(deps.prisma, params.tenantId);
      if (!connectTenantId) return null;
      const extension = String(params.objectId);
      let targetClass: string | null = null;
      if (params.action === "set") {
        const profile = await deps.prisma.mohProfile.findFirst({
          where: { id: params.profileId, tenantId: connectTenantId, isActive: true },
          select: { id: true, vitalPbxMohClassName: true },
        });
        if (!profile) throw new Error(`profile '${params.profileId}' not found in tenant — refusing (ownership fence)`);
        targetClass = profile.vitalPbxMohClassName;
      }
      const prev = await deps.prisma.mohExtensionOverride.findUnique({
        where: { tenantId_extension: { tenantId: connectTenantId, extension } },
      });
      const state: M2Snapshot = {
        connectTenantId,
        extension,
        override: prev ? { enabled: !!prev.enabled, profileId: prev.mohProfileId ?? null, vitalPbxMohClassName: prev.vitalPbxMohClassName ?? null } : null,
        targetClass,
      };
      return { state };
    },

    async dispatch(_client: ModifyClientLike, params: Record<string, any>, ctx: ModifyOpCtx) {
      if (ctx.simulate) {
        return { simulated: true, action: params.action, extension: String(params.objectId), profileId: params.profileId ?? null };
      }
      const resp = await deps.mohApi.call({
        tenantId: String(params.tenantId),
        action: params.action === "set" ? "ext_set" : "ext_clear",
        extension: String(params.objectId),
        profileId: params.profileId,
        reason: params.reason ?? "agent M2 extension MOH change",
        agentActionId: ctx.actionId ?? "unknown",
      });
      return { action: params.action, extension: String(params.objectId), profileId: params.profileId ?? null, publish: resp.publishResult ?? null, publishError: resp.publishError ?? null, extensionOverride: resp.extensionOverride ?? null };
    },

    async verify(_client: ModifyClientLike, params: Record<string, any>, written: any, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { ok: true, observed: { simulated: true } };
      if (written?.publishError) return { ok: false, detail: `publish failed: ${written.publishError}` };
      const connectTenantId = await resolveConnectTenant(deps.prisma, params.tenantId);
      if (!connectTenantId) return { ok: false, detail: "tenant link vanished during execution" };
      const extension = String(params.objectId);
      const row = await deps.prisma.mohExtensionOverride.findUnique({ where: { tenantId_extension: { tenantId: connectTenantId, extension } } });
      if (params.action === "set") {
        if (!row || !row.enabled || row.mohProfileId !== params.profileId) {
          return { ok: false, observed: row, detail: "extension override does not reflect the requested profile" };
        }
      } else if (row && row.enabled) {
        return { ok: false, observed: row, detail: "extension override still active after clear" };
      }
      // Publish must be successful (extension keys ride the tenant publish).
      const lp = await deps.prisma.mohPublishRecord.findFirst({ where: { tenantId: connectTenantId }, orderBy: { publishedAt: "desc" } });
      if (!lp || lp.status !== "success") {
        return { ok: false, observed: { publishStatus: lp?.status ?? "missing" }, detail: "latest MOH publish is not successful" };
      }
      return { ok: true, observed: { extension, publishId: lp.id } };
    },

    async revert(_client: ModifyClientLike, params: Record<string, any>, snapshotState: any, ctx: ModifyOpCtx) {
      const prev = (snapshotState as M2Snapshot)?.override;
      const extension = String(params.objectId);
      if (ctx.simulate) return { restored: prev ?? { cleared: true } };
      if (prev?.enabled && prev.profileId) {
        return deps.mohApi.call({
          tenantId: String(params.tenantId),
          action: "ext_set",
          extension,
          profileId: prev.profileId,
          reason: "agent M2 revert to previous extension hold music",
          agentActionId: ctx.actionId ?? "revert",
        });
      }
      // No prior override (or it was disabled) ⇒ clear back to inheritance.
      return deps.mohApi.call({
        tenantId: String(params.tenantId),
        action: "ext_clear",
        extension,
        reason: "agent M2 revert (extension had no prior override)",
        agentActionId: ctx.actionId ?? "revert",
      });
    },
  };
}
