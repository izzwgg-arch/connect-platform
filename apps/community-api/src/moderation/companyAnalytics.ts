import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { requireActor } from "../auth/actor.js";
import { requireOrgPermission } from "../organizations/permissions.js";
import { notFound } from "../lib/errors.js";

const RANGE_DAYS: Record<string, number> = { "30": 30, "90": 90, "365": 365 };

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pctDelta(curr: number, prev: number): number | null {
  if (prev === 0) return curr === 0 ? 0 : null; // "null" reads as "new this period" on the web, never a fake 0%/100%
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

async function sumDaily(db: Db, objectType: string, objectId: string, event: string, since: Date, until: Date): Promise<number> {
  const r = await db.analyticsDaily.aggregate({ _sum: { count: true }, where: { objectType, objectId, event, day: { gte: since, lt: until } } });
  return r._sum.count ?? 0;
}

async function dailySeries(db: Db, objectType: string, objectId: string, event: string, since: Date, until: Date) {
  const rows = await db.analyticsDaily.findMany({ where: { objectType, objectId, event, day: { gte: since, lt: until } }, orderBy: { day: "asc" } });
  return rows.map((r) => ({ day: dayKey(r.day), count: r.count }));
}

async function buildOrgAnalytics(db: Db, orgId: string, days: number) {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  // Upper bound is exclusive and one day AHEAD of today so today's own rolled-up
  // row (day = todayStart) is included in the "current period" window.
  const now = new Date(todayStart.getTime() + 86_400_000);
  const since = new Date(now.getTime() - days * 86_400_000);
  const prevSince = new Date(since.getTime() - days * 86_400_000);

  const [org, pageViews, prevPageViews, newFollowers, prevNewFollowers, unfollows, series, rfqsReceived, prevRfqsReceived, quotesSent, prevQuotesSent, quotesAccepted, prevQuotesAccepted, orgPosts] = await Promise.all([
    db.organization.findUnique({ where: { id: orgId }, select: { displayName: true, followerCount: true } }),
    sumDaily(db, "Organization", orgId, "company_view", since, now),
    sumDaily(db, "Organization", orgId, "company_view", prevSince, since),
    sumDaily(db, "Organization", orgId, "company_follow", since, now),
    sumDaily(db, "Organization", orgId, "company_follow", prevSince, since),
    sumDaily(db, "Organization", orgId, "unfollow", since, now),
    dailySeries(db, "Organization", orgId, "company_view", since, now),
    db.rfqInvite.count({ where: { organizationId: orgId, createdAt: { gte: since, lt: now } } }),
    db.rfqInvite.count({ where: { organizationId: orgId, createdAt: { gte: prevSince, lt: since } } }),
    db.quote.count({ where: { organizationId: orgId, createdAt: { gte: since, lt: now } } }),
    db.quote.count({ where: { organizationId: orgId, createdAt: { gte: prevSince, lt: since } } }),
    db.quote.count({ where: { organizationId: orgId, status: "ACCEPTED", createdAt: { gte: since, lt: now } } }),
    db.quote.count({ where: { organizationId: orgId, status: "ACCEPTED", createdAt: { gte: prevSince, lt: since } } }),
    db.post.findMany({ where: { organizationId: orgId, deletedAt: null }, orderBy: { impressionCount: "desc" }, take: 5, select: { id: true, body: true, impressionCount: true, reactionCount: true, commentCount: true, saveCount: true } }),
  ]);
  if (!org) return null;

  // Response time: hours between an RFQ's creation and this org's quote on it, for
  // quotes submitted in the period. Only real signal available (no per-post
  // "profile click"/"quote request" event exists yet, so topPosts sticks to
  // impressions/reactions/comments/saves rather than fabricating those two).
  const quotesInPeriod = await db.quote.findMany({ where: { organizationId: orgId, createdAt: { gte: since, lt: now } }, select: { createdAt: true, rfqId: true } });
  let responseTimeHours: number | null = null;
  if (quotesInPeriod.length) {
    const rfqs = await db.rfq.findMany({ where: { id: { in: quotesInPeriod.map((q) => q.rfqId) } }, select: { id: true, createdAt: true } });
    const rfqCreated = new Map(rfqs.map((r) => [r.id, r.createdAt]));
    const diffsHours = quotesInPeriod
      .map((q) => {
        const rc = rfqCreated.get(q.rfqId);
        return rc ? (q.createdAt.getTime() - rc.getTime()) / 3_600_000 : null;
      })
      .filter((x): x is number => x != null && x >= 0);
    if (diffsHours.length) responseTimeHours = Math.round((diffsHours.reduce((a, b) => a + b, 0) / diffsHours.length) * 10) / 10;
  }

  const sourceRows = await db.analyticsEvent.groupBy({ by: ["surface"], where: { objectType: "Organization", objectId: orgId, event: "company_view", occurredAt: { gte: since, lt: now } }, _count: { _all: true } });
  const sourceTotal = sourceRows.reduce((s, r) => s + r._count._all, 0);
  const sources = sourceRows
    .map((r) => ({ surface: r.surface ?? "direct", count: r._count._all, pct: sourceTotal ? Math.round((r._count._all / sourceTotal) * 100) : 0 }))
    .sort((a, b) => b.count - a.count);

  const quoteWinRate = quotesSent > 0 ? quotesAccepted / quotesSent : 0;
  const prevQuoteWinRate = prevQuotesSent > 0 ? prevQuotesAccepted / prevQuotesSent : 0;

  return {
    organization: { id: orgId, displayName: org.displayName },
    range: days,
    tiles: {
      pageViews,
      followers: org.followerCount,
      newFollowers,
      postReach: 0, // filled in by the route right after this returns (needs topPosts, computed above)
      rfqsReceived,
      quotesSent,
      quoteWinRate: Math.round(quoteWinRate * 1000) / 10,
      responseTimeHours,
    },
    deltas: {
      pageViews: pctDelta(pageViews, prevPageViews),
      newFollowers: pctDelta(newFollowers, prevNewFollowers),
      rfqsReceived: pctDelta(rfqsReceived, prevRfqsReceived),
      quotesSent: pctDelta(quotesSent, prevQuotesSent),
      quoteWinRatePts: Math.round((quoteWinRate - prevQuoteWinRate) * 1000) / 10,
    },
    series,
    sources,
    topPosts: orgPosts.map((p) => ({ id: p.id, title: p.body ? (p.body.length > 90 ? `${p.body.slice(0, 90)}…` : p.body) : "(media post)", impressions: p.impressionCount, reactions: p.reactionCount, comments: p.commentCount, saves: p.saveCount })),
    unfollowsInPeriod: unfollows,
  };
}

export function registerCompanyAnalyticsRoutes(app: FastifyInstance, db: Db) {
  app.get("/organizations/:id/analytics", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.view_analytics");
    const q = z.object({ range: z.enum(["30", "90", "365"]).optional() }).parse(req.query);
    const days = RANGE_DAYS[q.range ?? "30"];
    const data = await buildOrgAnalytics(db, id, days);
    if (!data) throw notFound("That company");
    // postReach = total impressions across the org's posts (a real, honest number,
    // computed once here rather than inside buildOrgAnalytics's Promise.all above).
    const reach = data.topPosts.reduce((s, p) => s + p.impressions, 0);
    data.tiles.postReach = reach;
    return data;
  });

  app.get("/organizations/:id/analytics/export.csv", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.view_analytics");
    const q = z.object({ range: z.enum(["30", "90", "365"]).optional() }).parse(req.query);
    const days = RANGE_DAYS[q.range ?? "30"];
    const data = await buildOrgAnalytics(db, id, days);
    if (!data) throw notFound("That company");
    const lines = ["metric,value"];
    lines.push(`page_views,${data.tiles.pageViews}`);
    lines.push(`new_followers,${data.tiles.newFollowers}`);
    lines.push(`post_reach,${data.tiles.postReach}`);
    lines.push(`rfqs_received,${data.tiles.rfqsReceived}`);
    lines.push(`quotes_sent,${data.tiles.quotesSent}`);
    lines.push(`quote_win_rate_pct,${data.tiles.quoteWinRate}`);
    lines.push(`response_time_hours,${data.tiles.responseTimeHours ?? ""}`);
    lines.push("");
    lines.push("day,page_views");
    for (const row of data.series) lines.push(`${row.day},${row.count}`);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${id}-analytics-${days}d.csv"`);
    return lines.join("\n");
  });

  app.get("/me/analytics", async (req) => {
    const actor = requireActor(req);
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const [profileViewSeries, searchAppearances, postAgg] = await Promise.all([
      dailySeries(db, "person", actor.personId, "profile_view", since, now),
      db.analyticsEvent.count({ where: { event: "search_result_click", objectId: actor.personId, occurredAt: { gte: since } } }),
      db.post.aggregate({ where: { authorId: actor.personId, deletedAt: null }, _sum: { impressionCount: true } }),
    ]);
    return {
      profileViews: { total: profileViewSeries.reduce((s, r) => s + r.count, 0), series: profileViewSeries },
      searchAppearances,
      postImpressions: postAgg._sum.impressionCount ?? 0,
    };
  });
}
