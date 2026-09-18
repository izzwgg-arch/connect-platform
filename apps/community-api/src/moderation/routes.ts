import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { requireActor, requireStaff } from "../auth/actor.js";
import { revokeAllSessions } from "../auth/tokens.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { subscriberCount } from "../lib/realtime.js";
import { personCard, personCards } from "../profiles/cards.js";
import { orgCard, orgCards } from "../organizations/cards.js";
import { addJob } from "../core/schedulers.js";
import { caseSeverity, daysToMs, isOrgVisible, restrictionDaysFor, subjectMessage } from "./policy.js";
import { accountSignals, antispamSweep } from "./signals.js";
import { liftExpiredSuspensions } from "./jobs.js";
import { loadTarget, removeContent } from "./targets.js";
import { registerCompanyAnalyticsRoutes } from "./companyAnalytics.js";

const CASE_STATUSES = ["OPEN", "IN_REVIEW", "ACTIONED", "DISMISSED", "APPEALED"] as const;
const REPORT_REASONS = ["SPAM", "SCAM", "HARASSMENT", "IMPERSONATION", "PHISHING", "MALWARE", "FAKE_JOB", "FAKE_COMPANY", "FAKE_REVIEW", "BOT", "MASS_SOLICITATION", "OTHER"] as const;
const ACTION_KINDS = ["WARN", "RESTRICT_OUTREACH", "REMOVE_CONTENT", "SUSPEND", "BAN", "DISMISS"] as const;
const CONTENT_TYPES = ["posts", "jobs", "listings", "rfqs", "events", "groups"] as const;

// Rolling per-route response-time samples for the admin system health tile —
// capped so it never grows unbounded on a long-running api instance.
const LATENCY_CAP = 2000;
const latencies: number[] = [];
function recordLatency(ms: number) {
  latencies.push(ms);
  if (latencies.length > LATENCY_CAP) latencies.splice(0, latencies.length - LATENCY_CAP);
}
function percentile(p: number): number {
  if (!latencies.length) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return Math.round(sorted[idx]);
}

async function priorRestrictionDays(db: Db, personId: string): Promise<number | null> {
  const prior = await db.moderationAction.findFirst({
    where: { kind: "RESTRICT_OUTREACH", expiresAt: { not: null }, case: { subjectPersonId: personId }, createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) } },
    orderBy: { createdAt: "desc" },
  });
  if (!prior?.expiresAt) return null;
  return Math.max(1, Math.round((prior.expiresAt.getTime() - prior.createdAt.getTime()) / 86_400_000));
}

async function suspendPerson(db: Db, personId: string, days: number | null, reason: string, moderatorId: string) {
  const expiresAt = days ? new Date(Date.now() + daysToMs(days)) : null;
  await db.person.update({ where: { id: personId }, data: { status: "SUSPENDED" } });
  await db.restriction.create({ data: { personId, kind: "SUSPENSION", reason, expiresAt } });
  await revokeAllSessions(db, personId);
  await notify(db, { personId, kind: "moderation.action", title: "Your account is suspended", body: reason, href: "/settings/notices", actorId: moderatorId });
}

async function banPerson(db: Db, personId: string, reason: string, moderatorId: string) {
  await db.person.update({ where: { id: personId }, data: { status: "BANNED" } });
  await revokeAllSessions(db, personId);
  await db.deviceToken.deleteMany({ where: { personId } });
  await notify(db, { personId, kind: "moderation.action", title: "Your account has been banned", body: reason, href: "/settings/notices", actorId: moderatorId });
}

