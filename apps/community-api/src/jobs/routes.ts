import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { env } from "../env.js";
import { requireActor } from "../auth/actor.js";
import { requireVerifiedActor } from "../auth/guards.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { track } from "../lib/analytics.js";
import { buildSearchText, ftsIds } from "../lib/search.js";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { signMediaUrl } from "../media/service.js";
import { personCard, personCards, type PersonCard } from "../profiles/cards.js";
import { orgCard, orgCards } from "../organizations/cards.js";
import { permissionsForMembership, requireOrgPermission } from "../organizations/permissions.js";
import { connectionIds, degreeBetween, isBlockedEitherWay, pairKey } from "../policy/graph.js";
import { findOrCreateDirectThread, sendMessage } from "../messaging/service.js";
import { addJob } from "../core/schedulers.js";
import {
  EARLY_APPLICANT_THRESHOLD,
  EMPLOYMENT_TYPES,
  PROFILE_SECTIONS,
  PROMOTE_MAX_DAYS,
  PROMOTE_MIN_DAYS,
  SALARY_PERIODS,
  VERIFIED_AFFILIATIONS,
  WORK_MODES,
  buildProfileSnapshot,
  isEarlyApplicant,
  isPromoted,
  promotedUntilFrom,
  referralAskMessage,
  stageNotification,
  type ProfileSection,
} from "./policy.js";

const APPLICATION_STAGES = ["APPLIED", "REVIEWED", "INTERVIEW", "OFFER", "HIRED", "CLOSED"] as const;
type ApplicationStage = (typeof APPLICATION_STAGES)[number];

const CreateJobSchema = z.object({
  organizationId: z.string().min(1),
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().min(1).max(8000),
  location: z.string().trim().max(200).optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).default("FULL_TIME"),
  workMode: z.enum(WORK_MODES).default("ONSITE"),
  salaryMin: z.number().nonnegative().max(10_000_000).optional(),
  salaryMax: z.number().nonnegative().max(10_000_000).optional(),
  salaryPeriod: z.enum(SALARY_PERIODS).default("YEAR"),
  requirements: z.array(z.string().trim().max(200)).max(40).optional(),
  languages: z.array(z.string().trim().max(60)).max(20).optional(),
  status: z.enum(["DRAFT", "OPEN"]).default("OPEN"),
});

const PatchJobSchema = z.object({
  title: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().min(1).max(8000).optional(),
  location: z.string().trim().max(200).nullable().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  workMode: z.enum(WORK_MODES).optional(),
  salaryMin: z.number().nonnegative().max(10_000_000).nullable().optional(),
  salaryMax: z.number().nonnegative().max(10_000_000).nullable().optional(),
  salaryPeriod: z.enum(SALARY_PERIODS).optional(),
  requirements: z.array(z.string().trim().max(200)).max(40).optional(),
  languages: z.array(z.string().trim().max(60)).max(20).optional(),
});

const ApplySchema = z.object({
  sections: z.array(z.enum(PROFILE_SECTIONS)).min(1).max(PROFILE_SECTIONS.length),
  resumeAssetId: z.string().min(1).optional(),
  coverNote: z.string().trim().max(4000).optional(),
});

const jobDto = (j: {
  id: string;
  organizationId: string;
  title: string;
  description: string;
  location: string | null;
  employmentType: string;
  workMode: string;
  salaryMin: unknown;
  salaryMax: unknown;
  salaryPeriod: string;
  requirements: string[];
  languages: string[];
  status: string;
  promotedUntil: Date | null;
  applicantCount: number;
  viewCount: number;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: j.id,
  organizationId: j.organizationId,
  title: j.title,
  description: j.description,
  location: j.location,
  employmentType: j.employmentType,
  workMode: j.workMode,
  salaryMin: j.salaryMin == null ? null : String(j.salaryMin),
  salaryMax: j.salaryMax == null ? null : String(j.salaryMax),
  salaryPeriod: j.salaryPeriod,
  requirements: j.requirements,
  languages: j.languages,
  status: j.status,
  promoted: isPromoted(j.promotedUntil),
  promotedUntil: j.promotedUntil ? j.promotedUntil.toISOString() : null,
  applicantCount: j.applicantCount,
  viewCount: j.viewCount,
  earlyApplicant: isEarlyApplicant(j.applicantCount),
  closedAt: j.closedAt ? j.closedAt.toISOString() : null,
  createdAt: j.createdAt.toISOString(),
  updatedAt: j.updatedAt.toISOString(),
});

