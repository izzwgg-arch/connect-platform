import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { requireActor, requireStaff } from "../auth/actor.js";
import { audit } from "../lib/audit.js";
import { track } from "../lib/analytics.js";
import { clampLimit } from "../lib/pagination.js";
import { orgCards } from "../organizations/cards.js";
import { personCards } from "../profiles/cards.js";
import { hasOrgPermission, requireOrgPermission } from "../organizations/permissions.js";
import { connectionIds } from "../policy/graph.js";
import {
  introsForYou,
  candidatesForJob,
  customersYouMayWant,
  eventsForYou,
  groupsForYou,
  INDUSTRY_ADJACENCY,
  jobsYouMayLike,
  ninetyDaysAgo,
  organizationsYouMayNeed,
  vendorsForRfq,
  type RecoItem,
} from "./models.js";
import { assignVariant, EXPERIMENT_REQUIRED_FIELDS } from "./experiments.js";

const MODEL_BY_SURFACE: Record<string, string> = {
  organizations: "byn-v1",
  customers: "cymw-v1",
  jobs: "jyml-v1",
  candidates: "cand-v1",
  groups: "groups-v1",
  events: "events-v1",
  vendors: "vendors-v1",
};

async function dismissedIds(db: Db, personId: string, model: string, objectType: string): Promise<Set<string>> {
  const rows = await db.recommendationImpression.findMany({
    where: { personId, model, objectType, outcome: "dismissed", createdAt: { gte: ninetyDaysAgo() } },
    select: { objectId: true },
  });
  return new Set(rows.map((r) => r.objectId));
}

/** Persists one impression per item (position = rank) and returns the item plus its recommendationId. */
async function recordImpressions(db: Db, personId: string, surface: string, model: string, items: RecoItem[]) {
  const out: Array<RecoItem & { recommendationId: string }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const impression = await db.recommendationImpression.create({
      data: { personId, surface, model, objectType: item.objectType, objectId: item.objectId, reason: item.reason, position: i },
    });
    out.push({ ...item, recommendationId: impression.id });
  }
  return out;
}

