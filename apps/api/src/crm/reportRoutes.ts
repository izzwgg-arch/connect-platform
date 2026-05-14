import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import { requireCrmAccess } from "./guard";
import { todayBounds, daysAgoBounds, endOfWeek, startOfTomorrowFromDayStart } from "./crmAggregateBounds";

// ── Route registrar ───────────────────────────────────────────────────────────

export async function registerCrmReportRoutes(app: FastifyInstance) {

  // ── GET /crm/reports/daily ─────────────────────────────────────────────────
  // Tenant-wide snapshot for today. No date range — it's always "right now."
  // Used by the Reports daily summary tab and the dashboard.
  app.get("/crm/reports/daily", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { start: todayStart, end: todayEnd } = todayBounds();

    const [
      dispositionsToday,
      callsLinkedToday,
      contactsCreatedToday,
      tasksDueToday,
      overdueTasks,
      callbacksDueToday,
      overdueCallbacks,
      activeCampaigns,
      queueRemaining,
    ] = await Promise.all([
      (db as any).crmTimelineEvent.count({
        where: { tenantId, type: "DISPOSITION_SET", createdAt: { gte: todayStart } },
      }),
      (db as any).crmTimelineEvent.count({
        where: { tenantId, type: { in: ["CDR_INBOUND", "CDR_OUTBOUND"] }, createdAt: { gte: todayStart } },
      }),
      (db as any).crmContactMeta.count({
        where: { tenantId, createdAt: { gte: todayStart, lte: todayEnd } },
      }),
      (db as any).crmContactTask.count({
        where: { tenantId, status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { gte: todayStart, lte: todayEnd } },
      }),
      (db as any).crmContactTask.count({
        where: { tenantId, status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { lt: todayStart } },
      }),
      (db as any).crmCampaignMember.count({
        where: { tenantId, status: "CALLBACK", callbackAt: { lte: todayEnd }, campaign: { status: "ACTIVE" } },
      }),
      (db as any).crmCampaignMember.count({
        where: { tenantId, status: "CALLBACK", callbackAt: { lt: todayStart }, campaign: { status: "ACTIVE" } },
      }),
      (db as any).crmCampaign.count({
        where: { tenantId, status: "ACTIVE" },
      }),
      (db as any).crmCampaignMember.count({
        where: { tenantId, status: { in: ["PENDING", "IN_PROGRESS"] }, campaign: { status: "ACTIVE" } },
      }),
    ]);

    return {
      dispositionsToday,
      callsLinkedToday,
      contactsCreatedToday,
      tasksDueToday,
      overdueTasks,
      callbacksDueToday,
      overdueCallbacks,
      activeCampaigns,
      queueRemaining,
    };
  });

  // ── GET /crm/reports/campaigns ─────────────────────────────────────────────
  // Per-campaign performance. ?status= filter (ACTIVE|PAUSED|COMPLETED|all).
  // Uses a single groupBy query to pivot member counts — no N+1.
  app.get("/crm/reports/campaigns", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const q = req.query as Record<string, string>;
    const statusFilter = q.status ?? "all";
    const validStatuses = ["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"];

    const campaignWhere: Record<string, unknown> = { tenantId, status: { not: "ARCHIVED" } };
    if (statusFilter !== "all" && validStatuses.includes(statusFilter)) {
      campaignWhere.status = statusFilter;
    }

    // Fetch campaigns (cap 200) and member pivot in parallel
    const [campaigns, memberGroups, attemptSums] = await Promise.all([
      (db as any).crmCampaign.findMany({
        where: campaignWhere,
        orderBy: { updatedAt: "desc" },
        take: 200,
        select: {
          id: true,
          name: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { members: true } },
        },
      }),
      // One query: per-campaign per-status member counts
      (db as any).crmCampaignMember.groupBy({
        by: ["campaignId", "status"],
        where: { tenantId },
        _count: { id: true },
      }),
      // One query: per-campaign total attemptCount sum
      (db as any).crmCampaignMember.groupBy({
        by: ["campaignId"],
        where: { tenantId },
        _sum: { attemptCount: true },
      }),
    ]);

    // Build lookup maps
    type MemberGroup = { campaignId: string; status: string; _count: { id: number } };
    type AttemptSum = { campaignId: string; _sum: { attemptCount: number | null } };

    const countByCampaignStatus = new Map<string, Map<string, number>>();
    for (const g of memberGroups as MemberGroup[]) {
      if (!countByCampaignStatus.has(g.campaignId)) countByCampaignStatus.set(g.campaignId, new Map());
      countByCampaignStatus.get(g.campaignId)!.set(g.status, g._count.id);
    }

    const attemptsByCampaign = new Map<string, number>();
    for (const a of attemptSums as AttemptSum[]) {
      attemptsByCampaign.set(a.campaignId, a._sum.attemptCount ?? 0);
    }

    const rows = (campaigns as any[]).map((c) => {
      const statusMap = countByCampaignStatus.get(c.id) ?? new Map<string, number>();
      const pending   = (statusMap.get("PENDING") ?? 0) + (statusMap.get("IN_PROGRESS") ?? 0);
      const contacted = statusMap.get("CONTACTED") ?? 0;
      const callbacks = statusMap.get("CALLBACK") ?? 0;
      const converted = statusMap.get("CONVERTED") ?? 0;
      const dnc       = (statusMap.get("DO_NOT_CALL") ?? 0) + (statusMap.get("SKIPPED") ?? 0);
      const total     = c._count.members as number;
      const conversionRate = total > 0 ? Math.round((converted / total) * 100 * 10) / 10 : 0;

      return {
        id: c.id,
        name: c.name,
        status: c.status,
        total,
        pending,
        contacted,
        callbacks,
        converted,
        dnc,
        conversionRate,
        totalAttempts: attemptsByCampaign.get(c.id) ?? 0,
        lastActivityAt: c.updatedAt,
        createdAt: c.createdAt,
      };
    });

    return { campaigns: rows };
  });

  // ── GET /crm/reports/agents ────────────────────────────────────────────────
  // Per-agent activity summary. ?days=1|7|30 for the lookback window (default 30).
  // Uses groupBy to avoid N+1 against user list.
  app.get("/crm/reports/agents", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const q = req.query as Record<string, string>;
    const days = Math.min(90, Math.max(1, parseInt(q.days ?? "30")));
    const { start: todayStart, end: todayEnd } = todayBounds();
    const { since: lookbackStart } = daysAgoBounds(days);

    // 1. CRM-enabled users for this tenant
    const crmUsers = await (db as any).crmUserAccess.findMany({
      where: { tenantId, enabled: true },
      select: {
        userId: true,
        role: true,
        user: { select: { id: true, displayName: true, email: true, firstName: true, lastName: true } },
      },
    });

    if (crmUsers.length === 0) return { agents: [] };

    const userIds: string[] = (crmUsers as any[]).map((u: any) => u.userId);

    // 2. All aggregate queries in parallel — one groupBy each, no per-user loops
    const [
      queueGroups,        // per user, per status — queue counts
      callbackDueGroups,  // per user — callbacks due today
      dispositionGroups,  // per user — dispositions today
      conversionGroups,   // per user — conversions in lookback window
      taskGroups,         // per user — open tasks
      extensionRows,      // per user — owned active SIP extensions (for wallboard on-call matching)
    ] = await Promise.all([
      // Queue: all non-terminal ACTIVE campaign members per user
      (db as any).crmCampaignMember.groupBy({
        by: ["assignedToUserId"],
        where: {
          tenantId,
          assignedToUserId: { in: userIds },
          status: { notIn: ["CONVERTED", "DO_NOT_CALL", "SKIPPED"] },
          campaign: { status: "ACTIVE" },
        },
        _count: { id: true },
      }),
      // Callbacks due today per user
      (db as any).crmCampaignMember.groupBy({
        by: ["assignedToUserId"],
        where: {
          tenantId,
          assignedToUserId: { in: userIds },
          status: "CALLBACK",
          callbackAt: { lte: todayEnd },
          campaign: { status: "ACTIVE" },
        },
        _count: { id: true },
      }),
      // Dispositions today per user
      (db as any).crmTimelineEvent.groupBy({
        by: ["createdByUserId"],
        where: {
          tenantId,
          type: "DISPOSITION_SET",
          createdByUserId: { in: userIds },
          createdAt: { gte: todayStart },
        },
        _count: { id: true },
      }),
      // Conversions in lookback window per user
      (db as any).crmCampaignMember.groupBy({
        by: ["assignedToUserId"],
        where: {
          tenantId,
          assignedToUserId: { in: userIds },
          status: "CONVERTED",
          updatedAt: { gte: lookbackStart },
        },
        _count: { id: true },
      }),
      // Open tasks per user
      (db as any).crmContactTask.groupBy({
        by: ["assignedToUserId"],
        where: {
          tenantId,
          assignedToUserId: { in: userIds },
          status: { in: ["OPEN", "IN_PROGRESS"] },
        },
        _count: { id: true },
      }),
      // Active SIP extensions owned by these users — used by wallboard on-call matching.
      // Returns at most one extension per user in most deployments; multiple are supported.
      (db as any).extension.findMany({
        where: { tenantId, ownerUserId: { in: userIds }, status: "ACTIVE" },
        select: { ownerUserId: true, extNumber: true },
      }),
    ]);

    // Build lookup maps
    const queueByUser       = new Map<string, number>((queueGroups as any[]).map((g: any) => [g.assignedToUserId, g._count.id]));
    const callbackByUser    = new Map<string, number>((callbackDueGroups as any[]).map((g: any) => [g.assignedToUserId, g._count.id]));
    const dispByUser        = new Map<string, number>((dispositionGroups as any[]).map((g: any) => [g.createdByUserId, g._count.id]));
    const convertedByUser   = new Map<string, number>((conversionGroups as any[]).map((g: any) => [g.assignedToUserId, g._count.id]));
    const openTasksByUser   = new Map<string, number>((taskGroups as any[]).map((g: any) => [g.assignedToUserId, g._count.id]));

    // Extension map: userId → extNumber[] (most users have 0 or 1; multi-extension is valid)
    const extsByUser = new Map<string, string[]>();
    for (const e of extensionRows as Array<{ ownerUserId: string | null; extNumber: string }>) {
      if (!e.ownerUserId) continue;
      const arr = extsByUser.get(e.ownerUserId) ?? [];
      arr.push(e.extNumber);
      extsByUser.set(e.ownerUserId, arr);
    }

    const agents = (crmUsers as any[]).map((u: any) => ({
      userId: u.userId,
      displayName: u.user?.displayName || u.user?.firstName || u.user?.email || u.userId,
      email: u.user?.email ?? "",
      crmRole: u.role,
      assignedQueue:     queueByUser.get(u.userId) ?? 0,
      callbacksDueToday: callbackByUser.get(u.userId) ?? 0,
      dispositionsToday: dispByUser.get(u.userId) ?? 0,
      convertedLast:     convertedByUser.get(u.userId) ?? 0,
      openTasks:         openTasksByUser.get(u.userId) ?? 0,
      lookbackDays:      days,
      extensions:        extsByUser.get(u.userId) ?? [],
    }));

    // Sort by dispositionsToday desc, then convertedLast desc
    agents.sort((a, b) => b.dispositionsToday - a.dispositionsToday || b.convertedLast - a.convertedLast);

    return { agents, lookbackDays: days };
  });

  // ── GET /crm/reports/follow-ups ────────────────────────────────────────────
  // Tenant-wide follow-up health: overdue/today/this-week buckets for both
  // callbacks and tasks. Returns summary counts + first 100 detail rows per bucket.
  app.get("/crm/reports/follow-ups", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { start: todayStart, end: todayEnd } = todayBounds();
    const weekEnd = endOfWeek();
    const tomorrow = startOfTomorrowFromDayStart(todayStart);

    const MEMBER_INCLUDE = {
      contact: {
        select: {
          id: true,
          displayName: true,
          phones: { where: { isPrimary: true }, select: { numberRaw: true }, take: 1 },
        },
      },
      assignedTo: {
        select: { id: true, displayName: true, email: true },
      },
      campaign: { select: { id: true, name: true } },
    };

    const TASK_INCLUDE = {
      contact: {
        select: {
          id: true,
          displayName: true,
          phones: { where: { isPrimary: true }, select: { numberRaw: true }, take: 1 },
        },
      },
      assignedTo: { select: { id: true, displayName: true, email: true } },
    };

    const [
      overdueCallbackCount,
      dueTodayCallbackCount,
      dueThisWeekCallbackCount,
      overdueTaskCount,
      dueTodayTaskCount,

      overdueCallbackRows,
      dueTodayCallbackRows,
      dueThisWeekCallbackRows,
      overdueTaskRows,
      dueTodayTaskRows,
    ] = await Promise.all([
      // Counts
      (db as any).crmCampaignMember.count({
        where: { tenantId, status: "CALLBACK", callbackAt: { lt: todayStart }, campaign: { status: "ACTIVE" } },
      }),
      (db as any).crmCampaignMember.count({
        where: { tenantId, status: "CALLBACK", callbackAt: { gte: todayStart, lte: todayEnd }, campaign: { status: "ACTIVE" } },
      }),
      (db as any).crmCampaignMember.count({
        where: { tenantId, status: "CALLBACK", callbackAt: { gte: tomorrow, lte: weekEnd }, campaign: { status: "ACTIVE" } },
      }),
      (db as any).crmContactTask.count({
        where: { tenantId, status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { lt: todayStart } },
      }),
      (db as any).crmContactTask.count({
        where: { tenantId, status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { gte: todayStart, lte: todayEnd } },
      }),

      // Detail rows (capped at 100 each)
      (db as any).crmCampaignMember.findMany({
        where: { tenantId, status: "CALLBACK", callbackAt: { lt: todayStart }, campaign: { status: "ACTIVE" } },
        orderBy: { callbackAt: "asc" },
        take: 100,
        include: MEMBER_INCLUDE,
      }),
      (db as any).crmCampaignMember.findMany({
        where: { tenantId, status: "CALLBACK", callbackAt: { gte: todayStart, lte: todayEnd }, campaign: { status: "ACTIVE" } },
        orderBy: { callbackAt: "asc" },
        take: 100,
        include: MEMBER_INCLUDE,
      }),
      (db as any).crmCampaignMember.findMany({
        where: { tenantId, status: "CALLBACK", callbackAt: { gte: tomorrow, lte: weekEnd }, campaign: { status: "ACTIVE" } },
        orderBy: { callbackAt: "asc" },
        take: 100,
        include: MEMBER_INCLUDE,
      }),
      (db as any).crmContactTask.findMany({
        where: { tenantId, status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { lt: todayStart } },
        orderBy: { dueAt: "asc" },
        take: 100,
        include: TASK_INCLUDE,
      }),
      (db as any).crmContactTask.findMany({
        where: { tenantId, status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { gte: todayStart, lte: todayEnd } },
        orderBy: { dueAt: "asc" },
        take: 100,
        include: TASK_INCLUDE,
      }),
    ]);

    function formatMember(m: any) {
      return {
        id: m.id,
        contactId: m.contactId,
        contactName: m.contact?.displayName ?? "Unknown",
        contactPhone: m.contact?.phones?.[0]?.numberRaw ?? null,
        campaign: m.campaign ? { id: m.campaign.id, name: m.campaign.name } : null,
        assignedTo: m.assignedTo ? { id: m.assignedTo.id, name: m.assignedTo.displayName || m.assignedTo.email } : null,
        callbackAt: m.callbackAt ?? null,
        callbackNote: m.callbackNote ?? null,
        attemptCount: m.attemptCount,
      };
    }

    function formatTask(t: any) {
      return {
        id: t.id,
        contactId: t.contactId,
        contactName: t.contact?.displayName ?? "Unknown",
        contactPhone: t.contact?.phones?.[0]?.numberRaw ?? null,
        title: t.title,
        dueAt: t.dueAt ?? null,
        priority: t.priority,
        assignedTo: t.assignedTo ? { id: t.assignedTo.id, name: t.assignedTo.displayName || t.assignedTo.email } : null,
      };
    }

    return {
      callbacks: {
        overdue:     { count: overdueCallbackCount,    rows: (overdueCallbackRows as any[]).map(formatMember) },
        dueToday:    { count: dueTodayCallbackCount,   rows: (dueTodayCallbackRows as any[]).map(formatMember) },
        dueThisWeek: { count: dueThisWeekCallbackCount, rows: (dueThisWeekCallbackRows as any[]).map(formatMember) },
      },
      tasks: {
        overdue:  { count: overdueTaskCount,   rows: (overdueTaskRows as any[]).map(formatTask) },
        dueToday: { count: dueTodayTaskCount,  rows: (dueTodayTaskRows as any[]).map(formatTask) },
      },
    };
  });
}
