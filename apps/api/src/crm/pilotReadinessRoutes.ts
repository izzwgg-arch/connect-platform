import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import { requireCrmAdmin } from "./guard";
import { isCrmOutboundSmsConfigured } from "./smsRoutes";

function todayBounds() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return { start };
}

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
        where: {
          tenantId,
          status: { in: ["PENDING", "IN_PROGRESS"] },
          campaign: { status: "ACTIVE" },
        },
      }),
      (db as any).crmCampaignMember.count({
        where: {
          tenantId,
          status: "CALLBACK",
          callbackAt: { lt: todayStart },
          campaign: { status: "ACTIVE" },
        },
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