export function registerModerationRoutes(app: FastifyInstance, db: Db) {
  // ── org visibility guard for the two public surfaces named in the brief ──
  // A SUSPENDED/BANNED company disappears from public pages: absence and
  // refusal share the same 404 shape everywhere else in this api, so this is
  // a preHandler (global — this function receives the root app instance, the
  // same as every other domain) rather than a change inside another agent's
  // organizations/marketplace routes.
  app.addHook("preHandler", async (req) => {
    const path = req.url.split("?")[0];
    const companyMatch = path.match(/^\/public\/companies\/([^/]+)$/);
    if (companyMatch) {
      const org = await db.organization.findUnique({ where: { slug: decodeURIComponent(companyMatch[1]) }, select: { status: true } });
      if (org && !isOrgVisible(org)) throw notFound("That company");
      return;
    }
    const listingMatch = path.match(/^\/public\/listings\/([^/]+)$/);
    if (listingMatch) {
      const listing = await db.listing.findUnique({ where: { id: listingMatch[1] }, select: { organizationId: true } }).catch(() => null);
      if (listing?.organizationId) {
        const org = await db.organization.findUnique({ where: { id: listing.organizationId }, select: { status: true } });
        if (org && !isOrgVisible(org)) throw notFound("That listing");
      }
    }
  });

  app.addHook("onResponse", async (_req, reply) => {
    recordLatency(reply.elapsedTime ?? 0);
  });

  /* ═══════════════════════════ Moderation queue ═══════════════════════════ */

  app.get("/admin/moderation/cases", async (req) => {
    requireStaff(req, ["MODERATOR", "ADMIN"]);
    const q = z.object({ status: z.enum(CASE_STATUSES).optional(), reason: z.enum(REPORT_REASONS).optional(), cursor: z.string().optional(), limit: z.any().optional() }).parse(req.query);
    const take = clampLimit(q.limit, 25, 100);
    const cur = decodeCursor(q.cursor);
    const clauses: Record<string, unknown>[] = [];
    clauses.push(q.status ? { status: q.status } : { status: { in: ["OPEN", "IN_REVIEW"] } });
    if (q.reason) clauses.push({ reason: q.reason });
    if (cur) clauses.push({ OR: [{ createdAt: { lt: new Date(cur.value) } }, { createdAt: new Date(cur.value), id: { lt: cur.id } }] });

    const [rows, counts] = await Promise.all([
      db.moderationCase.findMany({ where: { AND: clauses }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1 }),
      db.moderationCase.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    const page = rows.slice(0, take);
    const nextCursor = rows.length > take ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null;

    const personIds = page.map((c) => c.subjectPersonId).filter((x): x is string => !!x);
    const orgIds = page.map((c) => c.subjectOrgId).filter((x): x is string => !!x);
    const [pCards, oCards] = await Promise.all([personCards(db, personIds), orgCards(db, orgIds)]);
    const items = await Promise.all(
      page.map(async (c) => {
        const target = await loadTarget(db, c.targetType, c.targetId);
        return {
          id: c.id,
          targetType: c.targetType,
          targetId: c.targetId,
          target: { title: target.title, href: target.href },
          subject: c.subjectPersonId ? (pCards.get(c.subjectPersonId) ?? null) : c.subjectOrgId ? (oCards.get(c.subjectOrgId) ?? null) : null,
          subjectKind: c.subjectPersonId ? "person" : c.subjectOrgId ? "organization" : null,
          reason: c.reason,
          reportCount: c.reportCount,
          signals: c.signals,
          severity: caseSeverity(c.reason),
          status: c.status,
          assignedToId: c.assignedToId,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        };
      }),
    );
    const statusCounts: Record<string, number> = Object.fromEntries(CASE_STATUSES.map((s) => [s, 0]));
    for (const g of counts) statusCounts[g.status] = g._count._all;
    return { items, nextCursor, statusCounts };
  });

  app.get("/admin/moderation/cases/:id", async (req) => {
    requireStaff(req, ["MODERATOR", "ADMIN"]);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const kase = await db.moderationCase.findUnique({ where: { id } });
    if (!kase) throw notFound("That case");

    const [reports, caseActions, auditRows, target, signals, assignedTo] = await Promise.all([
      db.report.findMany({ where: { caseId: id }, orderBy: { createdAt: "desc" } }),
      db.moderationAction.findMany({ where: { caseId: id }, orderBy: { createdAt: "desc" } }),
      db.auditLog.findMany({ where: { targetType: kase.targetType, targetId: kase.targetId }, orderBy: { createdAt: "desc" }, take: 20 }),
      loadTarget(db, kase.targetType, kase.targetId),
      kase.subjectPersonId ? accountSignals(db, kase.subjectPersonId) : Promise.resolve([]),
      kase.assignedToId ? personCard(db, kase.assignedToId) : Promise.resolve(null),
    ]);

    const priorActions = kase.subjectPersonId
      ? await db.moderationAction.findMany({ where: { caseId: { not: id }, case: { subjectPersonId: kase.subjectPersonId } }, orderBy: { createdAt: "desc" }, take: 20 })
      : kase.subjectOrgId
        ? await db.moderationAction.findMany({ where: { caseId: { not: id }, case: { subjectOrgId: kase.subjectOrgId } }, orderBy: { createdAt: "desc" }, take: 20 })
        : [];

    const actionIds = caseActions.map((a) => a.id);
    const appeals = actionIds.length ? await db.appeal.findMany({ where: { actionId: { in: actionIds } }, orderBy: { createdAt: "desc" } }) : [];

    const reporterIds = reports.map((r) => r.reporterId);
    const reporterCards = await personCards(db, reporterIds);
    const subject = kase.subjectPersonId ? await personCard(db, kase.subjectPersonId) : kase.subjectOrgId ? await orgCard(db, kase.subjectOrgId) : null;

    return {
      id: kase.id,
      targetType: kase.targetType,
      targetId: kase.targetId,
      target: { title: target.title, href: target.href },
      evidence: target.evidence,
      subject,
      subjectKind: kase.subjectPersonId ? "person" : kase.subjectOrgId ? "organization" : null,
      reason: kase.reason,
      severity: caseSeverity(kase.reason),
      status: kase.status,
      reportCount: kase.reportCount,
      signals: kase.signals,
      accountSignals: signals,
      assignedTo,
      createdAt: kase.createdAt,
      updatedAt: kase.updatedAt,
      resolvedAt: kase.resolvedAt,
      reports: reports.map((r) => ({ id: r.id, reason: r.reason, details: r.details, createdAt: r.createdAt, reporter: reporterCards.get(r.reporterId) ?? null })),
      actions: caseActions,
      priorActions,
      appeals,
      audit: auditRows,
    };
  });

  app.post("/admin/moderation/cases/:id/assign", async (req) => {
    const staff = requireStaff(req, ["MODERATOR", "ADMIN"]);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const kase = await db.moderationCase.findUnique({ where: { id } });
    if (!kase) throw notFound("That case");
    const updated = await db.moderationCase.update({ where: { id }, data: { assignedToId: staff.personId, status: kase.status === "OPEN" ? "IN_REVIEW" : kase.status } });
    await audit(db, { actorId: staff.personId, action: "moderation.case_assigned", targetType: "ModerationCase", targetId: id });
    return updated;
  });

  const actionBody = z.object({
    kind: z.enum(ACTION_KINDS),
    note: z.string().trim().min(10, "A moderator note of at least 10 characters is required."),
    userMessage: z.string().trim().max(1000).optional(),
    days: z.number().int().min(1).max(365).optional(),
  });

  app.post("/admin/moderation/cases/:id/action", async (req) => {
    const staff = requireStaff(req, ["MODERATOR", "ADMIN"]);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = actionBody.parse(req.body);
    const kase = await db.moderationCase.findUnique({ where: { id } });
    if (!kase) throw notFound("That case");

    const before = { status: kase.status };
    let expiresAt: Date | null = null;
    let effectSummary: Record<string, unknown> = {};
    let nextStatus: "ACTIONED" | "DISMISSED" = "ACTIONED";

    switch (body.kind) {
      case "DISMISS": {
        nextStatus = "DISMISSED";
        break;
      }
      case "WARN": {
        if (!kase.subjectPersonId) throw badRequest("no_subject_person", "This case has no person to warn.");
        await notify(db, { personId: kase.subjectPersonId, kind: "moderation.action", title: "A moderator reviewed your account", body: subjectMessage("WARN", body.userMessage), href: "/settings/notices", actorId: staff.personId });
        break;
      }
      case "RESTRICT_OUTREACH": {
        if (!kase.subjectPersonId) throw badRequest("no_subject_person", "This case has no person to restrict.");
        const priorDays = await priorRestrictionDays(db, kase.subjectPersonId);
        const days = restrictionDaysFor(body.days ?? 7, priorDays);
        expiresAt = new Date(Date.now() + daysToMs(days));
        const reason = subjectMessage("RESTRICT_OUTREACH", body.userMessage, days);
        await db.restriction.create({ data: { personId: kase.subjectPersonId, kind: "OUTREACH", reason, expiresAt } });
        await notify(db, { personId: kase.subjectPersonId, kind: "moderation.action", title: "Outreach restricted", body: reason, href: "/settings/notices", actorId: staff.personId });
        effectSummary = { days, doubled: priorDays != null };
        break;
      }
      case "REMOVE_CONTENT": {
        await removeContent(db, kase.targetType, kase.targetId, staff.personId);
        break;
      }
      case "SUSPEND": {
        const reason = subjectMessage("SUSPEND", body.userMessage, body.days ?? null);
        if (kase.subjectPersonId) {
          await suspendPerson(db, kase.subjectPersonId, body.days ?? null, reason, staff.personId);
          expiresAt = body.days ? new Date(Date.now() + daysToMs(body.days)) : null;
        } else if (kase.subjectOrgId) {
          await db.organization.update({ where: { id: kase.subjectOrgId }, data: { status: "SUSPENDED" } });
        } else {
          throw badRequest("no_subject", "This case has no person or company to suspend.");
        }
        break;
      }
      case "BAN": {
        const reason = subjectMessage("BAN", body.userMessage);
        if (kase.subjectPersonId) {
          await banPerson(db, kase.subjectPersonId, reason, staff.personId);
        } else if (kase.subjectOrgId) {
          await db.organization.update({ where: { id: kase.subjectOrgId }, data: { status: "BANNED" } });
        } else {
          throw badRequest("no_subject", "This case has no person or company to ban.");
        }
        break;
      }
    }

    await db.moderationCase.update({ where: { id }, data: { status: nextStatus, resolvedAt: new Date() } });
    const action = await db.moderationAction.create({ data: { caseId: id, moderatorId: staff.personId, kind: body.kind, note: body.note, userMessage: body.userMessage ?? null, expiresAt } });
    await audit(db, {
      actorId: staff.personId,
      action: `moderation.${body.kind.toLowerCase()}`,
      targetType: kase.targetType,
      targetId: kase.targetId,
      organizationId: kase.subjectOrgId,
      before,
      after: { status: nextStatus, kind: body.kind, ...effectSummary },
    });

    const updated = await db.moderationCase.findUnique({ where: { id } });
    return { case: updated, action };
  });

  /* ═══════════════════════════════ Appeals ═══════════════════════════════ */

  app.post("/appeals", async (req, reply) => {
    const actor = requireActor(req);
    const body = z.object({ actionId: z.string().min(1), body: z.string().trim().min(10).max(2000) }).parse(req.body);
    const action = await db.moderationAction.findUnique({ where: { id: body.actionId } });
    if (!action) throw notFound("That action");
    const kase = await db.moderationCase.findUnique({ where: { id: action.caseId } });
    if (!kase || kase.subjectPersonId !== actor.personId) throw forbidden("You can only appeal an action taken on your own account.");
    const existing = await db.appeal.findFirst({ where: { actionId: body.actionId, personId: actor.personId } });
    if (existing) throw conflict("already_appealed", "You already filed an appeal for this.");
    const appeal = await db.appeal.create({ data: { personId: actor.personId, actionId: body.actionId, body: body.body } });
    await db.moderationCase.update({ where: { id: action.caseId }, data: { status: "APPEALED" } });
    await audit(db, { actorId: actor.personId, action: "moderation.appeal_filed", targetType: "ModerationCase", targetId: action.caseId });
    reply.status(201);
    return appeal;
  });

  app.get("/me/moderation", async (req) => {
    const actor = requireActor(req);
    const [actions, restrictions, appeals] = await Promise.all([
      db.moderationAction.findMany({ where: { case: { subjectPersonId: actor.personId } }, orderBy: { createdAt: "desc" } }),
      db.restriction.findMany({ where: { personId: actor.personId }, orderBy: { createdAt: "desc" } }),
      db.appeal.findMany({ where: { personId: actor.personId }, orderBy: { createdAt: "desc" } }),
    ]);
    const appealedActionIds = new Set(appeals.map((a) => a.actionId));
    return {
      actions: actions
        .filter((a) => !["APPEAL_GRANTED", "APPEAL_DENIED", "NOTE"].includes(a.kind))
        .map((a) => ({ id: a.id, kind: a.kind, message: subjectMessage(a.kind, a.userMessage), createdAt: a.createdAt, expiresAt: a.expiresAt, canAppeal: !appealedActionIds.has(a.id) })),
      restrictions: restrictions
        .filter((r) => !r.expiresAt || r.expiresAt > new Date())
        .map((r) => ({ kind: r.kind, reason: r.reason, expiresAt: r.expiresAt })),
      appeals: appeals.map((a) => ({ id: a.id, actionId: a.actionId, body: a.body, decision: a.decision, decidedAt: a.decidedAt, createdAt: a.createdAt })),
    };
  });

  app.post("/admin/moderation/appeals/:id/decide", async (req) => {
    const staff = requireStaff(req, ["MODERATOR", "ADMIN"]);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ decision: z.enum(["GRANTED", "DENIED"]), note: z.string().trim().min(1).max(1000) }).parse(req.body);
    const appeal = await db.appeal.findUnique({ where: { id } });
    if (!appeal) throw notFound("That appeal");
    if (appeal.decidedAt) throw conflict("already_decided", "That appeal was already decided.");
    const action = await db.moderationAction.findUnique({ where: { id: appeal.actionId } });
    if (!action) throw notFound("That action");

    if (body.decision === "GRANTED") {
      if (action.kind === "RESTRICT_OUTREACH") {
        await db.restriction.updateMany({ where: { personId: appeal.personId, kind: "OUTREACH", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, data: { expiresAt: new Date() } });
      } else if (action.kind === "SUSPEND") {
        await db.restriction.updateMany({ where: { personId: appeal.personId, kind: "SUSPENSION", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, data: { expiresAt: new Date() } });
        await db.person.update({ where: { id: appeal.personId }, data: { status: "ACTIVE" } });
      } else if (action.kind === "BAN") {
        await db.person.update({ where: { id: appeal.personId }, data: { status: "ACTIVE" } });
      }
      await notify(db, { personId: appeal.personId, kind: "moderation.action", title: "Your appeal was granted", body: body.note, href: "/settings/notices", actorId: staff.personId });
    } else {
      await notify(db, { personId: appeal.personId, kind: "moderation.action", title: "Your appeal was denied", body: body.note, href: "/settings/notices", actorId: staff.personId });
    }

    const updated = await db.appeal.update({ where: { id }, data: { decidedAt: new Date(), decision: body.decision } });
    await db.moderationAction.create({ data: { caseId: action.caseId, moderatorId: staff.personId, kind: body.decision === "GRANTED" ? "APPEAL_GRANTED" : "APPEAL_DENIED", note: body.note } });
    await db.moderationCase.update({ where: { id: action.caseId }, data: { status: "ACTIONED", resolvedAt: new Date() } });
    await audit(db, { actorId: staff.personId, action: "moderation.appeal_decided", targetType: "Appeal", targetId: id, after: { decision: body.decision } });
    return updated;
  });

  /* ═══════════════════════ Admin control center ═══════════════════════ */

  app.get("/admin/overview", async (req) => {
    requireStaff(req, ["MODERATOR", "ADMIN"]);
    const t0 = Date.now();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const dayAgo = new Date(Date.now() - 86_400_000);

    const [
      byPersonStatus,
      orgCount,
      openCases,
      pendingVerifications,
      openRfqs,
      openJobs,
      upcomingEvents,
      groupCount,
      activeListings,
      reports24h,
      signups7d,
      pendingPush,
      scheduledPosts,
      mailSent24h,
      deviceVersions,
    ] = await Promise.all([
      db.person.groupBy({ by: ["status"], _count: { _all: true } }),
      db.organization.count(),
      db.moderationCase.count({ where: { status: { in: ["OPEN", "IN_REVIEW"] } } }),
      db.verification.count({ where: { status: "PENDING" } }),
      db.rfq.count({ where: { status: "OPEN" } }),
      db.job.count({ where: { status: "OPEN" } }),
      db.event.count({ where: { startsAt: { gte: new Date() } } }),
      db.group.count(),
      db.listing.count({ where: { status: "ACTIVE" } }),
      db.report.count({ where: { createdAt: { gte: dayAgo } } }),
      db.person.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      db.notification.count({ where: { pushedAt: null } }),
      db.scheduledPost.count({ where: { publishedPostId: null } }),
      db.outboundMail.count({ where: { createdAt: { gte: dayAgo } } }).catch(() => 0),
      db.deviceToken.findMany({ where: { lastSeenAt: { gte: sevenDaysAgo } }, distinct: ["appVersion", "platform"], select: { appVersion: true, platform: true } }),
    ]);
    const dbMs = Date.now() - t0;

    const personStatusCounts: Record<string, number> = {};
    for (const g of byPersonStatus) personStatusCounts[g.status] = g._count._all;

    return {
      counts: {
        peopleByStatus: personStatusCounts,
        organizations: orgCount,
        openCases,
        pendingVerifications,
        openRfqs,
        openJobs,
        upcomingEvents,
        groups: groupCount,
        activeListings,
        reports24h,
        signups7d,
      },
      systemHealth: {
        dbMs,
        sockets: subscriberCount(),
        apiP50Ms: percentile(50),
        apiP95Ms: percentile(95),
        sampleSize: latencies.length,
        queues: { pendingPush, scheduledPosts, mailSent24h },
      },
      mobileVersions: deviceVersions.filter((d) => d.appVersion).map((d) => ({ platform: d.platform, appVersion: d.appVersion })),
    };
  });

  app.get("/admin/users", async (req) => {
    requireStaff(req, ["MODERATOR", "ADMIN"]);
    const q = z.object({ q: z.string().trim().optional(), status: z.enum(["ACTIVE", "DEACTIVATED", "PENDING_DELETION", "SUSPENDED", "BANNED"]).optional(), cursor: z.string().optional(), limit: z.any().optional() }).parse(req.query);
    const take = clampLimit(q.limit, 25, 100);
    const cur = decodeCursor(q.cursor);
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.q) {
      where.OR = [{ username: { contains: q.q, mode: "insensitive" as const } }, { email: { contains: q.q, mode: "insensitive" as const } }, { profile: { OR: [{ firstName: { contains: q.q, mode: "insensitive" as const } }, { lastName: { contains: q.q, mode: "insensitive" as const } }] } }];
    }
    if (cur) where.AND = [{ OR: [{ createdAt: { lt: new Date(cur.value) } }, { createdAt: new Date(cur.value), id: { lt: cur.id } }] }];
    const rows = await db.person.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1, select: { id: true, username: true, email: true, status: true, createdAt: true } });
    const page = rows.slice(0, take);
    const nextCursor = rows.length > take ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null;
    const ids = page.map((p) => p.id);
    const [cards, staffGrants, verifications] = await Promise.all([
      personCards(db, ids),
      db.staffGrant.findMany({ where: { personId: { in: ids } } }),
      db.verification.findMany({ where: { personId: { in: ids }, status: "VERIFIED" }, select: { personId: true, kind: true } }),
    ]);
    const items = page.map((p) => ({
      ...(cards.get(p.id) ?? { id: p.id, username: p.username, name: p.username }),
      email: p.email,
      status: p.status,
      createdAt: p.createdAt,
      staffRole: staffGrants.find((s) => s.personId === p.id)?.role ?? null,
      verified: verifications.filter((v) => v.personId === p.id).map((v) => v.kind),
    }));
    return { items, nextCursor };
  });

  app.get("/admin/users/:id", async (req) => {
    requireStaff(req, ["MODERATOR", "ADMIN"]);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const person = await db.person.findUnique({ where: { id }, select: { id: true, username: true, email: true, phoneE164: true, status: true, createdAt: true, loopcomTenantId: true } });
    if (!person) throw notFound("That person");
    const [card, sessionsCount, restrictions, actions, memberships, staffGrant, auditRows] = await Promise.all([
      personCard(db, id),
      db.session.count({ where: { personId: id, revokedAt: null, expiresAt: { gt: new Date() } } }),
      db.restriction.findMany({ where: { personId: id }, orderBy: { createdAt: "desc" } }),
      db.moderationAction.findMany({ where: { case: { subjectPersonId: id } }, orderBy: { createdAt: "desc" }, take: 20 }),
      db.membership.findMany({ where: { personId: id }, include: { organization: { select: { id: true, slug: true, displayName: true } } } }),
      db.staffGrant.findUnique({ where: { personId: id } }),
      db.auditLog.findMany({ where: { OR: [{ actorId: id }, { targetType: "Person", targetId: id }] }, orderBy: { createdAt: "desc" }, take: 30 }),
    ]);
    return { person: { ...person, ...card }, sessionsCount, restrictions, actions, memberships, staffRole: staffGrant?.role ?? null, audit: auditRows };
  });

  app.post("/admin/users/:id/status", async (req) => {
    const staff = requireStaff(req, ["ADMIN"]);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "BANNED"]), note: z.string().trim().min(5) }).parse(req.body);
    const existing = await db.person.findUnique({ where: { id }, select: { status: true } });
    if (!existing) throw notFound("That person");
    await db.person.update({ where: { id }, data: { status: body.status } });
    if (body.status !== "ACTIVE") {
      await revokeAllSessions(db, id);
      await notify(db, { personId: id, kind: "moderation.action", title: body.status === "BANNED" ? "Your account has been banned" : "Your account is suspended", body: body.note, href: "/settings/notices", actorId: staff.personId });
    } else {
      await notify(db, { personId: id, kind: "moderation.action", title: "Your account is active again", body: body.note, href: "/settings/notices", actorId: staff.personId });
    }
    await audit(db, { actorId: staff.personId, action: "admin.user_status_changed", targetType: "Person", targetId: id, before: { status: existing.status }, after: { status: body.status, note: body.note } });
    return { ok: true, status: body.status };
  });

  app.post("/admin/users/:id/staff", async (req) => {
    const staff = requireStaff(req, ["ADMIN"]);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ role: z.enum(["MODERATOR", "ADMIN"]).nullable() }).parse(req.body);
    const existing = await db.staffGrant.findUnique({ where: { personId: id } });
    if (body.role) {
      await db.staffGrant.upsert({ where: { personId: id }, create: { personId: id, role: body.role, grantedById: staff.personId }, update: { role: body.role, grantedById: staff.personId } });
    } else {
      await db.staffGrant.deleteMany({ where: { personId: id } });
    }
    await audit(db, { actorId: staff.personId, action: "admin.staff_role_changed", targetType: "Person", targetId: id, before: { role: existing?.role ?? null }, after: { role: body.role } });
    return { ok: true, role: body.role };
  });

  app.post("/admin/users/:id/verify-email", async (req) => {
    const staff = requireStaff(req, ["ADMIN"]);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const person = await db.person.findUnique({ where: { id }, select: { email: true, emailVerifiedAt: true } });
    if (!person) throw notFound("That person");
    if (!person.email) throw badRequest("no_email", "That person hasn't added an email address.");
    await db.person.update({ where: { id }, data: { emailVerifiedAt: new Date() } });
    await audit(db, { actorId: staff.personId, action: "admin.email_manually_verified", targetType: "Person", targetId: id, before: { emailVerifiedAt: person.emailVerifiedAt }, after: { emailVerifiedAt: new Date() } });
    return { ok: true };
  });

  app.get("/admin/organizations", async (req) => {
    requireStaff(req, ["MODERATOR", "ADMIN"]);
    const q = z.object({ q: z.string().trim().optional(), status: z.string().optional(), cursor: z.string().optional(), limit: z.any().optional() }).parse(req.query);
    const take = clampLimit(q.limit, 25, 100);
    const cur = decodeCursor(q.cursor);
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.q) where.displayName = { contains: q.q, mode: "insensitive" as const };
    if (cur) where.AND = [{ OR: [{ createdAt: { lt: new Date(cur.value) } }, { createdAt: new Date(cur.value), id: { lt: cur.id } }] }];
    const rows = await db.organization.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1, select: { id: true, createdAt: true, status: true } });
    const page = rows.slice(0, take);
    const nextCursor = rows.length > take ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null;
    const cards = await orgCards(db, page.map((o) => o.id));
    return { items: page.map((o) => ({ ...(cards.get(o.id) ?? { id: o.id }), status: o.status, createdAt: o.createdAt })), nextCursor };
  });

  app.post("/admin/organizations/:id/status", async (req) => {
    const staff = requireStaff(req, ["ADMIN"]);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "BANNED"]), note: z.string().trim().min(5) }).parse(req.body);
    const existing = await db.organization.findUnique({ where: { id }, select: { status: true } });
    if (!existing) throw notFound("That company");
    await db.organization.update({ where: { id }, data: { status: body.status } });
    await audit(db, { actorId: staff.personId, action: "admin.org_status_changed", targetType: "Organization", targetId: id, organizationId: id, before: { status: existing.status }, after: { status: body.status, note: body.note } });
    return { ok: true, status: body.status };
  });

  app.get("/admin/content", async (req) => {
    requireStaff(req, ["MODERATOR", "ADMIN"]);
    const q = z.object({ type: z.enum(CONTENT_TYPES), q: z.string().trim().optional(), cursor: z.string().optional(), limit: z.any().optional() }).parse(req.query);
    const take = clampLimit(q.limit, 25, 100);
    const cur = decodeCursor(q.cursor);
    const cursorClause = cur ? { OR: [{ createdAt: { lt: new Date(cur.value) } }, { createdAt: new Date(cur.value), id: { lt: cur.id } }] } : {};

    switch (q.type) {
      case "posts": {
        const where = { AND: [{ deletedAt: null }, cursorClause, q.q ? { body: { contains: q.q, mode: "insensitive" as const } } : {}] };
        const rows = await db.post.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1, select: { id: true, body: true, authorId: true, createdAt: true } });
        return listResult(rows, take, (r) => ({ id: r.id, title: r.body?.slice(0, 120) || "(media post)", authorId: r.authorId, createdAt: r.createdAt }));
      }
      case "jobs": {
        const where = { AND: [cursorClause, q.q ? { title: { contains: q.q, mode: "insensitive" as const } } : {}] };
        const rows = await db.job.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1, select: { id: true, title: true, status: true, organizationId: true, createdAt: true } });
        return listResult(rows, take, (r) => ({ id: r.id, title: r.title, status: r.status, organizationId: r.organizationId, createdAt: r.createdAt }));
      }
      case "listings": {
        const where = { AND: [cursorClause, q.q ? { title: { contains: q.q, mode: "insensitive" as const } } : {}] };
        const rows = await db.listing.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1, select: { id: true, title: true, status: true, sellerPersonId: true, createdAt: true } });
        return listResult(rows, take, (r) => ({ id: r.id, title: r.title, status: r.status, sellerPersonId: r.sellerPersonId, createdAt: r.createdAt }));
      }
      case "rfqs": {
        const where = { AND: [cursorClause, q.q ? { title: { contains: q.q, mode: "insensitive" as const } } : {}] };
        const rows = await db.rfq.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1, select: { id: true, title: true, status: true, buyerPersonId: true, createdAt: true } });
        return listResult(rows, take, (r) => ({ id: r.id, title: r.title, status: r.status, buyerPersonId: r.buyerPersonId, createdAt: r.createdAt }));
      }
      case "events": {
        const where = { AND: [cursorClause, q.q ? { title: { contains: q.q, mode: "insensitive" as const } } : {}] };
        const rows = await db.event.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1, select: { id: true, title: true, hostId: true, createdAt: true } });
        return listResult(rows, take, (r) => ({ id: r.id, title: r.title, hostId: r.hostId, createdAt: r.createdAt }));
      }
      case "groups": {
        const where = { AND: [cursorClause, q.q ? { name: { contains: q.q, mode: "insensitive" as const } } : {}] };
        const rows = await db.group.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1, select: { id: true, name: true, createdAt: true } });
        return listResult(rows, take, (r) => ({ id: r.id, title: r.name, createdAt: r.createdAt }));
      }
    }
  });

  app.post("/admin/content/remove", async (req) => {
    const staff = requireStaff(req, ["MODERATOR", "ADMIN"]);
    const body = z.object({ targetType: z.string(), targetId: z.string(), note: z.string().trim().min(10) }).parse(req.body);
    // One step: open (or reuse) a case for the target, action REMOVE_CONTENT on it, resolve it.
    const openCase = await db.moderationCase.findFirst({ where: { targetType: body.targetType, targetId: body.targetId, status: { in: ["OPEN", "IN_REVIEW"] } } });
    const kase =
      openCase ??
      (await db.moderationCase.create({ data: { targetType: body.targetType, targetId: body.targetId, reason: "OTHER", reportCount: 0, signals: { source: "admin_content" } } }));
    await removeContent(db, body.targetType, body.targetId, staff.personId);
    await db.moderationCase.update({ where: { id: kase.id }, data: { status: "ACTIONED", resolvedAt: new Date() } });
    const action = await db.moderationAction.create({ data: { caseId: kase.id, moderatorId: staff.personId, kind: "REMOVE_CONTENT", note: body.note } });
    await audit(db, { actorId: staff.personId, action: "moderation.remove_content", targetType: body.targetType, targetId: body.targetId });
    return { ok: true, caseId: kase.id, actionId: action.id };
  });

  app.get("/admin/audit", async (req) => {
    requireStaff(req, ["MODERATOR", "ADMIN"]);
    const q = z.object({ actorId: z.string().optional(), targetType: z.string().optional(), cursor: z.string().optional(), limit: z.any().optional() }).parse(req.query);
    const take = clampLimit(q.limit, 40, 150);
    const cur = decodeCursor(q.cursor);
    const clauses: Record<string, unknown>[] = [];
    if (q.actorId) clauses.push({ actorId: q.actorId });
    if (q.targetType) clauses.push({ targetType: q.targetType });
    if (cur) clauses.push({ OR: [{ createdAt: { lt: new Date(cur.value) } }, { createdAt: new Date(cur.value), id: { lt: cur.id } }] });
    const rows = await db.auditLog.findMany({ where: clauses.length ? { AND: clauses } : {}, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1 });
    const page = rows.slice(0, take);
    const nextCursor = rows.length > take ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null;
    const actorCards = await personCards(db, page.map((r) => r.actorId).filter((x): x is string => !!x));
    return { items: page.map((r) => ({ ...r, actor: r.actorId ? (actorCards.get(r.actorId) ?? null) : null })), nextCursor };
  });

  app.get("/admin/notifications/health", async (req) => {
    requireStaff(req, ["MODERATOR", "ADMIN"]);
    const dayAgo = new Date(Date.now() - 86_400_000);
    const [byKind, pendingPush, deadTokens] = await Promise.all([
      db.notification.groupBy({ by: ["kind"], where: { createdAt: { gte: dayAgo } }, _count: { _all: true } }),
      db.notification.count({ where: { pushedAt: null } }),
      db.deviceToken.count({ where: { lastSeenAt: { lt: new Date(Date.now() - 90 * 86_400_000) } } }),
    ]);
    const rows = await Promise.all(
      byKind.map(async (g) => {
        const [emailed, pushed] = await Promise.all([
          db.notification.count({ where: { kind: g.kind, createdAt: { gte: dayAgo }, emailedAt: { not: null } } }),
          db.notification.count({ where: { kind: g.kind, createdAt: { gte: dayAgo }, pushedAt: { not: null } } }),
        ]);
        return { kind: g.kind, sent: g._count._all, emailed, pushed };
      }),
    );
    return { last24h: rows, pendingPush, staleDeviceTokens: deadTokens };
  });

  app.get("/admin/security/alerts", async (req) => {
    requireStaff(req, ["MODERATOR", "ADMIN"]);
    const dayAgo = new Date(Date.now() - 86_400_000);
    const rows = await db.auditLog.findMany({ where: { createdAt: { gte: dayAgo }, action: { in: ["person.login_failed", "person.password_reset", "person.password_change"] } }, orderBy: { createdAt: "desc" }, take: 300 });
    const byAction: Record<string, number> = {};
    const byIp: Record<string, number> = {};
    for (const r of rows) {
      byAction[r.action] = (byAction[r.action] ?? 0) + 1;
      if (r.ip) byIp[r.ip] = (byIp[r.ip] ?? 0) + 1;
    }
    const spikeIps = Object.entries(byIp).filter(([, n]) => n >= 5).map(([ip, count]) => ({ ip, count }));
    return { last24h: byAction, spikeIps, sample: rows.slice(0, 50) };
  });

  /* ═══════════════════════════ Company analytics ═══════════════════════════ */
  registerCompanyAnalyticsRoutes(app, db);

  /* ═══════════════════════════════ Schedulers ═══════════════════════════════ */
  addJob({ name: "antispam.sweep", everyMs: 15 * 60_000, run: antispamSweep });
  addJob({ name: "moderation.lift", everyMs: 10 * 60_000, run: liftExpiredSuspensions });
}

function listResult<T extends { id: string; createdAt: Date }>(rows: T[], take: number, map: (r: T) => Record<string, unknown>) {
  const page = rows.slice(0, take);
  const nextCursor = rows.length > take ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null;
  return { items: page.map(map), nextCursor };
}