function jobSearchText(input: { title: string; description: string; orgName: string; location?: string | null; requirements?: string[] }): string {
  return buildSearchText([input.title, input.description, input.orgName, input.location, input.requirements ?? []]);
}

/** Up to 2 of the viewer's 1st-degree connections who are verified members of this org, plus the total count. */
async function peopleYouKnowHere(db: Db, viewerId: string | null, organizationId: string): Promise<{ count: number; people: PersonCard[] }> {
  if (!viewerId) return { count: 0, people: [] };
  const conns = await connectionIds(db, viewerId);
  if (!conns.length) return { count: 0, people: [] };
  const rows = await db.membership.findMany({
    where: { organizationId, personId: { in: conns }, affiliation: { in: [...VERIFIED_AFFILIATIONS] } },
    select: { personId: true },
  });
  const ids = rows.map((r) => r.personId);
  const cards = await personCards(db, ids.slice(0, 2));
  return { count: ids.length, people: ids.slice(0, 2).map((id) => cards.get(id)).filter((c): c is PersonCard => !!c) };
}

/** Batched version of peopleYouKnowHere for a list of orgs (one query instead of N). */
async function peopleYouKnowHereBatch(db: Db, viewerId: string | null, organizationIds: string[]): Promise<Map<string, { count: number; people: PersonCard[] }>> {
  const out = new Map<string, { count: number; people: PersonCard[] }>();
  const ids = [...new Set(organizationIds)];
  if (!viewerId || !ids.length) return out;
  const conns = await connectionIds(db, viewerId);
  if (!conns.length) return out;
  const rows = await db.membership.findMany({
    where: { organizationId: { in: ids }, personId: { in: conns }, affiliation: { in: [...VERIFIED_AFFILIATIONS] } },
    select: { organizationId: true, personId: true },
  });
  const byOrg = new Map<string, string[]>();
  for (const r of rows) byOrg.set(r.organizationId, [...(byOrg.get(r.organizationId) ?? []), r.personId]);
  const allPersonIds = [...new Set(rows.map((r) => r.personId))];
  const cards = await personCards(db, allPersonIds);
  for (const orgId of ids) {
    const personIds = byOrg.get(orgId) ?? [];
    out.set(orgId, { count: personIds.length, people: personIds.slice(0, 2).map((id) => cards.get(id)).filter((c): c is PersonCard => !!c) });
  }
  return out;
}

/** Org ids that carry at least one VERIFIED verification of any kind. */
async function verifiedOrgIds(db: Db, orgIds: string[]): Promise<Set<string>> {
  if (!orgIds.length) return new Set();
  const rows = await db.verification.findMany({ where: { organizationId: { in: orgIds }, status: "VERIFIED" }, select: { organizationId: true } });
  return new Set(rows.map((r) => r.organizationId!));
}

/**
 * Opens (or reuses) a DIRECT thread between a recruiter and a candidate,
 * always leaving the candidate ACTIVE — an application (or a connection, for
 * the referral-ask path) is the consent, so the ordinary stranger request cap
 * must not apply here.
 */
async function openConsentedThread(db: Db, aId: string, bId: string) {
  if (await isBlockedEitherWay(db, aId, bId)) throw notFound("That person");
  const key = pairKey(aId, bId);
  const existing = await db.thread.findUnique({ where: { pairKey: key } });
  if (existing) {
    const parts = await db.threadParticipant.findMany({ where: { threadId: existing.id } });
    for (const p of parts) {
      if (p.state !== "ACTIVE" && p.state !== "LEFT") await db.threadParticipant.update({ where: { id: p.id }, data: { state: "ACTIVE" } });
    }
    return existing;
  }
  return db.thread.create({
    data: {
      kind: "DIRECT",
      pairKey: key,
      createdById: aId,
      participants: { create: [
        { personId: aId, state: "ACTIVE", role: "MEMBER" },
        { personId: bId, state: "ACTIVE", role: "MEMBER" },
      ] },
    },
  });
}

