/**
 * M7 — IVR schedule / time-condition edit
 * (docs/ai-support-agent/specs/M7_IVR_SCHEDULE_SPEC.md).
 *
 * Edits a tenant's IvrScheduleConfig (timezone, business-hours rules, holidays,
 * per-mode profiles). Connect's IVR schedule worker is the LIVE scheduler, so
 * this is the same AstDB/no-regen/M1-safety class as M4–M6. The api door
 * validates shape + profile ownership; this op adds snapshot/verify/revert.
 *
 * Simulate mode: DB reads only via injected prisma; ZERO HTTP.
 */
import { z } from "zod";
import type { ModifyOp, ModifyOpCtx, ModifyClientLike, ModifyCatalogDeps } from "../modifyCatalog";

const nonEmpty = z.string().min(1);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const ScheduleSchema = z.object({
  timezone: z.string().min(1).max(64),
  businessHoursRules: z.array(z.object({ day: z.number().int().min(0).max(6), open: z.string().regex(HHMM), close: z.string().regex(HHMM) })).max(50),
  holidayDates: z.array(z.string().regex(YMD)).max(200),
  defaultProfileId: z.string().nullable().optional(),
  afterHoursProfileId: z.string().nullable().optional(),
  holidayProfileId: z.string().nullable().optional(),
  isActive: z.boolean().default(true),
});

export const M7_SCHEMA = z
  .object({
    tenantId: nonEmpty,
    /** The schedule is per-tenant: objectId == tenantId. */
    objectId: nonEmpty,
    schedule: ScheduleSchema,
  })
  .refine((v) => v.objectId === v.tenantId, { message: "objectId must equal tenantId (per-tenant schedule)" });

export interface M7Snapshot {
  connectTenantId: string;
  /** Prior schedule config (null if none existed). */
  schedule: Record<string, unknown> | null;
}

async function resolveConnectTenant(prisma: any, vitalTenantId: string): Promise<string | null> {
  const link = await prisma.tenantPbxLink.findFirst({ where: { pbxTenantId: String(vitalTenantId) }, select: { tenantId: true } });
  return link?.tenantId ?? null;
}

/** The subset of fields M7 owns — used to snapshot/restore without dragging id/timestamps. */
function scheduleShape(row: any): Record<string, unknown> | null {
  if (!row) return null;
  return {
    timezone: row.timezone,
    businessHoursRules: row.businessHoursRules ?? [],
    holidayDates: row.holidayDates ?? [],
    defaultProfileId: row.defaultProfileId ?? null,
    afterHoursProfileId: row.afterHoursProfileId ?? null,
    holidayProfileId: row.holidayProfileId ?? null,
    isActive: row.isActive ?? true,
  };
}

export function makeM7Op(deps: ModifyCatalogDeps & { ivrApi: { call(body: Record<string, unknown>): Promise<any> } }): ModifyOp {
  const ivrApi = deps.ivrApi;
  return {
    id: "M7",
    capabilityId: "pbx.M7",
    kind: "ivr_schedule",
    title: "Edit a tenant's IVR schedule (hours / holidays / per-mode menus)",
    schema: M7_SCHEMA,
    feasibility: "astdb",
    risk: "medium",

    async snapshot(_client: ModifyClientLike, params: Record<string, any>, _ctx: ModifyOpCtx) {
      const connectTenantId = await resolveConnectTenant(deps.prisma, params.tenantId);
      if (!connectTenantId) return null;
      const row = await deps.prisma.ivrScheduleConfig.findUnique({ where: { tenantId: connectTenantId } });
      const state: M7Snapshot = { connectTenantId, schedule: scheduleShape(row) };
      return { state };
    },

    async dispatch(_client: ModifyClientLike, params: Record<string, any>, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { simulated: true, tenantId: params.tenantId };
      const resp = await ivrApi.call({
        tenantId: String(params.tenantId),
        action: "set_schedule",
        schedule: params.schedule,
        agentActionId: ctx.actionId ?? "unknown",
      });
      return { tenantId: params.tenantId, publish: resp.publishResult ?? null, publishError: resp.publishError ?? null };
    },

    async verify(_client: ModifyClientLike, params: Record<string, any>, written: any, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { ok: true, observed: { simulated: true } };
      if (written?.publishError) return { ok: false, detail: `publish failed: ${written.publishError}` };
      const connectTenantId = await resolveConnectTenant(deps.prisma, params.tenantId);
      if (!connectTenantId) return { ok: false, detail: "tenant link vanished during execution" };
      const row = await deps.prisma.ivrScheduleConfig.findUnique({ where: { tenantId: connectTenantId } });
      const got = scheduleShape(row);
      const want = params.schedule;
      // Compare the fields we set (canonical JSON of the owned subset).
      const norm = (o: any) => JSON.stringify({
        timezone: o?.timezone, businessHoursRules: o?.businessHoursRules ?? [], holidayDates: o?.holidayDates ?? [],
        defaultProfileId: o?.defaultProfileId ?? null, afterHoursProfileId: o?.afterHoursProfileId ?? null,
        holidayProfileId: o?.holidayProfileId ?? null, isActive: o?.isActive ?? true,
      });
      if (norm(got) !== norm(want)) return { ok: false, observed: got, detail: "schedule does not reflect the requested config" };
      return { ok: true, observed: { timezone: got?.timezone } };
    },

    async revert(_client: ModifyClientLike, params: Record<string, any>, snapshotState: any, ctx: ModifyOpCtx) {
      const prev = (snapshotState as M7Snapshot)?.schedule;
      if (ctx.simulate) return { restored: !!prev };
      // Restore the previous config; if there was none, restore an empty/inactive schedule.
      const schedule = prev ?? { timezone: "America/New_York", businessHoursRules: [], holidayDates: [], defaultProfileId: null, afterHoursProfileId: null, holidayProfileId: null, isActive: false };
      return ivrApi.call({ tenantId: String(params.tenantId), action: "set_schedule", schedule, agentActionId: ctx.actionId ?? "revert" });
    },
  };
}