export function registerRecommendationRoutes(app: FastifyInstance, db: Db) {
  /* ─────────────────────────── organizations you may need ─────────────────────────── */

  app.get("/recommendations/organizations", async (req) => {
    const actor = requireActor(req);
    const { limit: rawLimit } = z.object({ limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(rawLimit, 8, 30);
    const excludeIds = await dismissedIds(db, actor.personId, "byn-v1", "Organization");
    const raw = await organizationsYouMayNeed(db, actor.personId, { excludeIds, limit });
    const withImpressions = await recordImpressions(db, actor.personId, "byn", "byn-v1", raw);
    const cards = await orgCards(db, withImpressions.map((r) => r.objectId));
    const organizations = withImpressions
      .map((r) => {
        const card = cards.get(r.objectId);
        return card ? { ...card, reason: r.reason, recommendationId: r.recommendationId } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    return { organizations };
  });

  /* ─────────────────────────── customers you may want ─────────────────────────── */

  app.get("/recommendations/customers", async (req) => {
    const actor = requireActor(req);
    const { limit: rawLimit } = z.object({ limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(rawLimit, 8, 30);
    const excludeIds = await dismissedIds(db, actor.personId, "cymw-v1", "Person");
    const excludeOrgIds = await dismissedIds(db, actor.personId, "cymw-v1", "Organization");
    for (const id of excludeOrgIds) excludeIds.add(id);
    const raw = await customersYouMayWant(db, actor.personId, { excludeIds, limit });
    const withImpressions = await recordImpressions(db, actor.personId, "cymw", "cymw-v1", raw);
    const personIds = withImpressions.filter((r) => r.objectType === "Person").map((r) => r.objectId);
    const orgIds = withImpressions.filter((r) => r.objectType === "Organization").map((r) => r.objectId);
    const [pCards, oCards] = await Promise.all([personCards(db, personIds), orgCards(db, orgIds)]);
    const customers = withImpressions
      .map((r) => {
        if (r.objectType === "Person") {
          const c = pCards.get(r.objectId);
          return c ? { type: "person" as const, person: c, reason: r.reason, recommendationId: r.recommendationId } : null;
        }
        const c = oCards.get(r.objectId);
        return c ? { type: "organization" as const, organization: c, reason: r.reason, recommendationId: r.recommendationId } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    return { customers };
  });

  /* ─────────────────────────── jobs you may like ─────────────────────────── */

  app.get("/recommendations/jobs", async (req) => {
    const actor = requireActor(req);
    const { limit: rawLimit } = z.object({ limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(rawLimit, 8, 30);
    const excludeIds = await dismissedIds(db, actor.personId, "jyml-v1", "Job");
    const raw = await jobsYouMayLike(db, actor.personId, { excludeIds, limit });
    const withImpressions = await recordImpressions(db, actor.personId, "jyml", "jyml-v1", raw);
    const jobRows = withImpressions.length
      ? await db.job.findMany({
          where: { id: { in: withImpressions.map((r) => r.objectId) } },
          select: { id: true, title: true, location: true, employmentType: true, workMode: true, salaryMin: true, salaryMax: true, salaryPeriod: true, organization: { select: { id: true, slug: true, displayName: true, logoAssetId: true } } },
        })
      : [];
    const byId = new Map(jobRows.map((j) => [j.id, j]));
    const jobs = withImpressions
      .map((r) => {
        const j = byId.get(r.objectId);
        if (!j) return null;
        return {
          id: j.id,
          title: j.title,
          location: j.location,
          employmentType: j.employmentType,
          workMode: j.workMode,
          salaryMin: j.salaryMin ? j.salaryMin.toString() : null,
          salaryMax: j.salaryMax ? j.salaryMax.toString() : null,
          salaryPeriod: j.salaryPeriod,
          organization: j.organization,
          reason: r.reason,
          recommendationId: r.recommendationId,
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    return { jobs };
  });

  /* ─────────────────────────── candidates for a job (recruiters only) ─────────────────────────── */

  app.get("/recommendations/candidates", async (req) => {
    const actor = requireActor(req);
    const { jobId, limit: rawLimit } = z.object({ jobId: z.string().min(1), limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(rawLimit, 8, 30);
    const job = await db.job.findUnique({ where: { id: jobId }, select: { id: true, organizationId: true } });
    if (!job) throw notFound("That job");
    await requireOrgPermission(db, actor, job.organizationId, "org.hire");
    const excludeIds = await dismissedIds(db, actor.personId, "cand-v1", "Person");
    const raw = await candidatesForJob(db, jobId, { excludeIds, limit });
    const withImpressions = await recordImpressions(db, actor.personId, "cand", "cand-v1", raw);
    const cards = await personCards(db, withImpressions.map((r) => r.objectId));
    const candidates = withImpressions
      .map((r) => {
        const c = cards.get(r.objectId);
        return c ? { ...c, reason: r.reason, recommendationId: r.recommendationId } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    return { candidates };
  });

  /* ─────────────────────────── groups & events for you ─────────────────────────── */

  app.get("/recommendations/groups", async (req) => {
    const actor = requireActor(req);
    const { limit: rawLimit } = z.object({ limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(rawLimit, 6, 20);
    const excludeIds = await dismissedIds(db, actor.personId, "groups-v1", "Group");
    const raw = await groupsForYou(db, actor.personId, { excludeIds, limit });
    const withImpressions = await recordImpressions(db, actor.personId, "groups", "groups-v1", raw);
    const rows = withImpressions.length ? await db.group.findMany({ where: { id: { in: withImpressions.map((r) => r.objectId) } }, select: { id: true, slug: true, name: true, category: true, memberCount: true, logoAssetId: true } }) : [];
    const byId = new Map(rows.map((g) => [g.id, g]));
    const groups = withImpressions
      .map((r) => {
        const g = byId.get(r.objectId);
        return g ? { ...g, reason: r.reason, recommendationId: r.recommendationId } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    return { groups };
  });

  app.get("/recommendations/events", async (req) => {
    const actor = requireActor(req);
    const { limit: rawLimit } = z.object({ limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(rawLimit, 6, 20);
    const excludeIds = await dismissedIds(db, actor.personId, "events-v1", "Event");
    const raw = await eventsForYou(db, actor.personId, { excludeIds, limit });
    const withImpressions = await recordImpressions(db, actor.personId, "events", "events-v1", raw);
    const rows = withImpressions.length
      ? await db.event.findMany({ where: { id: { in: withImpressions.map((r) => r.objectId) } }, select: { id: true, slug: true, title: true, startsAt: true, venue: true, mode: true, coverAssetId: true } })
      : [];
    const byId = new Map(rows.map((e) => [e.id, e]));
    const events = withImpressions
      .map((r) => {
        const e = byId.get(r.objectId);
        return e ? { ...e, startsAt: e.startsAt.toISOString(), reason: r.reason, recommendationId: r.recommendationId } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    return { events };
  });

  /* ─────────────────────────── introductions for you (§34) ─────────────────── */
  // People at organizations matching the viewer's objectives who are reachable
  // through a DISCOVERABLE path (a connection is a verified member / mutual
  // customer or vendor there). The reason names the path, never a private edge.
  app.get("/recommendations/intros", async (req) => {
    const actor = requireActor(req);
    const { limit: rawLimit } = z.object({ limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(rawLimit, 6, 20);
    const excludeIds = await dismissedIds(db, actor.personId, "intros-v1", "Person");
    const raw = await introsForYou(db, actor.personId, { excludeIds, limit });
    const withImpressions = await recordImpressions(db, actor.personId, "intros", "intros-v1", raw);
    const cards = await personCards(db, withImpressions.map((r) => r.objectId));
    const people = withImpressions
      .map((r) => {
        const c = cards.get(r.objectId);
        return c ? { ...c, reason: r.reason, recommendationId: r.recommendationId } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    return { people };
  });

  /* ─────────────────────────── vendors for an RFQ ─────────────────────────── */

  app.get("/recommendations/vendors", async (req) => {
    const actor = requireActor(req);
    const { rfqId, limit: rawLimit } = z.object({ rfqId: z.string().min(1), limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(rawLimit, 8, 30);
    const rfq = await db.rfq.findUnique({ where: { id: rfqId }, select: { id: true, buyerPersonId: true, organizationId: true } });
    if (!rfq) throw notFound("That RFQ");
    const allowed = rfq.buyerPersonId === actor.personId || !!actor.staffRole || (rfq.organizationId ? await hasOrgPermission(db, actor, rfq.organizationId, "org.manage_rfqs") : false);
    if (!allowed) throw forbidden("You don't have access to this RFQ's vendor suggestions.");
    const excludeIds = await dismissedIds(db, actor.personId, "vendors-v1", "Organization");
    const raw = await vendorsForRfq(db, rfqId, { excludeIds, limit });
    const withImpressions = await recordImpressions(db, actor.personId, "vendors", "vendors-v1", raw);
    const cards = await orgCards(db, withImpressions.map((r) => r.objectId));
    const vendors = withImpressions
      .map((r) => {
        const c = cards.get(r.objectId);
        return c ? { ...c, reason: r.reason, recommendationId: r.recommendationId } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    return { vendors };
  });

  /* ─────────────────────────── outcome, dismiss, explain ─────────────────────────── */

  app.post("/recommendations/:impressionId/outcome", async (req) => {
    const actor = requireActor(req);
    const { impressionId } = z.object({ impressionId: z.string() }).parse(req.params);
    const body = z.object({ outcome: z.enum(["viewed", "clicked", "dismissed", "converted"]) }).parse(req.body);
    const impression = await db.recommendationImpression.findUnique({ where: { id: impressionId } });
    if (!impression || impression.personId !== actor.personId) throw notFound("That recommendation");
    await db.recommendationImpression.update({ where: { id: impressionId }, data: { outcome: body.outcome } });
    await track(db, {
      personId: actor.personId,
      event: "recommendation_outcome",
      objectType: impression.objectType,
      objectId: impression.objectId,
      surface: impression.surface,
      recommendationId: impressionId,
      props: { outcome: body.outcome, model: impression.model },
    });
    return { ok: true };
  });

  app.post("/recommendations/:impressionId/dismiss", async (req) => {
    const actor = requireActor(req);
    const { impressionId } = z.object({ impressionId: z.string() }).parse(req.params);
    const impression = await db.recommendationImpression.findUnique({ where: { id: impressionId } });
    if (!impression || impression.personId !== actor.personId) throw notFound("That recommendation");
    await db.recommendationImpression.update({ where: { id: impressionId }, data: { outcome: "dismissed" } });
    return { ok: true };
  });

  app.get("/recommendations/explain/:impressionId", async (req) => {
    const actor = requireActor(req);
    const { impressionId } = z.object({ impressionId: z.string() }).parse(req.params);
    const impression = await db.recommendationImpression.findUnique({ where: { id: impressionId } });
    if (!impression || impression.personId !== actor.personId) throw notFound("That recommendation");
    const evidence = await explainEvidence(db, actor.personId, impression);
    return { model: impression.model, surface: impression.surface, reason: impression.reason, objectType: impression.objectType, objectId: impression.objectId, evidence };
  });

  /* ─────────────────────────── experiments ─────────────────────────── */

  app.get("/experiments/active", async (req) => {
    const actor = requireActor(req);
    const running = await db.experiment.findMany({ where: { status: "RUNNING" }, select: { key: true } });
    const out: Record<string, string> = {};
    for (const e of running) out[e.key] = await assignVariant(db, e.key, actor.personId);
    return { experiments: out };
  });

  app.get("/admin/experiments", async (req) => {
    requireStaff(req);
    const experiments = await db.experiment.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { assignments: true } } } });
    return { experiments: experiments.map(({ _count, ...rest }) => ({ ...rest, assignmentCount: _count.assignments })) };
  });

  app.post("/admin/experiments", async (req, reply) => {
    const staff = requireStaff(req);
    const body = z
      .object({
        key: z.string().trim().min(1).max(80),
        hypothesis: z.string().trim().min(1).max(2000),
        population: z.string().trim().min(1).max(500),
        treatment: z.string().trim().min(1).max(2000),
        control: z.string().trim().min(1).max(2000),
        successMetrics: z.array(z.string().trim().min(1)).min(1),
        guardrailMetrics: z.array(z.string().trim().min(1)).min(1),
        minSample: z.number().int().min(1),
        rollbackCriteria: z.string().trim().min(1).max(2000),
        startsAt: z.string().datetime().optional(),
        endsAt: z.string().datetime().optional(),
      })
      .parse(req.body);
    const missing = EXPERIMENT_REQUIRED_FIELDS.filter((f) => {
      const v = (body as any)[f];
      return v === undefined || v === null || (Array.isArray(v) && v.length === 0) || (typeof v === "string" && v.trim() === "");
    });
    if (missing.length) throw badRequest("missing_fields", `An experiment needs every field filled in — missing: ${missing.join(", ")}.`);
    const dupe = await db.experiment.findUnique({ where: { key: body.key } });
    if (dupe) throw conflict("duplicate_key", `An experiment with the key "${body.key}" already exists.`);
    const row = await db.experiment.create({
      data: {
        key: body.key,
        hypothesis: body.hypothesis,
        population: body.population,
        treatment: body.treatment,
        control: body.control,
        successMetrics: body.successMetrics,
        guardrailMetrics: body.guardrailMetrics,
        minSample: body.minSample,
        rollbackCriteria: body.rollbackCriteria,
        startsAt: body.startsAt ? new Date(body.startsAt) : null,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        createdById: staff.personId,
        status: "DRAFT",
      },
    });
    await audit(db, { actorId: staff.personId, action: "experiment.created", targetType: "Experiment", targetId: row.id, after: { key: row.key } });
    reply.status(201);
    return row;
  });

  app.patch("/admin/experiments/:id", async (req) => {
    const staff = requireStaff(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ status: z.enum(["DRAFT", "RUNNING", "PAUSED", "DONE"]) }).parse(req.body);
    const existing = await db.experiment.findUnique({ where: { id } });
    if (!existing) throw notFound("That experiment");
    const validTransitions: Record<string, string[]> = { DRAFT: ["RUNNING"], RUNNING: ["PAUSED", "DONE"], PAUSED: ["RUNNING", "DONE"], DONE: [] };
    if (!validTransitions[existing.status]?.includes(body.status)) {
      throw badRequest("invalid_transition", `An experiment can't go from ${existing.status} to ${body.status}.`);
    }
    const row = await db.experiment.update({ where: { id }, data: { status: body.status } });
    await audit(db, { actorId: staff.personId, action: "experiment.status_changed", targetType: "Experiment", targetId: id, before: { status: existing.status }, after: { status: body.status } });
    return row;
  });

  app.get("/admin/experiments/:id/results", async (req) => {
    requireStaff(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const experiment = await db.experiment.findUnique({ where: { id } });
    if (!experiment) throw notFound("That experiment");
    const assignments = await db.experimentAssignment.findMany({ where: { experimentId: id }, select: { personId: true, variant: true } });
    const byVariant = new Map<string, string[]>();
    for (const a of assignments) byVariant.set(a.variant, [...(byVariant.get(a.variant) ?? []), a.personId]);

    const variants: Record<string, { sampleSize: number; insufficientSample: boolean; success: Record<string, number>; guardrail: Record<string, number> }> = {};
    for (const variant of ["control", "treatment"]) {
      const personIds = byVariant.get(variant) ?? [];
      const success: Record<string, number> = {};
      const guardrail: Record<string, number> = {};
      for (const metric of experiment.successMetrics) {
        success[metric] = personIds.length ? await db.analyticsEvent.count({ where: { event: metric, personId: { in: personIds } } }) : 0;
      }
      for (const metric of experiment.guardrailMetrics) {
        guardrail[metric] = personIds.length ? await db.analyticsEvent.count({ where: { event: metric, personId: { in: personIds } } }) : 0;
      }
      variants[variant] = { sampleSize: personIds.length, insufficientSample: personIds.length < experiment.minSample, success, guardrail };
    }
    return { experiment, variants };
  });

  /* ─────────────────────────── feature flags (admin) ─────────────────────────── */

  app.get("/admin/flags", async (req) => {
    requireStaff(req);
    const flags = await db.featureFlag.findMany({ orderBy: { key: "asc" } });
    return { flags };
  });

  app.put("/admin/flags/:key", async (req) => {
    const staff = requireStaff(req);
    const { key } = z.object({ key: z.string().min(1) }).parse(req.params);
    const body = z
      .object({
        enabled: z.boolean(),
        rollout: z.number().int().min(0).max(100).default(0),
        audience: z.enum(["INTERNAL", "SELECTED", "PERCENT", "ALL"]).default("INTERNAL"),
        allowPersons: z.array(z.string()).default([]),
        allowOrgs: z.array(z.string()).default([]),
        description: z.string().trim().max(500).optional(),
      })
      .parse(req.body);
    const existing = await db.featureFlag.findUnique({ where: { key } });
    const row = await db.featureFlag.upsert({
      where: { key },
      create: { key, enabled: body.enabled, rollout: body.rollout, audience: body.audience, allowPersons: body.allowPersons, allowOrgs: body.allowOrgs, description: body.description ?? null, updatedById: staff.personId },
      update: { enabled: body.enabled, rollout: body.rollout, audience: body.audience, allowPersons: body.allowPersons, allowOrgs: body.allowOrgs, description: body.description ?? null, updatedById: staff.personId },
    });
    await audit(db, {
      actorId: staff.personId,
      action: "flag.updated",
      targetType: "FeatureFlag",
      targetId: key,
      before: existing ? { enabled: existing.enabled, rollout: existing.rollout, audience: existing.audience } : null,
      after: { enabled: row.enabled, rollout: row.rollout, audience: row.audience },
    });
    return row;
  });
}

/** Reads back what fed a given impression's reason — evidence only, never anything the person hasn't earned the right to see (mutual counts, never private tag identities). */
async function explainEvidence(db: Db, personId: string, impression: { model: string; objectId: string; reason: string | null }): Promise<Record<string, unknown>> {
  if (impression.model === "byn-v1") {
    const [profile, myConnections] = await Promise.all([
      db.profile.findUnique({ where: { personId }, select: { industry: true, objectives: true } }),
      connectionIds(db, personId),
    ]);
    const org = await db.organization.findUnique({ where: { id: impression.objectId }, select: { industry: true } });
    const industryMatch = !!profile?.industry && profile.industry === org?.industry;
    const followCount = myConnections.length ? await db.follow.count({ where: { followerId: { in: myConnections }, organizationId: impression.objectId } }) : 0;
    const mutualTagCount = myConnections.length ? await db.relationshipTag.count({ where: { ownerId: { in: myConnections }, targetOrgId: impression.objectId, mutual: true } }) : 0;
    return { industryMatch, connectionsFollowingCount: followCount, mutualRelationshipTagCount: mutualTagCount, objectivesConsidered: profile?.objectives ?? [], industryAdjacency: profile?.industry ? INDUSTRY_ADJACENCY[profile.industry] ?? [] : [] };
  }
  if (impression.model === "cymw-v1") {
    const profile = await db.profile.findUnique({ where: { personId }, select: { industry: true } });
    return { yourIndustry: profile?.industry ?? null, note: "Matched via an open RFQ in a category you sell in, or an industry that typically buys from yours." };
  }
  if (impression.model === "jyml-v1") {
    const profile = await db.profile.findUnique({ where: { personId }, select: { skills: true, industry: true, location: true } });
    return { skillsConsidered: profile?.skills ?? [], industryConsidered: profile?.industry ?? null, locationConsidered: profile?.location ?? null };
  }
  if (impression.model === "cand-v1") {
    return { note: "Matched by full-text search of the candidate's public profile against this job's title, requirements and location." };
  }
  return { note: "No detailed evidence recorded for this recommendation." };
}
