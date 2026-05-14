import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import { requireCrmAdmin } from "./guard";
import { isCrmOutboundSmsConfigured } from "./smsRoutes";
import { todayBounds } from "./crmAggregateBounds";
import { crmCallbackOverdueWhere, crmMemberPendingOrInProgressWhere } from "./crmMemberQueryFragments";

/**
 * GET /crm/admin/pilot-readiness
 *
 * Bounded read-only snapshot for CRM admins (first-day / pilot dashboard).
 */
export async function registerCrmPilotReadinessRoutes(app: FastifyInstance) {
  app.get("/crm/admin/pilot-readiness", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const tenantId = user.tenantId;
    const { start: todayStart } = todayBounds();

    const [
      activeCampaigns,
      queuePendingOrInProgress,
      overdueCallbacks,
      usersWithCrmAccess,
      smsProviderConfigured,
      smsTimelineSample,
    ] = await Promise.all([
      (db as any).crmCampaign.count({
        where: { tenantId, status: "ACTIVE" },
      }),
      (db as any).crmCampaignMember.count({
        where: { tenantId, ...crmMemberPendingOrInProgressWhere() },
      }),
      (db as any).crmCampaignMember.count({
        where: { tenantId, ...crmCallbackOverdueWhere(todayStart) },
      }),
      (db as any).crmUserAccess.count({
        where: { tenantId, enabled: true },
      }),
      isCrmOutboundSmsConfigured(tenantId),
      (db as any).crmTimelineEvent.findFirst({
        where: { tenantId, type: { in: ["SMS_SENT", "SMS_RECEIVED"] } },
        select: { id: true },
      }),
    ]);

    const smsReadinessApplicable = smsTimelineSample != null || smsProviderConfigured;

    return {
      crmEnabled: true,
      usersWithCrmAccess,
      activeCampaigns,
      queuePendingOrInProgress,
      overdueCallbacks,
      smsProviderConfigured,
      smsReadinessApplicable,
    };
  });
}
