/**
 * M1 — Tenant music-on-hold selection (docs/ai-support-agent/specs/M1_MOH_TENANT_SPEC.md).
 *
 * The first real MODIFY_CATALOG op. Switches a tenant's hold music among that
 * tenant's OWN MohProfiles (optionally with expiry), or deactivates back to the
 * schedule. Executes via the api service's internal MOH door — the portal's own
 * daily code path — never directly against the PBX.
 *
 * X4 contract: verify REQUIRES queue evidence — when the tenant has queues, the
 * publish's queuePatch must show them covered, or verify fails ⇒ auto-revert.
 *
 * Simulate mode (certification): DB reads only (via injected prisma), ZERO
 * HTTP — the mohApi client is never touched when ctx.simulate is true.
 */
import { z } from "zod";
import type { ModifyOp, ModifyOpCtx, ModifyClientLike, ModifyCatalogDeps } from "../modifyCatalog";

const nonEmpty = z.string().min(1);

export const M1_SCHEMA = z
  .object({
    /** Vital PBX tenant id (e.g. "21"). */
    tenantId: nonEmpty,
    /** Single-object contract: the tenant's MOH slot IS the object. Must equal tenantId. */
    objectId: nonEmpty,
    /** schedule = create a one_time/weekly MohScheduleRule (worker plays + reverts it). */
    action: z.enum(["activate", "deactivate", "schedule"]),
    /** Required for activate/schedule; must belong to the tenant (checked 3×: scope fence, snapshot, api). */
    profileId: nonEmpty.optional(),
    reason: z.string().max(500).optional(),
    /** Optional expiry for temporary switches ("holiday music until Monday 9am"). */
    expiresHours: z.number().int().min(1).max(24 * 30).optional(),
    /** Minute-level expiry ("change it back in 15 minutes"). Wins over expiresHours. */
    expiresMinutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
    /** schedule, one_time window (UTC instants, ISO). */
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional(),
    /** schedule, weekly rule: 0=Sun…6=Sat + "HH:MM" local (tenant schedule tz). */
    weekday: z.number().int().min(0).max(6).optional(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  })
  .refine((v) => v.objectId === v.tenantId, { message: "objectId must equal tenantId (tenant MOH slot)" })
  .refine((v) => v.action !== "activate" || !!v.profileId, { message: "profileId required for activate" })
  .refine(
    (v) =>
      v.action !== "schedule" ||
      (!!v.profileId && ((!!v.startAt && !!v.endAt) !== (v.weekday != null && !!v.startTime && !!v.endTime))),
    { message: "schedule requires profileId and EITHER startAt+endAt OR weekday+startTime+endTime" },
  )
  .refine((v) => !(v.startAt && v.endAt) || new Date(v.endAt).getTime() > new Date(v.startAt).getTime(), {
    message: "endAt must be after startAt",
  });

export interface M1Snapshot {
  connectTenantId: string;
  override: { isActive: boolean; profileId: string | null; expiresAt: string | null } | null;
  /** Class the chosen profile should publish (captured for verify). */
  targetClass: string | null;
}

/** Resolve vital tenant → Connect tenant via the mirror. Null ⇒ not linked. */
async function resolveConnectTenant(prisma: any, vitalTenantId: string): Promise<string | null> {
  const link = await prisma.tenantPbxLink.findFirst({ where: { pbxTenantId: String(vitalTenantId) }, select: { tenantId: true } });
  return link?.tenantId ?? null;
}

export function makeM1Op(deps: ModifyCatalogDeps): ModifyOp {
  return {
    id: "M1",
    capabilityId: "pbx.M1",
    kind: "moh_tenant",
    title: "Change tenant music-on-hold (inbound + outbound + ALL queues)",
    schema: M1_SCHEMA,
    feasibility: "astdb",
    risk: "low",

    async snapshot(_client: ModifyClientLike, params: Record<string, any>, _ctx: ModifyOpCtx) {
      const connectTenantId = await resolveConnectTenant(deps.prisma, params.tenantId);
      if (!connectTenantId) return null; // G9 refuses: unlinked tenant
      let targetClass: string | null = null;
      if (params.action === "activate" || params.action === "schedule") {
        // Triple-checked ownership, layer 2 of 3 (scope fence did layer 1, api does layer 3).
        const profile = await deps.prisma.mohProfile.findFirst({
          where: { id: params.profileId, tenantId: connectTenantId, isActive: true },
          select: { id: true, vitalPbxMohClassName: true },
        });
        if (!profile) throw new Error(`profile '${params.profileId}' not found in tenant — refusing (ownership fence)`);
        targetClass = profile.vitalPbxMohClassName;
      }
      const o = await deps.prisma.mohOverrideState.findUnique({ where: { tenantId: connectTenantId } });
      const state: M1Snapshot = {
        connectTenantId,
        override: o
          ? { isActive: !!o.isActive, profileId: o.profileId ?? null, expiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : null }
          : null,
        targetClass,
      };
      return { state };
    },

    async dispatch(_client: ModifyClientLike, params: Record<string, any>, ctx: ModifyOpCtx) {
      if (params.action === "schedule") {
        if (ctx.simulate) {
          return { simulated: true, action: "schedule", profileId: params.profileId ?? null, startAt: params.startAt ?? null, endAt: params.endAt ?? null, weekday: params.weekday ?? null };
        }
        const resp = await deps.mohApi.call({
          tenantId: String(params.tenantId),
          action: "schedule_add",
          profileId: params.profileId,
          startAt: params.startAt,
          endAt: params.endAt,
          weekday: params.weekday,
          startTime: params.startTime,
          endTime: params.endTime,
          reason: params.reason ?? "agent M1 scheduled MOH window",
          agentActionId: ctx.actionId ?? "unknown",
        });
        return { action: "schedule", profileId: params.profileId ?? null, rule: resp.rule ?? null, publish: resp.publishResult ?? null, publishError: resp.publishError ?? null };
      }
      const expiresAt = params.expiresMinutes
        ? new Date(Date.now() + params.expiresMinutes * 60_000).toISOString()
        : params.expiresHours
          ? new Date(Date.now() + params.expiresHours * 3600_000).toISOString()
          : undefined;
      if (ctx.simulate) {
        // Certification surface: NO network contact, deterministic result.
        return { simulated: true, action: params.action, profileId: params.profileId ?? null, expiresAt: expiresAt ?? null };
      }
      const resp = await deps.mohApi.call({
        tenantId: String(params.tenantId),
        action: params.action,
        profileId: params.profileId,
        reason: params.reason ?? "agent M1 tenant MOH change",
        expiresAt: expiresAt ?? null,
        agentActionId: ctx.actionId ?? "unknown",
      });
      return { action: params.action, profileId: params.profileId ?? null, expiresAt: expiresAt ?? null, publish: resp.publishResult ?? null, publishError: resp.publishError ?? null };
    },

    async verify(_client: ModifyClientLike, params: Record<string, any>, written: any, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { ok: true, observed: { simulated: true } };

      // schedule: verify the rule row landed (a future window publishes nothing
      // now — the worker reconcile plays it at start time; an immediate-publish
      // failure inside an already-active window is also worker-reconciled ≤60s).
      if (params.action === "schedule") {
        const connectTid = await resolveConnectTenant(deps.prisma, params.tenantId);
        if (!connectTid) return { ok: false, detail: "tenant link vanished during execution" };
        const cfg = await deps.prisma.mohScheduleConfig.findUnique({ where: { tenantId: connectTid } });
        if (!cfg) return { ok: false, detail: "schedule config missing after schedule_add" };
        const rule = await deps.prisma.mohScheduleRule.findFirst({
          where: {
            scheduleId: cfg.id,
            profileId: params.profileId,
            isActive: true,
            ...(params.startAt
              ? { ruleType: "one_time", startAt: new Date(params.startAt), endAt: new Date(params.endAt) }
              : { ruleType: "weekly", weekday: params.weekday, startTime: params.startTime, endTime: params.endTime }),
          },
        });
        if (!rule) return { ok: false, detail: "scheduled rule not found after schedule_add" };
        return { ok: true, observed: { ruleId: rule.id, ruleType: rule.ruleType } };
      }

      if (written?.publishError) return { ok: false, detail: `publish failed: ${written.publishError}` };
      const connectTenantId = await resolveConnectTenant(deps.prisma, params.tenantId);
      if (!connectTenantId) return { ok: false, detail: "tenant link vanished during execution" };

      // 1) Override state must match intent.
      const o = await deps.prisma.mohOverrideState.findUnique({ where: { tenantId: connectTenantId } });
      if (params.action === "activate") {
        if (!o?.isActive || o.profileId !== params.profileId) {
          return { ok: false, observed: o, detail: "override state does not reflect the requested activation" };
        }
      } else if (o?.isActive) {
        return { ok: false, observed: o, detail: "override still active after deactivation" };
      }

      // 2) Latest publish must be a success…
      const lp = await deps.prisma.mohPublishRecord.findFirst({
        where: { tenantId: connectTenantId },
        orderBy: { publishedAt: "desc" },
      });
      if (!lp || lp.status !== "success") {
        return { ok: false, observed: { publishStatus: lp?.status ?? "missing" }, detail: "latest MOH publish is not successful" };
      }

      // 3) …and MUST carry queue coverage (X4): when the tenant has queues, the
      // helper's queuePatch evidence must show them patched or already correct.
      const ns: any = lp.nativeSync ?? {};
      const queuesTotal = typeof ns.queuesTotal === "number" ? ns.queuesTotal : 0;
      if (queuesTotal > 0) {
        const qp: any = ns.helperResponse?.queuePatch ?? null;
        const covered = !!qp && (qp.patched > 0 || (qp.error == null && qp.patched === 0) || qp.error === "queue_conf_missing");
        if (!covered) {
          return { ok: false, observed: { queuePatch: qp }, detail: "queue coverage evidence missing/failed (X4 contract) — queues may still play old music" };
        }
      }
      return { ok: true, observed: { publishId: lp.id, mohClass: lp.newMohClass, queuesTotal } };
    },

    async revert(_client: ModifyClientLike, params: Record<string, any>, snapshotState: any, ctx: ModifyOpCtx) {
      // schedule revert = remove the rule we created (match on our exact shape).
      if (params.action === "schedule") {
        if (ctx.simulate) return { removed: true };
        return deps.mohApi.call({
          tenantId: String(params.tenantId),
          action: "schedule_remove",
          profileId: params.profileId,
          startAt: params.startAt,
          endAt: params.endAt,
          weekday: params.weekday,
          startTime: params.startTime,
          endTime: params.endTime,
          reason: "agent M1 revert (remove scheduled rule)",
          agentActionId: ctx.actionId ?? "revert",
        });
      }
      const prev = (snapshotState as M1Snapshot)?.override;
      if (ctx.simulate) return { restored: prev ?? { isActive: false } };
      if (prev?.isActive && prev.profileId) {
        return deps.mohApi.call({
          tenantId: String(params.tenantId),
          action: "activate",
          profileId: prev.profileId,
          reason: "agent M1 revert to previous hold music",
          expiresAt: prev.expiresAt,
          agentActionId: ctx.actionId ?? "revert",
        });
      }
      return deps.mohApi.call({
        tenantId: String(params.tenantId),
        action: "deactivate",
        reason: "agent M1 revert (no previous override)",
        agentActionId: ctx.actionId ?? "revert",
      });
    },
  };
}
