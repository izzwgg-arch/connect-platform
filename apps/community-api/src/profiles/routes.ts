import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { track } from "../lib/analytics.js";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { requireActor } from "../auth/actor.js";
import { requireVerifiedActor } from "../auth/guards.js";
import { storeUpload } from "../media/service.js";
import { personCards } from "./cards.js";
import { degreeBetween, isBlockedEitherWay, mutualConnections, sharesOrganization } from "../policy/graph.js";
import { canCallPerson, canMessagePerson, connectionStatusBetween, effectiveVisibility, sectionVisibility } from "./policy.js";
import { normalizeUsername, rebuildProfileSearchText, usernameProblem } from "./service.js";
import { mergePreferences } from "./preferences.js";

/**
 * profiles domain — GET/PATCH /me/profile, the experience/education/service/
 * certification/portfolio CRUD, preferences, username, avatar/cover uploads,
 * the public profile (privacy-filtered + relationship block), activity,
 * recommendations and endorsements. See docs/community/CONVENTIONS.md.
 */
export function registerProfileRoutes(app: FastifyInstance, db: Db) {
  async function assertOrgExists(organizationId: string | null | undefined) {
    if (!organizationId) return;
    const org = await db.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
    if (!org) throw badRequest("organization_not_found", "That company wasn't found.");
  }

  async function assertAssetOwned(personId: string, assetId: string | null | undefined) {
    if (!assetId) return;
    const asset = await db.mediaAsset.findUnique({ where: { id: assetId }, select: { ownerId: true } });
    if (!asset || asset.ownerId !== personId) throw badRequest("asset_invalid", "That file wasn't found on your account.");
  }

  function patchData(body: object): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) if (v !== undefined) data[k] = v;
    return data;
  }

  // ── GET/PATCH /me/profile ────────────────────────────────────────────────
  app.get("/me/profile", async (req) => {
    const actor = requireActor(req);
    const profile = await db.profile.findUnique({
      where: { personId: actor.personId },
      include: {
        experiences: { orderBy: [{ sortOrder: "asc" }, { startDate: "desc" }] },
        educations: { orderBy: { startYear: "desc" } },
        services: true,
        certifications: true,
        portfolio: { orderBy: { sortOrder: "asc" } },
      },
    });
    if (!profile) throw notFound("Your profile");
    const person = await db.person.findUniqueOrThrow({ where: { id: actor.personId }, select: { username: true, email: true, phoneE164: true } });
    return { profile: { ...profile, links: (profile.links as unknown[] | null) ?? [] }, username: person.username, email: person.email, phone: person.phoneE164 };
  });

  const linkSchema = z.object({ label: z.string().trim().min(1).max(40), url: z.string().trim().url().max(300) });
  const profilePatchSchema = z.object({
    firstName: z.string().trim().min(1).max(60).optional(),
    lastName: z.string().trim().min(1).max(60).optional(),
    headline: z.string().trim().max(140).nullable().optional(),
    about: z.string().trim().max(4000).nullable().optional(),
    location: z.string().trim().max(140).nullable().optional(),
    serviceArea: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    languages: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    industry: z.string().trim().max(80).nullable().optional(),
    objectives: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    skills: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
    links: z.array(linkSchema).max(10).optional(),
  });

  app.patch("/me/profile", async (req) => {
    const actor = requireActor(req);
    const body = profilePatchSchema.parse(req.body);
    const data = patchData(body);
    if (!Object.keys(data).length) throw badRequest("no_changes", "Nothing to update.");
    const row = await db.profile.update({ where: { personId: actor.personId }, data });
    await rebuildProfileSearchText(db, actor.personId);
    return { profile: { ...row, links: (row.links as unknown[] | null) ?? [] } };
  });

  // ── experiences ───────────────────────────────────────────────────────────
  const experienceSchema = z.object({
    organizationId: z.string().max(60).nullable().optional(),
    companyName: z.string().trim().min(1).max(140),
    title: z.string().trim().min(1).max(140),
    startDate: z.coerce.date(),
    endDate: z.coerce.date().nullable().optional(),
    isCurrent: z.boolean().optional(),
    location: z.string().trim().max(140).nullable().optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  });
  const experiencePatchSchema = experienceSchema.partial();

  app.post("/me/profile/experiences", async (req, reply) => {
    const actor = requireActor(req);
    const body = experienceSchema.parse(req.body);
    await assertOrgExists(body.organizationId);
    const row = await db.experience.create({
      data: {
        personId: actor.personId,
        organizationId: body.organizationId ?? null,
        companyName: body.companyName,
        title: body.title,
        startDate: body.startDate,
        endDate: body.endDate ?? null,
        isCurrent: body.isCurrent ?? false,
        location: body.location ?? null,
        description: body.description ?? null,
        sortOrder: body.sortOrder ?? 0,
      },
    });
    await rebuildProfileSearchText(db, actor.personId);
    reply.status(201);
    return { experience: row };
  });

  app.patch("/me/profile/experiences/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const existing = await db.experience.findUnique({ where: { id } });
    if (!existing || existing.personId !== actor.personId) throw notFound("That experience");
    const body = experiencePatchSchema.parse(req.body);
    if (body.organizationId !== undefined) await assertOrgExists(body.organizationId);
    const row = await db.experience.update({ where: { id }, data: patchData(body) });
    await rebuildProfileSearchText(db, actor.personId);
    return { experience: row };
  });

  app.delete("/me/profile/experiences/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const existing = await db.experience.findUnique({ where: { id } });
    if (!existing || existing.personId !== actor.personId) throw notFound("That experience");
    await db.experience.delete({ where: { id } });
    await rebuildProfileSearchText(db, actor.personId);
    return { ok: true };
  });

  // ── educations ────────────────────────────────────────────────────────────
  const educationSchema = z.object({
    school: z.string().trim().min(1).max(140),
    degree: z.string().trim().max(140).nullable().optional(),
    field: z.string().trim().max(140).nullable().optional(),
    startYear: z.number().int().min(1900).max(2100).nullable().optional(),
    endYear: z.number().int().min(1900).max(2100).nullable().optional(),
  });
  const educationPatchSchema = educationSchema.partial();

  app.post("/me/profile/educations", async (req, reply) => {
    const actor = requireActor(req);
    const body = educationSchema.parse(req.body);
    const row = await db.education.create({ data: { personId: actor.personId, ...body } });
    reply.status(201);
    return { education: row };
  });

  app.patch("/me/profile/educations/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const existing = await db.education.findUnique({ where: { id } });
    if (!existing || existing.personId !== actor.personId) throw notFound("That education");
    const body = educationPatchSchema.parse(req.body);
    const row = await db.education.update({ where: { id }, data: patchData(body) });
    return { education: row };
  });

  app.delete("/me/profile/educations/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const existing = await db.education.findUnique({ where: { id } });
    if (!existing || existing.personId !== actor.personId) throw notFound("That education");
    await db.education.delete({ where: { id } });
    return { ok: true };
  });

  // ── services ──────────────────────────────────────────────────────────────
  const serviceSchema = z.object({
    name: z.string().trim().min(1).max(140),
    description: z.string().trim().max(2000).nullable().optional(),
    priceFrom: z.coerce.number().min(0).max(999_999.99).nullable().optional(),
    priceNote: z.string().trim().max(140).nullable().optional(),
  });
  const servicePatchSchema = serviceSchema.partial();

  app.post("/me/profile/services", async (req, reply) => {
    const actor = requireActor(req);
    const body = serviceSchema.parse(req.body);
    const row = await db.profileService.create({ data: { personId: actor.personId, ...body } });
    await rebuildProfileSearchText(db, actor.personId);
    reply.status(201);
    return { service: row };
  });

  app.patch("/me/profile/services/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const existing = await db.profileService.findUnique({ where: { id } });
    if (!existing || existing.personId !== actor.personId) throw notFound("That service");
    const body = servicePatchSchema.parse(req.body);
    const row = await db.profileService.update({ where: { id }, data: patchData(body) });
    await rebuildProfileSearchText(db, actor.personId);
    return { service: row };
  });

  app.delete("/me/profile/services/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const existing = await db.profileService.findUnique({ where: { id } });
    if (!existing || existing.personId !== actor.personId) throw notFound("That service");
    await db.profileService.delete({ where: { id } });
    await rebuildProfileSearchText(db, actor.personId);
    return { ok: true };
  });

  // ── certifications ────────────────────────────────────────────────────────
  const certificationSchema = z.object({
    name: z.string().trim().min(1).max(140),
    issuer: z.string().trim().max(140).nullable().optional(),
    issuedAt: z.coerce.date().nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    assetId: z.string().max(60).nullable().optional(),
  });
  const certificationPatchSchema = certificationSchema.partial();

  app.post("/me/profile/certifications", async (req, reply) => {
    const actor = requireActor(req);
    const body = certificationSchema.parse(req.body);
    await assertAssetOwned(actor.personId, body.assetId);
    const row = await db.certification.create({ data: { personId: actor.personId, ...body } });
    reply.status(201);
    return { certification: row };
  });

  app.patch("/me/profile/certifications/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const existing = await db.certification.findUnique({ where: { id } });
    if (!existing || existing.personId !== actor.personId) throw notFound("That certification");
    const body = certificationPatchSchema.parse(req.body);
    if (body.assetId !== undefined) await assertAssetOwned(actor.personId, body.assetId);
    const row = await db.certification.update({ where: { id }, data: patchData(body) });
    return { certification: row };
  });

  app.delete("/me/profile/certifications/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const existing = await db.certification.findUnique({ where: { id } });
    if (!existing || existing.personId !== actor.personId) throw notFound("That certification");
    await db.certification.delete({ where: { id } });
    return { ok: true };
  });

  // ── portfolio ─────────────────────────────────────────────────────────────
  const portfolioSchema = z.object({
    title: z.string().trim().min(1).max(140),
    description: z.string().trim().max(2000).nullable().optional(),
    assetId: z.string().max(60).nullable().optional(),
    url: z.string().trim().url().max(300).nullable().optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  });
  const portfolioPatchSchema = portfolioSchema.partial();

  app.post("/me/profile/portfolio", async (req, reply) => {
    const actor = requireActor(req);
    const body = portfolioSchema.parse(req.body);
    await assertAssetOwned(actor.personId, body.assetId);
    const row = await db.portfolioItem.create({ data: { personId: actor.personId, ...body } });
    reply.status(201);
    return { item: row };
  });

  app.patch("/me/profile/portfolio/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const existing = await db.portfolioItem.findUnique({ where: { id } });
    if (!existing || existing.personId !== actor.personId) throw notFound("That portfolio item");
    const body = portfolioPatchSchema.parse(req.body);
    if (body.assetId !== undefined) await assertAssetOwned(actor.personId, body.assetId);
    const row = await db.portfolioItem.update({ where: { id }, data: patchData(body) });
    return { item: row };
  });

  app.delete("/me/profile/portfolio/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const existing = await db.portfolioItem.findUnique({ where: { id } });
    if (!existing || existing.personId !== actor.personId) throw notFound("That portfolio item");
    await db.portfolioItem.delete({ where: { id } });
    return { ok: true };
  });

  // ── preferences ───────────────────────────────────────────────────────────
  app.get("/me/profile/preferences", async (req) => {
    const actor = requireActor(req);
    const person = await db.person.findUniqueOrThrow({ where: { id: actor.personId }, select: { preferences: true } });
    return { prefs: mergePreferences(person.preferences) };
  });

  const prefsSchema = z.object({ prefs: z.record(z.boolean()) });
  app.put("/me/profile/preferences", async (req) => {
    const actor = requireActor(req);
    const body = prefsSchema.parse(req.body);
    const person = await db.person.findUniqueOrThrow({ where: { id: actor.personId }, select: { preferences: true } });
    const before = mergePreferences(person.preferences);
    const after = mergePreferences({ ...before, ...body.prefs });
    await db.person.update({ where: { id: actor.personId }, data: { preferences: after } });
    await audit(db, { actorId: actor.personId, action: "person.preferences_changed", targetType: "Person", targetId: actor.personId, before, after });
    return { prefs: after };
  });

  // ── onboarding ────────────────────────────────────────────────────────────
  app.post("/me/onboarding/done", async (req) => {
    const actor = requireActor(req);
    const person = await db.person.findUniqueOrThrow({ where: { id: actor.personId }, select: { onboardingDoneAt: true } });
    if (!person.onboardingDoneAt) await db.person.update({ where: { id: actor.personId }, data: { onboardingDoneAt: new Date() } });
    return { ok: true };
  });

  // ── username ──────────────────────────────────────────────────────────────
  app.patch("/me/username", async (req) => {
    const actor = requireActor(req);
    const body = z.object({ username: z.string().min(1).max(30) }).parse(req.body);
    const candidate = normalizeUsername(body.username);
    const problem = usernameProblem(candidate);
    if (problem) throw badRequest("username_invalid", problem);
    const person = await db.person.findUniqueOrThrow({ where: { id: actor.personId }, select: { username: true } });
    if (candidate === person.username) return { username: candidate };
    const dupe = await db.person.findUnique({ where: { username: candidate }, select: { id: true } });
    if (dupe) throw conflict("username_taken", "That username is already taken. Try another.");
    await db.person.update({ where: { id: actor.personId }, data: { username: candidate } });
    await audit(db, { actorId: actor.personId, action: "person.username_changed", targetType: "Person", targetId: actor.personId, before: { username: person.username }, after: { username: candidate } });
    return { username: candidate };
  });

  // ── avatar / cover ────────────────────────────────────────────────────────
  app.post("/me/avatar", async (req) => {
    const actor = requireActor(req);
    const part = await req.file();
    if (!part) throw badRequest("file_missing", "Choose an image to upload.");
    const buffer = await part.toBuffer();
    const asset = await storeUpload(db, actor.personId, { buffer, filename: part.filename, mimetype: part.mimetype }, { allow: ["image"] });
    await db.profile.update({ where: { personId: actor.personId }, data: { avatarAssetId: asset.id } });
    return { asset };
  });

  app.post("/me/cover", async (req) => {
    const actor = requireActor(req);
    const part = await req.file();
    if (!part) throw badRequest("file_missing", "Choose an image to upload.");
    const buffer = await part.toBuffer();
    const asset = await storeUpload(db, actor.personId, { buffer, filename: part.filename, mimetype: part.mimetype }, { allow: ["image"] });
    await db.profile.update({ where: { personId: actor.personId }, data: { coverAssetId: asset.id } });
    return { asset };
  });

  // ── public profile ────────────────────────────────────────────────────────
  app.get("/public/people/:username", async (req) => {
    const { username } = z.object({ username: z.string().min(1).max(60) }).parse(req.params);
    const viewerId = req.actor?.personId ?? null;
    const target = await db.person.findUnique({
      where: { username: normalizeUsername(username) },
      include: {
        profile: {
          include: {
            experiences: { orderBy: [{ sortOrder: "asc" }, { startDate: "desc" }] },
            educations: { orderBy: { startYear: "desc" } },
            services: true,
            certifications: true,
            portfolio: { orderBy: { sortOrder: "asc" } },
          },
        },
      },
    });
    if (!target || !target.profile) throw notFound("That profile");
    if (target.status !== "ACTIVE" && viewerId !== target.id) throw notFound("That profile");
    if (viewerId && (await isBlockedEitherWay(db, viewerId, target.id))) throw notFound("That profile");

    const [privacyRows, degree, sameOrg, connectionStatus, mutual, following, verifications, skillCounts, endorsedRows, membership] = await Promise.all([
      db.privacySetting.findMany({ where: { personId: target.id } }),
      degreeBetween(db, viewerId, target.id),
      sharesOrganization(db, viewerId, target.id),
      connectionStatusBetween(db, viewerId, target.id),
      viewerId && viewerId !== target.id ? mutualConnections(db, viewerId, target.id) : Promise.resolve({ count: 0, sample: [] as Array<{ personId: string }> }),
      viewerId ? db.follow.findUnique({ where: { followerId_personId: { followerId: viewerId, personId: target.id } } }) : Promise.resolve(null),
      db.verification.findMany({ where: { personId: target.id, status: "VERIFIED" }, select: { kind: true } }),
      db.endorsement.groupBy({ by: ["skill"], where: { personId: target.id }, _count: { skill: true } }),
      viewerId ? db.endorsement.findMany({ where: { byId: viewerId, personId: target.id }, select: { skill: true } }) : Promise.resolve([] as Array<{ skill: string }>),
      db.membership.findFirst({
        where: { personId: target.id, showOnProfile: true, affiliation: { in: ["VERIFIED_ADMIN", "VERIFIED_DOMAIN"] } },
        orderBy: { isPrimary: "desc" },
        select: { organization: { select: { id: true, slug: true, displayName: true } } },
      }),
    ]);

    const vis = effectiveVisibility(privacyRows);
    const ctx = { degree, sameOrganization: sameOrg };
    const sections = sectionVisibility(vis, ctx);

    const endorsedByMe = new Set(endorsedRows.map((e) => e.skill));
    const countBySkill = new Map(skillCounts.map((s) => [s.skill, s._count.skill]));
    const skills = target.profile.skills.map((skill) => ({ skill, count: countBySkill.get(skill) ?? 0, endorsedByMe: endorsedByMe.has(skill) }));

    const mutualCardsMap = await personCards(db, mutual.sample.map((m) => m.personId));
    const mutualSample = mutual.sample.map((m) => mutualCardsMap.get(m.personId)).filter((c): c is NonNullable<typeof c> => !!c);

    const messageRequestsAllowed = mergePreferences(target.preferences).messageRequests;
    const relationship = {
      degree,
      mutualCount: mutual.count,
      mutualSample,
      connectionStatus,
      following: !!following,
      canMessage: canMessagePerson({ viewerPresent: !!viewerId, connectionStatus, messageRequestsAllowed }),
      canCall: canCallPerson(req.actor?.loopcomTenantId, target.loopcomTenantId),
    };

    if (viewerId !== target.id) {
      await track(db, { personId: viewerId, event: "profile_view", objectType: "person", objectId: target.id });
    }

    const p = target.profile;
    return {
      person: { id: target.id, username: target.username, name: `${p.firstName} ${p.lastName}`.trim(), firstName: p.firstName, lastName: p.lastName },
      profile: {
        avatarAssetId: p.avatarAssetId,
        coverAssetId: p.coverAssetId,
        industry: p.industry,
        serviceArea: p.serviceArea,
        objectives: p.objectives,
        headline: sections.headline ? p.headline : null,
        about: sections.about ? p.about : null,
        location: sections.location ? p.location : null,
        languages: sections.languages ? p.languages : [],
        skills: sections.skills ? skills : [],
        links: sections.links ? ((p.links as unknown[] | null) ?? []) : [],
        phone: sections.phone ? target.phoneE164 : null,
        email: sections.email ? target.email : null,
        experiences: sections.experience ? p.experiences : [],
        educations: sections.education ? p.educations : [],
        services: sections.services ? p.services : [],
        certifications: sections.certifications ? p.certifications : [],
        portfolio: sections.portfolio ? p.portfolio : [],
      },
      verifications: verifications.map((v) => v.kind),
      primaryOrg: membership?.organization ?? null,
      relationship,
      sections,
      visibility: degree === 0 ? vis : undefined,
    };
  });

  // ── activity (their public posts) ────────────────────────────────────────
  app.get("/people/:username/activity", async (req) => {
    const actor = requireActor(req);
    const { username } = z.object({ username: z.string().min(1).max(60) }).parse(req.params);
    const query = req.query as { cursor?: string; limit?: string };
    const target = await db.person.findUnique({ where: { username: normalizeUsername(username) }, select: { id: true, status: true } });
    if (!target) throw notFound("That profile");
    if (target.status !== "ACTIVE" && actor.personId !== target.id) throw notFound("That profile");
    if (await isBlockedEitherWay(db, actor.personId, target.id)) throw notFound("That profile");

    if (actor.personId !== target.id) {
      const [privacyRows, degree, sameOrg] = await Promise.all([
        db.privacySetting.findMany({ where: { personId: target.id, category: "activity" } }),
        degreeBetween(db, actor.personId, target.id),
        sharesOrganization(db, actor.personId, target.id),
      ]);
      const vis = effectiveVisibility(privacyRows);
      if (!sectionVisibility(vis, { degree, sameOrganization: sameOrg }).activity) return { items: [], nextCursor: null };
    }

    const take = clampLimit(query.limit, 20, 50);
    const cur = decodeCursor(query.cursor);
    const rows = await db.post.findMany({
      where: { authorId: target.id, visibility: "PUBLIC", deletedAt: null, ...(cur ? { createdAt: { lt: new Date(cur.value) } } : {}) },
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, kind: true, body: true, createdAt: true, reactionCount: true, commentCount: true, repostCount: true },
    });
    const last = rows[rows.length - 1];
    const nextCursor = rows.length === take && last ? encodeCursor(last.createdAt, last.id) : null;
    return { items: rows, nextCursor };
  });

  // ── people also viewed ───────────────────────────────────────────────────
  app.get("/people/:username/also-viewed", async (req) => {
    const actor = requireActor(req);
    const { username } = z.object({ username: z.string().min(1).max(60) }).parse(req.params);
    const target = await db.person.findUnique({ where: { username: normalizeUsername(username) }, include: { profile: { select: { industry: true, location: true } } } });
    if (!target || !target.profile) throw notFound("That profile");

    const blocks = await db.block.findMany({ where: { OR: [{ blockerId: actor.personId }, { blockedId: actor.personId }] }, select: { blockerId: true, blockedId: true } });
    const excluded = new Set<string>([target.id, actor.personId]);
    for (const b of blocks) {
      excluded.add(b.blockerId);
      excluded.add(b.blockedId);
    }

    const ors: Array<{ industry?: string; location?: string }> = [];
    if (target.profile.industry) ors.push({ industry: target.profile.industry });
    if (target.profile.location) ors.push({ location: target.profile.location });
    if (!ors.length) return { items: [] };

    const candidates = await db.profile.findMany({
      where: { personId: { notIn: [...excluded] }, OR: ors },
      take: 3,
      orderBy: { updatedAt: "desc" },
      select: { personId: true },
    });
    const cards = await personCards(db, candidates.map((c) => c.personId));
    return { items: candidates.map((c) => cards.get(c.personId)).filter((c): c is NonNullable<typeof c> => !!c) };
  });

  // ── recommendations ───────────────────────────────────────────────────────
  const recommendationSchema = z.object({ relationship: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(2000) });

  app.post("/people/:id/recommendations", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id: subjectId } = z.object({ id: z.string() }).parse(req.params);
    if (subjectId === actor.personId) throw badRequest("cannot_recommend_self", "You can't write a recommendation for yourself.");
    const subject = await db.person.findUnique({ where: { id: subjectId }, select: { id: true } });
    if (!subject) throw notFound("That person");
    if (await isBlockedEitherWay(db, actor.personId, subjectId)) throw notFound("That person");
    const degree = await degreeBetween(db, actor.personId, subjectId);
    if (degree !== 1) throw forbidden("You can only write a recommendation for a 1st-degree connection.");
    const body = recommendationSchema.parse(req.body);
    let row;
    try {
      row = await db.recommendation.create({ data: { authorId: actor.personId, subjectId, relationship: body.relationship, body: body.body } });
    } catch (err: any) {
      if (err?.code === "P2002") throw conflict("recommendation_exists", "You already wrote a recommendation for this person.");
      throw err;
    }
    await notify(db, {
      personId: subjectId,
      kind: "recommendation.new",
      title: "You have a new recommendation",
      body: `${body.relationship} wrote you a recommendation.`,
      href: `/people/${actor.username}`,
      actorId: actor.personId,
      objectType: "recommendation",
      objectId: row.id,
    });
    reply.status(201);
    return { recommendation: row };
  });

  app.post("/me/recommendations/:id/accept", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const rec = await db.recommendation.findUnique({ where: { id } });
    if (!rec || rec.subjectId !== actor.personId) throw notFound("That recommendation");
    const row = await db.recommendation.update({ where: { id }, data: { acceptedAt: new Date() } });
    return { recommendation: row };
  });

  app.post("/me/recommendations/:id/reject", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const rec = await db.recommendation.findUnique({ where: { id } });
    if (!rec || rec.subjectId !== actor.personId) throw notFound("That recommendation");
    await db.recommendation.delete({ where: { id } });
    return { ok: true };
  });

  app.delete("/me/recommendations/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const rec = await db.recommendation.findUnique({ where: { id } });
    if (!rec || rec.authorId !== actor.personId) throw notFound("That recommendation");
    await db.recommendation.delete({ where: { id } });
    return { ok: true };
  });

  app.get("/people/:username/recommendations", async (req) => {
    const actor = requireActor(req);
    const { username } = z.object({ username: z.string().min(1).max(60) }).parse(req.params);
    const target = await db.person.findUnique({ where: { username: normalizeUsername(username) }, select: { id: true } });
    if (!target) throw notFound("That profile");
    if (await isBlockedEitherWay(db, actor.personId, target.id)) throw notFound("That profile");
    // Everyone else sees accepted-only; the subject also sees the ones awaiting their decision.
    const isSelf = actor.personId === target.id;
    const rows = await db.recommendation.findMany({
      where: { subjectId: target.id, ...(isSelf ? {} : { acceptedAt: { not: null } }) },
      orderBy: [{ acceptedAt: "desc" }, { createdAt: "desc" }],
    });
    const authors = await personCards(db, rows.map((r) => r.authorId));
    return {
      items: rows.map((r) => ({
        id: r.id,
        relationship: r.relationship,
        body: r.body,
        acceptedAt: r.acceptedAt,
        createdAt: r.createdAt,
        status: r.acceptedAt ? "accepted" : "pending",
        author: authors.get(r.authorId) ?? null,
      })),
    };
  });

  // ── endorsements ──────────────────────────────────────────────────────────
  const endorseSchema = z.object({ skill: z.string().trim().min(1).max(40) });

  app.post("/people/:id/endorse", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id: personId } = z.object({ id: z.string() }).parse(req.params);
    if (personId === actor.personId) throw badRequest("cannot_endorse_self", "You can't endorse your own skill.");
    const target = await db.person.findUnique({ where: { id: personId }, include: { profile: { select: { skills: true } } } });
    if (!target || !target.profile) throw notFound("That person");
    if (await isBlockedEitherWay(db, actor.personId, personId)) throw notFound("That person");
    const degree = await degreeBetween(db, actor.personId, personId);
    if (degree !== 1) throw forbidden("You can only endorse a 1st-degree connection.");
    const body = endorseSchema.parse(req.body);
    if (!target.profile.skills.includes(body.skill)) throw badRequest("skill_not_listed", "That skill isn't on their profile.");
    await db.endorsement.upsert({
      where: { byId_personId_skill: { byId: actor.personId, personId, skill: body.skill } },
      create: { byId: actor.personId, personId, skill: body.skill },
      update: {},
    });
    reply.status(201);
    return { ok: true };
  });

  app.delete("/people/:id/endorse", async (req) => {
    const actor = requireActor(req);
    const { id: personId } = z.object({ id: z.string() }).parse(req.params);
    const body = endorseSchema.parse(req.body);
    await db.endorsement.deleteMany({ where: { byId: actor.personId, personId, skill: body.skill } });
    return { ok: true };
  });
}
