import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { db } from "@connect/db";
import { requireCrmAdmin } from "./guard";
import { isCrmOutboundSmsConfigured } from "./smsRoutes";

function todayBounds() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { now, start, end };
}

function num(v: bigint | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === "bigint" ? Number(v) : v;
}

async function fetchTelephonyHealthSnapshot(ms = 2500): Promise<{
  ok: boolean;
  status: string | null;
  pbxLinkState: string | null;
  activeCalls: number | null;
  activeQueues: number | null;
  activeExtensions: number | null;
  error: string | null;
}> {
  const telephonyBase = (process.env.TELEPHONY_INTERNAL_URL ?? "http://telephony:3003").replace(/\/$/, "");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`${telephonyBase}/health`, { signal: ctrl.signal });
    if (!r.ok) {
      return {
        ok: false,
        status: null,
        pbxLinkState: null,
        activeCalls: null,
        activeQueues: null,
        activeExtensions: null,
        error: `telephony_http_${r.status}`,
      };
    }
    const body = (await r.json()) as {
      status?: string;
      pbxLinkState?: string;
      activeCalls?: number;
      activeQueues?: number;
      activeExtensions?: number;
    };
    return {
      ok: true,
      status: body.status ?? null,
      pbxLinkState: body.pbxLinkState ?? null,
      activeCalls: body.activeCalls ?? null,
      activeQueues: body.activeQueues ?? null,
      activeExtensions: body.activeExtensions ?? null,
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      status: null,
      pbxLinkState: null,
      activeCalls: null,
      activeQueues: null,
      activeExtensions: null,
      error: e instanceof Error ? e.message : "telephony_fetch_failed",
    };
  } finally {
    clearTimeout(t);
  }
}