/** Runs one sweep of job alerts: new OPEN jobs since the alert's lastRunAt matching its query + location. Exported for the scheduler and for direct test calls. */
export async function runJobAlerts(db: Db) {
  const alerts = await db.jobAlert.findMany({});
  for (const alert of alerts) {
    const since = alert.lastRunAt ?? alert.createdAt;
    const ids = (await ftsIds(db, "Job", "id", alert.query, 50)).map((r) => r.id);
    if (ids.length) {
      const matches = await db.job.findMany({
        where: {
          id: { in: ids },
          status: "OPEN",
          createdAt: { gt: since },
          ...(alert.location ? { location: { contains: alert.location, mode: "insensitive" } } : {}),
        },
        select: { id: true },
      });
      if (matches.length) {
        await notify(db, {
          personId: alert.personId,
          kind: "job.match",
          title: matches.length === 1 ? "1 new job matches your alert" : `${matches.length} new jobs match your alert`,
          body: alert.query,
          href: `/jobs?q=${encodeURIComponent(alert.query)}`,
          objectType: "JobAlert",
          objectId: alert.id,
        });
      }
    }
    await db.jobAlert.update({ where: { id: alert.id }, data: { lastRunAt: new Date() } });
  }
}

export function registerJobRoutes(app: FastifyInstance, db: Db) {
  const viewerOf = (req: FastifyRequest) => req.actor?.personId ?? null;

  /* ───────────────────────────── Create / edit / close / promote ───────────────────────────── */

  app.post("/jobs", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const input = CreateJobSchema.parse(req.body);
    if (input.salaryMin != null && input.salaryMax != null && input.salaryMin > input.salaryMax) {
      throw badRequest("invalid_salary_range", "The minimum salary can't be higher than the maximum.");
    }
    await requireOrgPermission(db, actor, input.organizationId, "org.manage_jobs");
    const org = await db.organization.findUniqueOrThrow({ where: { id: input.organizationId }, select: { displayName: true } });
    const searchText = jobSearchText({ title: input.title, description: input.description, orgName: org.displayName, location: input.location, requirements: input.requirements });

    const job = await db.job.create({
      data: {
        organizationId: input.organizationId,
        createdById: actor.personId,
        title: input.title,
        description: input.description,
        location: input.location ?? null,
        employmentType: input.employmentType,
        workMode: input.workMode,
        salaryMin: input.salaryMin ?? null,
        salaryMax: input.salaryMax ?? null,
        salaryPeriod: input.salaryPeriod,
        requirements: input.requirements ?? [],
        languages: input.languages ?? [],
        status: input.status,
        searchText,
      },
    });
    await audit(db, { actorId: actor.personId, action: "job.create", targetType: "Job", targetId: job.id, organizationId: input.organizationId, after: { title: job.title, status: job.status } });
    reply.status(201);
    return { job: jobDto(job) };
  });

  app.patch("/jobs/:id", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const input = PatchJobSchema.parse(req.body);
    const job = await db.job.findUnique({ where: { id } });
    if (!job) throw notFound("That job");
    await requireOrgPermission(db, actor, job.organizationId, "org.manage_jobs");
    const org = await db.organization.findUniqueOrThrow({ where: { id: job.organizationId }, select: { displayName: true } });

    const next = {
      title: input.title ?? job.title,
      description: input.description ?? job.description,
      location: input.location === undefined ? job.location : input.location,
      employmentType: input.employmentType ?? job.employmentType,
      workMode: input.workMode ?? job.workMode,
      salaryMin: input.salaryMin === undefined ? job.salaryMin : input.salaryMin,
      salaryMax: input.salaryMax === undefined ? job.salaryMax : input.salaryMax,
      salaryPeriod: input.salaryPeriod ?? job.salaryPeriod,
      requirements: input.requirements ?? job.requirements,
      languages: input.languages ?? job.languages,
    };
    const searchText = jobSearchText({ title: next.title, description: next.description, orgName: org.displayName, location: next.location, requirements: next.requirements });
    const updated = await db.job.update({ where: { id }, data: { ...next, searchText } });
    await audit(db, { actorId: actor.personId, action: "job.edit", targetType: "Job", targetId: id, organizationId: job.organizationId, before: { title: job.title }, after: { title: updated.title } });
    return { job: jobDto(updated) };
  });

  app.post("/jobs/:id/close", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const job = await db.job.findUnique({ where: { id } });
    if (!job) throw notFound("That job");
    await requireOrgPermission(db, actor, job.organizationId, "org.manage_jobs");
    const updated = await db.job.update({ where: { id }, data: { status: "CLOSED", closedAt: new Date() } });
    await audit(db, { actorId: actor.personId, action: "job.close", targetType: "Job", targetId: id, organizationId: job.organizationId });
    return { job: jobDto(updated) };
  });

  app.post("/jobs/:id/promote", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { days } = z.object({ days: z.number().int().min(PROMOTE_MIN_DAYS).max(PROMOTE_MAX_DAYS) }).parse(req.body);
    const job = await db.job.findUnique({ where: { id } });
    if (!job) throw notFound("That job");
    await requireOrgPermission(db, actor, job.organizationId, "org.manage_jobs");
    const promotedUntil = promotedUntilFrom(days);
    const updated = await db.job.update({ where: { id }, data: { promotedUntil } });
    await audit(db, { actorId: actor.personId, action: "job.promote", targetType: "Job", targetId: id, organizationId: job.organizationId, after: { promotedUntil, days } });
    return { job: jobDto(updated) };
  });

  app.delete("/jobs/:id", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const job = await db.job.findUnique({ where: { id } });
    if (!job) throw notFound("That job");
    await requireOrgPermission(db, actor, job.organizationId, "org.manage_jobs");
    if (job.status !== "DRAFT") throw badRequest("job_not_draft", "Close the job instead — only a draft that was never published can be deleted.");
    await db.job.delete({ where: { id } });
    await audit(db, { actorId: actor.personId, action: "job.delete", targetType: "Job", targetId: id, organizationId: job.organizationId });
    reply.status(204);
    return null;
  });

  /* ───────────────────────────── Candidate search ───────────────────────────── */

  app.get("/jobs", async (req) => {
    const actor = requireActor(req);
    const q = z
      .object({
        q: z.string().trim().max(200).optional(),
        location: z.string().trim().max(200).optional(),
        employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
        workMode: z.enum(WORK_MODES).optional(),
        salaryMin: z.coerce.number().nonnegative().optional(),
        verifiedEmployer: z.coerce.boolean().optional(),
        postedWithin: z.coerce.number().int().positive().max(365).optional(),
        language: z.string().trim().max(60).optional(),
        cursor: z.string().optional(),
        limit: z.string().optional(),
      })
      .parse(req.query);
    const limit = clampLimit(q.limit, 20, 50);

    const where: any = { status: "OPEN" };
    if (q.location) where.location = { contains: q.location, mode: "insensitive" };
    if (q.employmentType) where.employmentType = q.employmentType;
    if (q.workMode) where.workMode = q.workMode;
    if (q.salaryMin != null) where.OR = [{ salaryMin: { gte: q.salaryMin } }, { salaryMax: { gte: q.salaryMin } }];
    if (q.postedWithin) where.createdAt = { gte: new Date(Date.now() - q.postedWithin * 86_400_000) };
    if (q.language) where.languages = { has: q.language };
    if (q.verifiedEmployer) {
      const candidateOrgIds = await db.job.findMany({ where: { status: "OPEN" }, select: { organizationId: true }, distinct: ["organizationId"] });
      const verified = await verifiedOrgIds(db, candidateOrgIds.map((r) => r.organizationId));
      where.organizationId = { in: [...verified] };
    }

    let jobs: Awaited<ReturnType<typeof db.job.findMany>>;
    let nextCursor: string | null = null;
    if (q.q && q.q.length > 1) {
      const ranked = await ftsIds(db, "Job", "id", q.q, 100);
      const ids = ranked.map((r) => r.id);
      const found = ids.length ? await db.job.findMany({ where: { ...where, id: { in: ids } } }) : [];
      const order = new Map(ids.map((id, i) => [id, i]));
      jobs = found.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).slice(0, limit);
    } else {
      const cur = decodeCursor(q.cursor);
      if (cur) where.createdAt = { ...where.createdAt, lt: new Date(cur.value) };
      const rows = await db.job.findMany({ where, orderBy: { createdAt: "desc" }, take: limit + 1 });
      jobs = rows.slice(0, limit);
      nextCursor = rows.length > limit ? encodeCursor(jobs[jobs.length - 1].createdAt, jobs[jobs.length - 1].id) : null;
    }

    const orgIds = jobs.map((j) => j.organizationId);
    const [orgs, network, saved, applied] = await Promise.all([
      orgCards(db, orgIds),
      peopleYouKnowHereBatch(db, actor.personId, orgIds),
      db.jobSave.findMany({ where: { personId: actor.personId, jobId: { in: jobs.map((j) => j.id) } }, select: { jobId: true } }),
      db.jobApplication.findMany({ where: { personId: actor.personId, jobId: { in: jobs.map((j) => j.id) } }, select: { jobId: true } }),
    ]);
    const savedSet = new Set(saved.map((s) => s.jobId));
    const appliedSet = new Set(applied.map((a) => a.jobId));

    const items = jobs.map((j) => ({
      job: jobDto(j),
      organization: orgs.get(j.organizationId) ?? null,
      applicantCount: j.applicantCount,
      viewCount: j.viewCount,
      saved: savedSet.has(j.id),
      applied: appliedSet.has(j.id),
      peopleYouKnowHere: network.get(j.organizationId) ?? { count: 0, people: [] },
      earlyApplicant: isEarlyApplicant(j.applicantCount),
    }));
    return { items, nextCursor };
  });

  app.get("/public/jobs/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const viewerId = viewerOf(req);
    const job = await db.job.findUnique({ where: { id } });
    if (!job) throw notFound("That job");
    if (job.status === "DRAFT") {
      let canSee = false;
      if (viewerId) {
        try {
          await requireOrgPermission(db, req.actor!, job.organizationId, "org.manage_jobs");
          canSee = true;
        } catch {
          canSee = false;
        }
      }
      if (!canSee) throw notFound("That job");
    }
    const updated = await db.job.update({ where: { id }, data: { viewCount: { increment: 1 } } });
    await track(db, { personId: viewerId, event: "job_view", objectType: "Job", objectId: id });

    const [org, network, saved, application] = await Promise.all([
      orgCard(db, job.organizationId),
      peopleYouKnowHere(db, viewerId, job.organizationId),
      viewerId ? db.jobSave.findUnique({ where: { personId_jobId: { personId: viewerId, jobId: id } } }) : Promise.resolve(null),
      viewerId ? db.jobApplication.findUnique({ where: { jobId_personId: { jobId: id, personId: viewerId } } }) : Promise.resolve(null),
    ]);

    return {
      job: jobDto(updated),
      organization: org,
      peopleYouKnowHere: network,
      viewer: {
        signedIn: !!viewerId,
        saved: !!saved,
        applied: !!application,
        applicationStage: application?.stage ?? null,
      },
    };
  });

  /* ───────────────────────────── Apply / withdraw / mine ───────────────────────────── */

  app.post("/jobs/:id/apply", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const input = ApplySchema.parse(req.body);
    const job = await db.job.findUnique({ where: { id } });
    if (!job) throw notFound("That job");
    if (job.status !== "OPEN") throw badRequest("job_closed", "This job is no longer accepting applications.");

    const existing = await db.jobApplication.findUnique({ where: { jobId_personId: { jobId: id, personId: actor.personId } } });
    if (existing) throw conflict("already_applied", "You already applied to this job.");

    if (input.resumeAssetId) {
      const asset = await db.mediaAsset.findUnique({ where: { id: input.resumeAssetId } });
      if (!asset || asset.ownerId !== actor.personId || asset.kind !== "document" || !asset.isPrivate) {
        throw badRequest("resume_invalid", "Upload your résumé first — it needs to be a private document you own.");
      }
    }

    const profile = await db.profile.findUnique({
      where: { personId: actor.personId },
      include: { experiences: { orderBy: { sortOrder: "asc" } }, educations: true, services: true, certifications: true },
    });
    if (!profile) throw badRequest("profile_incomplete", "Fill in your profile before applying.");

    const sections = input.sections as ProfileSection[];
    const snapshot = buildProfileSnapshot(
      {
        headline: profile.headline,
        about: profile.about,
        skills: profile.skills,
        experiences: profile.experiences.map((e) => ({ companyName: e.companyName, title: e.title, startDate: e.startDate, endDate: e.endDate, isCurrent: e.isCurrent, location: e.location, description: e.description })),
        educations: profile.educations.map((e) => ({ school: e.school, degree: e.degree, field: e.field, startYear: e.startYear, endYear: e.endYear })),
        services: profile.services.map((s) => ({ name: s.name, description: s.description, priceFrom: s.priceFrom ? String(s.priceFrom) : null, priceNote: s.priceNote })),
        certifications: profile.certifications.map((c) => ({ name: c.name, issuer: c.issuer, issuedAt: c.issuedAt, expiresAt: c.expiresAt })),
      },
      sections,
    );

    const [application] = await db.$transaction([
      db.jobApplication.create({
        data: { jobId: id, personId: actor.personId, profileSnapshot: snapshot as any, resumeAssetId: input.resumeAssetId ?? null, coverNote: input.coverNote ?? null },
      }),
      db.job.update({ where: { id }, data: { applicantCount: { increment: 1 } } }),
    ]);

    const hirers = await db.membership.findMany({ where: { organizationId: job.organizationId, affiliation: { in: [...VERIFIED_AFFILIATIONS] } } });
    const applicantName = (await personCard(db, actor.personId))?.name ?? "Someone";
    for (const m of hirers) {
      if (!permissionsForMembership(m).has("org.hire")) continue;
      await notify(db, {
        personId: m.personId,
        kind: "job.application",
        title: "New application",
        body: `${applicantName} applied to ${job.title}`,
        href: `/company/hiring?job=${id}`,
        actorId: actor.personId,
        objectType: "JobApplication",
        objectId: application.id,
        groupKey: `job:${id}:applications`,
      });
    }

    await track(db, { personId: actor.personId, event: "job_apply", objectType: "Job", objectId: id });
    reply.status(201);
    return { application: { id: application.id, jobId: id, stage: application.stage, createdAt: application.createdAt.toISOString() } };
  });

  app.delete("/jobs/:id/apply", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const application = await db.jobApplication.findUnique({ where: { jobId_personId: { jobId: id, personId: actor.personId } } });
    if (!application) throw notFound("That application");
    if (application.stage === "HIRED" || application.stage === "CLOSED") throw badRequest("cant_withdraw", "This application is already decided and can't be withdrawn.");
    await db.$transaction([
      db.jobApplication.delete({ where: { id: application.id } }),
      db.job.update({ where: { id }, data: { applicantCount: { decrement: 1 } } }),
    ]);
    await audit(db, { actorId: actor.personId, action: "job.application.withdraw", targetType: "JobApplication", targetId: application.id });
    reply.status(204);
    return null;
  });

  app.get("/me/applications", async (req) => {
    const actor = requireActor(req);
    const rows = await db.jobApplication.findMany({ where: { personId: actor.personId }, orderBy: { createdAt: "desc" }, include: { job: true } });
    const orgs = await orgCards(db, rows.map((r) => r.job.organizationId));
    return {
      items: rows.map((r) => ({
        id: r.id,
        job: jobDto(r.job),
        organization: orgs.get(r.job.organizationId) ?? null,
        stage: r.stage,
        coverNote: r.coverNote,
        viewedAt: r.viewedAt ? r.viewedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  });

  /* ───────────────────────────── Saves ───────────────────────────── */

  app.post("/jobs/:id/save", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const job = await db.job.findUnique({ where: { id }, select: { id: true } });
    if (!job) throw notFound("That job");
    await db.jobSave.upsert({ where: { personId_jobId: { personId: actor.personId, jobId: id } }, create: { personId: actor.personId, jobId: id }, update: {} });
    await track(db, { personId: actor.personId, event: "save", objectType: "Job", objectId: id });
    reply.status(201);
    return { saved: true };
  });

  app.delete("/jobs/:id/save", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await db.jobSave.deleteMany({ where: { personId: actor.personId, jobId: id } });
    reply.status(204);
    return null;
  });

  app.get("/me/saved-jobs", async (req) => {
    const actor = requireActor(req);
    const rows = await db.jobSave.findMany({ where: { personId: actor.personId }, orderBy: { createdAt: "desc" }, include: { job: true } });
    const orgs = await orgCards(db, rows.map((r) => r.job.organizationId));
    return { items: rows.map((r) => ({ job: jobDto(r.job), organization: orgs.get(r.job.organizationId) ?? null, savedAt: r.createdAt.toISOString() })) };
  });

  /* ───────────────────────────── Alerts ───────────────────────────── */

  app.post("/me/job-alerts", async (req, reply) => {
    const actor = requireActor(req);
    const input = z.object({ query: z.string().trim().min(1).max(200), location: z.string().trim().max(200).optional(), filters: z.record(z.any()).optional() }).parse(req.body);
    const alert = await db.jobAlert.create({ data: { personId: actor.personId, query: input.query, location: input.location ?? null, filters: input.filters ?? undefined } });
    reply.status(201);
    return { alert: { id: alert.id, query: alert.query, location: alert.location, filters: alert.filters, createdAt: alert.createdAt.toISOString() } };
  });

  app.get("/me/job-alerts", async (req) => {
    const actor = requireActor(req);
    const rows = await db.jobAlert.findMany({ where: { personId: actor.personId }, orderBy: { createdAt: "desc" } });
    return { items: rows.map((a) => ({ id: a.id, query: a.query, location: a.location, filters: a.filters, lastRunAt: a.lastRunAt ? a.lastRunAt.toISOString() : null, createdAt: a.createdAt.toISOString() })) };
  });

  app.delete("/me/job-alerts/:id", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const alert = await db.jobAlert.findUnique({ where: { id } });
    if (!alert || alert.personId !== actor.personId) throw notFound("That alert");
    await db.jobAlert.delete({ where: { id } });
    reply.status(204);
    return null;
  });

  /* ───────────────────────────── Referral ask ───────────────────────────── */

  app.post("/jobs/:id/ask-referral", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { personId } = z.object({ personId: z.string().min(1) }).parse(req.body);
    const job = await db.job.findUnique({ where: { id } });
    if (!job) throw notFound("That job");

    const degree = await degreeBetween(db, actor.personId, personId);
    if (degree !== 1) throw forbidden("You can only ask a 1st-degree connection for a referral.");
    const membership = await db.membership.findUnique({ where: { personId_organizationId: { personId, organizationId: job.organizationId } } });
    if (!membership || !VERIFIED_AFFILIATIONS.includes(membership.affiliation as any)) {
      throw forbidden("That connection isn't a verified member of this company.");
    }

    const { thread } = await findOrCreateDirectThread(db, actor.personId, personId);
    const jobUrl = `${env().COMMUNITY_PUBLIC_URL}/jobs/${id}`;
    await sendMessage(db, actor.personId, thread.id, { kind: "TEXT", body: referralAskMessage(job.title, jobUrl) });
    return { threadId: thread.id };
  });

  /* ───────────────────────────── Employer ───────────────────────────── */

  app.get("/organizations/:id/jobs", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.manage_jobs");
    const q = z.object({ cursor: z.string().optional(), limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(q.limit, 20, 50);
    const cur = decodeCursor(q.cursor);
    const where: any = { organizationId: id };
    if (cur) where.createdAt = { lt: new Date(cur.value) };
    const rows = await db.job.findMany({ where, orderBy: { createdAt: "desc" }, take: limit + 1 });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null;
    return { items: page.map(jobDto), nextCursor };
  });

  app.get("/jobs/:id/applications", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const job = await db.job.findUnique({ where: { id } });
    if (!job) throw notFound("That job");
    await requireOrgPermission(db, actor, job.organizationId, "org.hire");
    const q = z.object({ stage: z.enum(APPLICATION_STAGES).optional() }).parse(req.query);
    const where: any = { jobId: id };
    if (q.stage) where.stage = q.stage;
    const rows = await db.jobApplication.findMany({ where, orderBy: { createdAt: "desc" } });

    const toMark = rows.filter((r) => !r.viewedAt).map((r) => r.id);
    if (toMark.length) await db.jobApplication.updateMany({ where: { id: { in: toMark } }, data: { viewedAt: new Date() } });
    const markedNow = new Set(toMark);

    const cards = await personCards(db, rows.map((r) => r.personId));
    const resumeIds = rows.map((r) => r.resumeAssetId).filter((x): x is string => !!x);
    const resumeAssets = resumeIds.length ? await db.mediaAsset.findMany({ where: { id: { in: resumeIds } } }) : [];
    const resumeById = new Map(resumeAssets.map((a) => [a.id, a]));

    return {
      items: rows.map((r) => ({
        id: r.id,
        applicant: cards.get(r.personId) ?? null,
        profileSnapshot: r.profileSnapshot,
        resumeUrl: r.resumeAssetId && resumeById.has(r.resumeAssetId) ? signMediaUrl(r.resumeAssetId, "original") : null,
        coverNote: r.coverNote,
        stage: r.stage,
        employerNotes: r.employerNotes,
        threadId: r.threadId,
        viewedAt: markedNow.has(r.id) ? new Date().toISOString() : r.viewedAt ? r.viewedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.patch("/jobs/:id/applications/:appId", async (req) => {
    const actor = requireActor(req);
    const { id, appId } = z.object({ id: z.string(), appId: z.string() }).parse(req.params);
    const input = z.object({ stage: z.enum(APPLICATION_STAGES).optional(), employerNotes: z.string().trim().max(4000).nullable().optional() }).parse(req.body);
    const job = await db.job.findUnique({ where: { id } });
    if (!job) throw notFound("That job");
    await requireOrgPermission(db, actor, job.organizationId, "org.hire");
    const application = await db.jobApplication.findUnique({ where: { id: appId } });
    if (!application || application.jobId !== id) throw notFound("That application");

    const data: any = {};
    if (input.stage) data.stage = input.stage;
    if (input.employerNotes !== undefined) data.employerNotes = input.employerNotes;
    if (!application.viewedAt) data.viewedAt = new Date();
    const updated = await db.jobApplication.update({ where: { id: appId }, data });

    if (input.stage && input.stage !== application.stage && input.stage !== "APPLIED") {
      const { title, body } = stageNotification(input.stage as any, job.title);
      await notify(db, { personId: application.personId, kind: "job.stage", title, body, href: `/me/applications`, actorId: actor.personId, objectType: "JobApplication", objectId: appId });
    }
    await audit(db, { actorId: actor.personId, action: "job.application.update", targetType: "JobApplication", targetId: appId, organizationId: job.organizationId, before: { stage: application.stage }, after: { stage: updated.stage } });
    return { application: { id: updated.id, stage: updated.stage, employerNotes: updated.employerNotes, viewedAt: updated.viewedAt ? updated.viewedAt.toISOString() : null } };
  });

  app.post("/jobs/:id/applications/:appId/message", async (req, reply) => {
    const actor = requireActor(req);
    const { id, appId } = z.object({ id: z.string(), appId: z.string() }).parse(req.params);
    const { body } = z.object({ body: z.string().trim().min(1).max(5000) }).parse(req.body);
    const job = await db.job.findUnique({ where: { id } });
    if (!job) throw notFound("That job");
    await requireOrgPermission(db, actor, job.organizationId, "org.hire");
    const application = await db.jobApplication.findUnique({ where: { id: appId } });
    if (!application || application.jobId !== id) throw notFound("That application");

    const thread = await openConsentedThread(db, actor.personId, application.personId);
    if (!application.threadId) await db.jobApplication.update({ where: { id: appId }, data: { threadId: thread.id } });
    const message = await sendMessage(db, actor.personId, thread.id, { kind: "TEXT", body });
    reply.status(201);
    return { threadId: thread.id, message };
  });

  app.get("/jobs/:id/analytics", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const job = await db.job.findUnique({ where: { id } });
    if (!job) throw notFound("That job");
    await requireOrgPermission(db, actor, job.organizationId, "org.view_analytics");
    const byStage = await db.jobApplication.groupBy({ by: ["stage"], where: { jobId: id }, _count: { _all: true } });
    const stageCounts: Record<string, number> = Object.fromEntries(APPLICATION_STAGES.map((s) => [s, 0]));
    for (const row of byStage) stageCounts[row.stage] = row._count._all;
    const applications = await db.jobApplication.count({ where: { jobId: id } });
    return {
      views: job.viewCount,
      applications,
      byStage: stageCounts,
      conversion: job.viewCount > 0 ? applications / job.viewCount : 0,
    };
  });

  addJob({ name: "jobs.alerts", everyMs: 30 * 60_000, run: runJobAlerts });
}