export async function registerCrmDiagnosticsRoutes(app: FastifyInstance) {
  /**
   * GET /crm/admin/diagnostics
   *
   * Read-only operational snapshot for CRM admins. Bounded aggregates + last 20 import batches.
   */
  app.get("/crm/admin/diagnostics", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;

    const tenantId = user.tenantId;
    const { start: todayStart, end: todayEnd } = todayBounds();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const activeCampaign = { status: "ACTIVE" as const };

    const [
      totalActiveMembers,
      unassignedWorkQueueMembers,
      callbackOverdue,
      membersMissingContact,
      membersMissingCampaign,
      membersAssignedDisabledUser,
      membersAssignedNoCrmAccess,
      duplicatePairGroups,
      importBatches,
      smsSentToday,
      smsReceivedToday,
      lastInboundSms,
      lastOutboundSms,
      contactsDoNotSms,
      marketingSmsFailedToday,
      smsConfigured,
      membersArchivedOrInactiveContact,
      crossTenantMembers,
      callbackRowsMissingTime,
      activeCampaignsCount,
      campaignsZeroMembers,
      campaignsOver1000Members,
      campaignsStale30d,
      campaignsAllTerminalWhileActive,
      telephony,
      queueRemainingWallboard,
    ] = await Promise.all([
      db.crmCampaignMember.count({
        where: { tenantId, status: { in: ["PENDING", "IN_PROGRESS", "CALLBACK"] }, campaign: activeCampaign },
      }),
      db.crmCampaignMember.count({
        where: {
          tenantId,
          status: { in: ["PENDING", "IN_PROGRESS", "CALLBACK"] },
          assignedToUserId: null,
          campaign: activeCampaign,
        },
      }),
      db.crmCampaignMember.count({
        where: {
          tenantId,
          status: "CALLBACK",
          callbackAt: { lt: todayStart },
          campaign: activeCampaign,
        },
      }),
      db.$queryRaw<[{ c: bigint }]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS c
        FROM "CrmCampaignMember" m
        LEFT JOIN "Contact" co ON co.id = m."contactId"
        WHERE m."tenantId" = ${tenantId} AND co.id IS NULL
      `).then((r) => num(r[0]?.c)),
      db.$queryRaw<[{ c: bigint }]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS c
        FROM "CrmCampaignMember" m
        LEFT JOIN "CrmCampaign" cp ON cp.id = m."campaignId"
        WHERE m."tenantId" = ${tenantId} AND cp.id IS NULL
      `).then((r) => num(r[0]?.c)),
      db.crmCampaignMember.count({
        where: {
          tenantId,
          assignedToUserId: { not: null },
          campaign: activeCampaign,
          assignedTo: { status: "DISABLED" },
        },
      }),
      db.$queryRaw<[{ c: bigint }]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS c
        FROM "CrmCampaignMember" m
        JOIN "User" u ON u.id = m."assignedToUserId"
        WHERE m."tenantId" = ${tenantId}
          AND m."assignedToUserId" IS NOT NULL
          AND u.role::text NOT IN ('ADMIN', 'TENANT_ADMIN', 'SUPER_ADMIN')
          AND NOT EXISTS (
            SELECT 1 FROM "CrmUserAccess" a
            WHERE a."tenantId" = m."tenantId"
              AND a."userId" = u.id
              AND a.enabled = true
          )
      `).then((r) => num(r[0]?.c)),
      db.$queryRaw<[{ c: bigint }]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS c FROM (
          SELECT m."campaignId", m."contactId"
          FROM "CrmCampaignMember" m
          WHERE m."tenantId" = ${tenantId}
          GROUP BY m."campaignId", m."contactId"
          HAVING COUNT(*) > 1
        ) d
      `).then((r) => num(r[0]?.c)),
      db.crmImportBatch.findMany({
        where: { tenantId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          status: true,
          fileName: true,
          createdCount: true,
          updatedCount: true,
          skippedCount: true,
          errorCount: true,
          createdAt: true,
        },
      }),
      db.crmTimelineEvent.count({
        where: { tenantId, type: "SMS_SENT", createdAt: { gte: todayStart, lte: todayEnd } },
      }),
      db.crmTimelineEvent.count({
        where: { tenantId, type: "SMS_RECEIVED", createdAt: { gte: todayStart, lte: todayEnd } },
      }),
      db.crmTimelineEvent.findFirst({
        where: { tenantId, type: "SMS_RECEIVED" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      db.crmTimelineEvent.findFirst({
        where: { tenantId, type: "SMS_SENT" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      db.crmContactMeta.count({ where: { tenantId, doNotSms: true } }),
      db.smsMessage.count({
        where: {
          status: "FAILED",
          createdAt: { gte: todayStart },
          campaign: { tenantId },
        },
      }),
      isCrmOutboundSmsConfigured(tenantId),
      db.crmCampaignMember.count({
        where: {
          tenantId,
          campaign: activeCampaign,
          contact: { OR: [{ active: false }, { archivedAt: { not: null } }] },
        },
      }),
      db.$queryRaw<[{ c: bigint }]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS c
        FROM "CrmCampaignMember" m
        JOIN "Contact" co ON co.id = m."contactId"
        JOIN "CrmCampaign" cp ON cp.id = m."campaignId"
        WHERE m."tenantId" = ${tenantId}
          AND (m."tenantId" <> co."tenantId" OR m."tenantId" <> cp."tenantId")
      `).then((r) => num(r[0]?.c)),
      db.crmCampaignMember.count({
        where: { tenantId, status: "CALLBACK", callbackAt: null, campaign: activeCampaign },
      }),
      db.crmCampaign.count({ where: { tenantId, status: "ACTIVE" } }),
      db.crmCampaign.count({ where: { tenantId, status: "ACTIVE", members: { none: {} } } }),
      db.$queryRaw<[{ c: bigint }]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS c FROM (
          SELECT m."campaignId"
          FROM "CrmCampaignMember" m
          WHERE m."tenantId" = ${tenantId}
          GROUP BY m."campaignId"
          HAVING COUNT(*) > 1000
        ) t
      `).then((r) => num(r[0]?.c)),
      db.$queryRaw<[{ c: bigint }]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS c
        FROM "CrmCampaign" c
        WHERE c."tenantId" = ${tenantId}
          AND c.status = 'ACTIVE'
          AND c."updatedAt" < ${thirtyDaysAgo}
          AND NOT EXISTS (
            SELECT 1 FROM "CrmCampaignMember" m
            WHERE m."campaignId" = c.id
              AND m."updatedAt" >= ${thirtyDaysAgo}
          )
      `).then((r) => num(r[0]?.c)),
      db.$queryRaw<[{ c: bigint }]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS c
        FROM "CrmCampaign" c
        WHERE c."tenantId" = ${tenantId}
          AND c.status = 'ACTIVE'
          AND EXISTS (SELECT 1 FROM "CrmCampaignMember" m WHERE m."campaignId" = c.id)
          AND NOT EXISTS (
            SELECT 1 FROM "CrmCampaignMember" m2
            WHERE m2."campaignId" = c.id
              AND m2.status IN ('PENDING','IN_PROGRESS','CALLBACK')
          )
      `).then((r) => num(r[0]?.c)),
      fetchTelephonyHealthSnapshot(),
      db.crmCampaignMember.count({
        where: { tenantId, status: { in: ["PENDING", "IN_PROGRESS"] }, campaign: activeCampaign },
      }),
    ]);

    const generatedAt = new Date().toISOString();

    return {
      generatedAt,
      queue: {
        totalActiveMembers,
        unassignedMembers: unassignedWorkQueueMembers,
        callbackOverdue,
        duplicateCampaignContactPairGroups: duplicatePairGroups,
        membersMissingContact,
        membersMissingCampaign,
        membersAssignedToDisabledUsers: membersAssignedDisabledUser,
        membersAssignedWithoutCrmAccess: membersAssignedNoCrmAccess,
      },
      imports: {
        recentBatches: importBatches.map((b) => ({
          id: b.id,
          status: b.status,
          fileName: b.fileName,
          createdCount: b.createdCount,
          updatedCount: b.updatedCount,
          skippedCount: b.skippedCount,
          errorCount: b.errorCount,
          createdAt: b.createdAt.toISOString(),
          campaignId: null,
        })),
      },
      sms: {
        smsSentToday: smsSentToday,
        smsReceivedToday: smsReceivedToday,
        lastInboundAt: lastInboundSms?.createdAt.toISOString() ?? null,
        lastOutboundAt: lastOutboundSms?.createdAt.toISOString() ?? null,
        contactsWithDoNotSms: contactsDoNotSms,
        crmTimelineSmsFailureEvents: 0,
        crmTimelineSmsNote:
          "CRM contact SMS only records SMS_SENT after provider success; failed sends do not create timeline rows.",
        marketingSmsFailedToday: marketingSmsFailedToday,
        providerConfigured: smsConfigured,
        providerMissingWarning: smsConfigured
          ? null
          : "Outbound CRM SMS will fail until Messaging credentials and a sender number are configured for this tenant.",
      },
      ownership: {
        membersOnArchivedOrInactiveContacts: membersArchivedOrInactiveContact,
        crossTenantMemberRows: crossTenantMembers,
        activeCampaignCallbackWithNullCallbackAt: callbackRowsMissingTime,
      },
      campaigns: {
        active: activeCampaignsCount,
        activeWithZeroMembers: campaignsZeroMembers,
        campaignsWithOver1000Members: campaignsOver1000Members,
        activeNoMemberActivity30d: campaignsStale30d,
        activeAllMembersTerminal: campaignsAllTerminalWhileActive,
        staleActivityNote:
          "A campaign is counted here when both the campaign row and all member rows have had no updates for 30 days — verify whether it should be paused or completed.",
      },
      wallboard: {
        telephonyFetchOk: telephony.ok,
        telephonyFetchError: telephony.error,
        activeTelephonyCalls: telephony.activeCalls,
        activeTelephonyQueues: telephony.activeQueues,
        telephonyStatus: telephony.status,
        pbxLinkState: telephony.pbxLinkState,
        crmQueueRemainingPendingOrInProgress: queueRemainingWallboard,
        wallboardReportsRefreshNote:
          "The Live Wallboard recomputes CRM metrics on each browser refresh (about every 60 seconds). This payload reflects counts at generatedAt only.",
        snapshotAt: generatedAt,
      },
    };
  });
}
