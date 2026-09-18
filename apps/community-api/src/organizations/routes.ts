import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { Prisma } from "../db.js";
import { env } from "../env.js";
import { requireActor } from "../auth/actor.js";
import { requireVerifiedActor } from "../auth/guards.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { track } from "../lib/analytics.js";
import { sendMail } from "../lib/mail.js";
import { notify } from "../lib/notify.js";
import { sha256, token } from "../lib/ids.js";
import { ftsIds, prefixIds } from "../lib/search.js";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { storeUpload } from "../media/service.js";
import { personCards } from "../profiles/cards.js";
import { orgCard, orgCards } from "./cards.js";
import { ORG_PERMISSIONS, membershipOf, permissionsForMembership, requireOrgPermission } from "./permissions.js";
import { ORG_EDITABLE_FIELDS, emailDomain, hasAnotherOwner, orgHoursSchema } from "./policy.js";
import { notifyOrgHolders, orgSearchText, publicCompanyPayload, uniqueOrgSlug } from "./service.js";

const ROLE_VALUES = ["OWNER", "ADMIN", "MANAGER", "EMPLOYEE", "RECRUITER", "SALES", "MARKETING", "BILLING_ADMIN", "MODERATOR", "CUSTOM"] as const;
const AFFILIATION_VALUES = ["PENDING", "VERIFIED_DOMAIN", "VERIFIED_ADMIN", "REJECTED"] as const;
const permissionEnum = z.enum(ORG_PERMISSIONS);

const createOrgSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(160).optional(),
  industry: z.string().trim().max(80).optional(),
  size: z.string().trim().max(40).optional(),
  website: z.string().trim().max(300).optional(),
  description: z.string().trim().max(4000).optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().email().max(200).optional(),
  serviceArea: z.array(z.string().trim().max(80)).max(30).optional(),
});

const patchOrgSchema = z
  .object({
    displayName: z.string().trim().min(2).max(120),
    legalName: z.string().trim().max(160).nullable(),
    industry: z.string().trim().max(80).nullable(),
    size: z.string().trim().max(40).nullable(),
    foundedYear: z.number().int().min(1800).max(2100).nullable(),
    website: z.string().trim().max(300).nullable(),
    domain: z.string().trim().toLowerCase().max(200).nullable(),
    phone: z.string().trim().max(30).nullable(),
    smsNumber: z.string().trim().max(30).nullable(),
    whatsappNumber: z.string().trim().max(30).nullable(),
    email: z.string().trim().email().max(200).nullable(),
    description: z.string().trim().max(4000).nullable(),
    serviceArea: z.array(z.string().trim().max(80)).max(30),
    hours: orgHoursSchema.nullable(),
    acceptsRfqs: z.boolean(),
    showPhone: z.boolean(),
    showEmail: z.boolean(),
    showWhatsapp: z.boolean(),
    openMessages: z.boolean(),
    searchEngineVisible: z.boolean(),
  })
  .partial();

async function activeIdsInOrder(db: Db, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db.organization.findMany({ where: { id: { in: ids }, status: "ACTIVE" }, select: { id: true } });
  const ok = new Set(rows.map((r) => r.id));
  return ids.filter((id) => ok.has(id));
}

export function registerOrganizationRoutes(app: FastifyInstance, db: Db) {
  // ── search / discovery ──────────────────────────────────────────────────
  app.get("/organizations", async (req) => {
    requireActor(req);
    const { q, limit } = z.object({ q: z.string().trim().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).optional() }).parse(req.query);
    const lim = limit ?? 20;
    let ids: string[];
    if (q && q.length > 2) {
      const rows = await ftsIds(db, "Organization", "id", q, lim, Prisma.sql`AND status = 'ACTIVE'`);
      ids = rows.map((r) => r.id);
      if (!ids.length) ids = await activeIdsInOrder(db, await prefixIds(db, "Organization", "id", "displayName", q, lim));
    } else if (q && q.length > 0) {
      ids = await activeIdsInOrder(db, await prefixIds(db, "Organization", "id", "displayName", q, lim));
    } else {
      const rows = await db.organization.findMany({ where: { status: "ACTIVE" }, orderBy: { followerCount: "desc" }, take: lim, select: { id: true } });
      ids = rows.map((r) => r.id);
    }
    const cards = await orgCards(db, ids);
    return { organizations: ids.map((id) => cards.get(id)).filter(Boolean) };
  });

  app.get("/public/companies/:slug", async (req) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const org = await db.organization.findUnique({ where: { slug } });
    if (!org || org.status !== "ACTIVE") throw notFound("That company");
    const payload = await publicCompanyPayload(db, org, req.actor);
    await track(db, { personId: req.actor?.personId ?? null, event: "company_view", objectType: "Organization", objectId: org.id });
    return payload;
  });

  app.get("/public/stats", async () => {
    const [people, organizations, openRfqs, jobs] = await Promise.all([
      db.person.count({ where: { status: "ACTIVE" } }),
      db.organization.count({ where: { status: "ACTIVE" } }),
      db.rfq.count({ where: { status: "OPEN" } }),
      db.job.count({ where: { status: "OPEN" } }),
    ]);
    return { people, organizations, openRfqs, jobs };
  });

  app.get("/me/organizations", async (req) => {
    const actor = requireActor(req);
    const memberships = await db.membership.findMany({ where: { personId: actor.personId }, orderBy: { isPrimary: "desc" } });
    const cards = await orgCards(db, memberships.map((m) => m.organizationId));
    return {
      organizations: memberships
        .map((m) => {
          const card = cards.get(m.organizationId);
          return card ? { ...card, role: m.role, permissions: [...permissionsForMembership(m)], affiliation: m.affiliation, isPrimary: m.isPrimary } : null;
        })
        .filter(Boolean),
    };
  });

  // ── create ───────────────────────────────────────────────────────────────
  app.post("/organizations", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const body = createOrgSchema.parse(req.body);
    const slug = await uniqueOrgSlug(db, body.displayName);
    const hasPrimary = await db.membership.findFirst({ where: { personId: actor.personId, isPrimary: true }, select: { id: true } });
    const org = await db.organization.create({
      data: {
        slug,
        displayName: body.displayName,
        legalName: body.legalName ?? null,
        industry: body.industry ?? null,
        size: body.size ?? null,
        website: body.website ?? null,
        description: body.description ?? null,
        phone: body.phone ?? null,
        email: body.email ?? null,
        serviceArea: body.serviceArea ?? [],
        createdById: actor.personId,
        searchText: orgSearchText(body),
      },
    });
    await db.membership.create({ data: { personId: actor.personId, organizationId: org.id, role: "OWNER", affiliation: "VERIFIED_ADMIN", isPrimary: !hasPrimary, showOnProfile: true } });
    await audit(db, { actorId: actor.personId, action: "org.create", targetType: "Organization", targetId: org.id, organizationId: org.id, after: { displayName: org.displayName, slug: org.slug } });
    reply.status(201);
    return { id: org.id, slug: org.slug, displayName: org.displayName };
  });

  // ── member view + edit ───────────────────────────────────────────────────
  app.get("/organizations/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const org = await db.organization.findUnique({ where: { id } });
    if (!org) throw notFound("That company");
    const m = await membershipOf(db, actor.personId, id);
    if (!m && actor.staffRole !== "ADMIN") throw forbidden("You don't have access to this company's settings.");
    return { ...org, myPermissions: m ? [...permissionsForMembership(m)] : [...ORG_PERMISSIONS] };
  });

  app.patch("/organizations/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.edit_page");
    const body = patchOrgSchema.parse(req.body);
    const before = await db.organization.findUniqueOrThrow({ where: { id } });
    const data: Record<string, unknown> = { ...body };
    if ("hours" in body) data.hours = body.hours as object | null;
    const pick = <K extends string>(key: K, fallback: unknown) => (key in body ? (body as Record<string, unknown>)[key] : fallback);
    if (["displayName", "legalName", "industry", "description", "serviceArea"].some((k) => k in body)) {
      data.searchText = orgSearchText({
        displayName: pick("displayName", before.displayName) as string,
        legalName: pick("legalName", before.legalName) as string | null,
        industry: pick("industry", before.industry) as string | null,
        description: pick("description", before.description) as string | null,
        serviceArea: pick("serviceArea", before.serviceArea) as string[],
      });
    }
    const after = await db.organization.update({ where: { id }, data });
    const changed = Object.fromEntries(ORG_EDITABLE_FIELDS.filter((f) => f in body).map((f) => [f, (before as any)[f]]));
    await audit(db, { actorId: actor.personId, action: "org.update", targetType: "Organization", targetId: id, organizationId: id, before: changed, after: body });
    return after;
  });

  app.post("/organizations/:id/logo", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.edit_page");
    const file = await req.file();
    if (!file) throw badRequest("file_required", "Choose an image to upload.");
    const asset = await storeUpload(db, actor.personId, { buffer: await file.toBuffer(), filename: file.filename, mimetype: file.mimetype }, { allow: ["image"] });
    await db.organization.update({ where: { id }, data: { logoAssetId: asset.id } });
    await audit(db, { actorId: actor.personId, action: "org.logo_changed", targetType: "Organization", targetId: id, organizationId: id, after: { assetId: asset.id } });
    return { asset };
  });

  app.post("/organizations/:id/cover", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.edit_page");
    const file = await req.file();
    if (!file) throw badRequest("file_required", "Choose an image to upload.");
    const asset = await storeUpload(db, actor.personId, { buffer: await file.toBuffer(), filename: file.filename, mimetype: file.mimetype }, { allow: ["image"] });
    await db.organization.update({ where: { id }, data: { coverAssetId: asset.id } });
    await audit(db, { actorId: actor.personId, action: "org.cover_changed", targetType: "Organization", targetId: id, organizationId: id, after: { assetId: asset.id } });
    return { asset };
  });

  // ── locations ────────────────────────────────────────────────────────────
  const locationSchema = z.object({
    label: z.string().trim().min(1).max(80),
    address1: z.string().trim().max(200).optional(),
    city: z.string().trim().max(100).optional(),
    region: z.string().trim().max(100).optional(),
    postalCode: z.string().trim().max(20).optional(),
    country: z.string().trim().max(2).optional(),
    phone: z.string().trim().max(30).optional(),
    isHeadquarters: z.boolean().optional(),
  });

  app.get("/organizations/:id/locations", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const m = await membershipOf(db, actor.personId, id);
    if (!m && actor.staffRole !== "ADMIN") throw forbidden("You don't have access to this company's locations.");
    return { locations: await db.orgLocation.findMany({ where: { organizationId: id }, orderBy: { isHeadquarters: "desc" } }) };
  });

  app.post("/organizations/:id/locations", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.manage_locations");
    const body = locationSchema.parse(req.body);
    const loc = await db.orgLocation.create({ data: { organizationId: id, ...body } });
    await audit(db, { actorId: actor.personId, action: "org.location_added", targetType: "OrgLocation", targetId: loc.id, organizationId: id, after: body });
    reply.status(201);
    return loc;
  });

  app.patch("/organizations/:id/locations/:locId", async (req) => {
    const actor = requireActor(req);
    const { id, locId } = z.object({ id: z.string(), locId: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.manage_locations");
    const existing = await db.orgLocation.findFirst({ where: { id: locId, organizationId: id } });
    if (!existing) throw notFound("That location");
    const body = locationSchema.partial().parse(req.body);
    const loc = await db.orgLocation.update({ where: { id: locId }, data: body });
    await audit(db, { actorId: actor.personId, action: "org.location_updated", targetType: "OrgLocation", targetId: locId, organizationId: id, before: existing, after: body });
    return loc;
  });

  app.delete("/organizations/:id/locations/:locId", async (req) => {
    const actor = requireActor(req);
    const { id, locId } = z.object({ id: z.string(), locId: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.manage_locations");
    const existing = await db.orgLocation.findFirst({ where: { id: locId, organizationId: id } });
    if (!existing) throw notFound("That location");
    await db.orgLocation.delete({ where: { id: locId } });
    await audit(db, { actorId: actor.personId, action: "org.location_removed", targetType: "OrgLocation", targetId: locId, organizationId: id, before: existing });
    return { ok: true };
  });

  // ── members ──────────────────────────────────────────────────────────────
  app.get("/organizations/:id/members", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const m = await membershipOf(db, actor.personId, id);
    if (!m && actor.staffRole !== "ADMIN") throw forbidden("You don't have access to this company's members.");
    const memberships = await db.membership.findMany({ where: { organizationId: id }, orderBy: { createdAt: "asc" } });
    const cards = await personCards(db, memberships.map((x) => x.personId));
    return {
      members: memberships.map((x) => ({
        person: cards.get(x.personId) ?? { id: x.personId },
        role: x.role,
        permissions: [...permissionsForMembership(x)],
        explicitPermissions: x.permissions,
        affiliation: x.affiliation,
        title: x.title,
        isPrimary: x.isPrimary,
        showOnProfile: x.showOnProfile,
        since: x.createdAt,
      })),
    };
  });

  app.patch("/organizations/:id/members/:personId", async (req) => {
    const actor = requireActor(req);
    const { id, personId } = z.object({ id: z.string(), personId: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.manage_roles");
    const target = await db.membership.findUnique({ where: { personId_organizationId: { personId, organizationId: id } } });
    if (!target) throw notFound("That member");
    const body = z
      .object({ role: z.enum(ROLE_VALUES), permissions: z.array(permissionEnum), affiliation: z.enum(AFFILIATION_VALUES), title: z.string().trim().max(100).nullable() })
      .partial()
      .parse(req.body);
    if (target.role === "OWNER" && body.role && body.role !== "OWNER") {
      const others = await db.membership.findMany({ where: { organizationId: id, role: "OWNER" }, select: { personId: true } });
      if (!hasAnotherOwner(others.map((o) => ({ personId: o.personId, role: "OWNER" })), personId)) {
        throw conflict("last_owner", "This company needs at least one owner. Make someone else an owner first.");
      }
    }
    const updated = await db.membership.update({ where: { id: target.id }, data: body });
    await audit(db, { actorId: actor.personId, action: "org.member_updated", targetType: "Membership", targetId: target.id, organizationId: id, before: { role: target.role, permissions: target.permissions, affiliation: target.affiliation, title: target.title }, after: body });
    return { role: updated.role, permissions: [...permissionsForMembership(updated)], affiliation: updated.affiliation, title: updated.title };
  });

  app.delete("/organizations/:id/members/:personId", async (req) => {
    const actor = requireActor(req);
    const { id, personId } = z.object({ id: z.string(), personId: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.manage_members");
    const target = await db.membership.findUnique({ where: { personId_organizationId: { personId, organizationId: id } } });
    if (!target) throw notFound("That member");
    if (target.role === "OWNER") {
      const others = await db.membership.findMany({ where: { organizationId: id, role: "OWNER" }, select: { personId: true } });
      if (!hasAnotherOwner(others.map((o) => ({ personId: o.personId, role: "OWNER" })), personId)) {
        throw conflict("last_owner", "This company needs at least one owner. Make someone else an owner before removing this one.");
      }
    }
    await db.membership.delete({ where: { id: target.id } });
    await audit(db, { actorId: actor.personId, action: "org.member_removed", targetType: "Membership", targetId: target.id, organizationId: id, before: { personId, role: target.role } });
    return { ok: true };
  });

  // ── invites ──────────────────────────────────────────────────────────────
  app.get("/organizations/:id/invites", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.manage_members");
    const invites = await db.orgInvite.findMany({ where: { organizationId: id, acceptedAt: null }, orderBy: { createdAt: "desc" } });
    return { invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, permissions: i.permissions, expiresAt: i.expiresAt, createdAt: i.createdAt })) };
  });

  app.post("/organizations/:id/invites", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.manage_members");
    const body = z.object({ email: z.string().trim().toLowerCase().email().max(200), role: z.enum(ROLE_VALUES).default("EMPLOYEE"), permissions: z.array(permissionEnum).optional() }).parse(req.body);
    const org = await db.organization.findUniqueOrThrow({ where: { id } });
    const rawToken = token(24);
    const invite = await db.orgInvite.upsert({
      where: { organizationId_email: { organizationId: id, email: body.email } },
      create: { organizationId: id, email: body.email, role: body.role, permissions: body.permissions ?? [], tokenHash: sha256(rawToken), invitedById: actor.personId, expiresAt: new Date(Date.now() + 14 * 86_400_000) },
      update: { role: body.role, permissions: body.permissions ?? [], tokenHash: sha256(rawToken), invitedById: actor.personId, expiresAt: new Date(Date.now() + 14 * 86_400_000), acceptedAt: null },
    });
    const link = `${env().COMMUNITY_PUBLIC_URL}/company/invite?token=${rawToken}`;
    await sendMail(db, { to: body.email, subject: `You're invited to join ${org.displayName} on Loopcom Community`, text: `${actor.username} invited you to join ${org.displayName} as ${body.role.toLowerCase()}.\n\nAccept: ${link}\n\nThis link expires in 14 days.` });
    const existingPerson = await db.person.findUnique({ where: { email: body.email }, select: { id: true } });
    if (existingPerson) await notify(db, { personId: existingPerson.id, kind: "org.invite", title: `You've been invited to join ${org.displayName}`, href: "/company/invite", actorId: actor.personId });
    await audit(db, { actorId: actor.personId, action: "org.invite_sent", targetType: "OrgInvite", targetId: invite.id, organizationId: id, after: { email: body.email, role: body.role } });
    reply.status(201);
    return { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt };
  });

  app.delete("/organizations/:id/invites/:inviteId", async (req) => {
    const actor = requireActor(req);
    const { id, inviteId } = z.object({ id: z.string(), inviteId: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.manage_members");
    const invite = await db.orgInvite.findFirst({ where: { id: inviteId, organizationId: id } });
    if (!invite) throw notFound("That invite");
    await db.orgInvite.delete({ where: { id: inviteId } });
    await audit(db, { actorId: actor.personId, action: "org.invite_revoked", targetType: "OrgInvite", targetId: inviteId, organizationId: id, before: { email: invite.email } });
    return { ok: true };
  });

  app.post("/organizations/invites/accept", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const { token: rawToken } = z.object({ token: z.string().min(10) }).parse(req.body);
    const invite = await db.orgInvite.findUnique({ where: { tokenHash: sha256(rawToken) } });
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) throw badRequest("invite_invalid", "That invitation link isn't valid anymore. Ask for a new one.");
    const person = await db.person.findUniqueOrThrow({ where: { id: actor.personId }, select: { email: true } });
    if (person.email?.toLowerCase() !== invite.email) throw forbidden("This invitation was sent to a different email address.");
    const hasPrimary = await db.membership.findFirst({ where: { personId: actor.personId, isPrimary: true }, select: { id: true } });
    const membership = await db.membership.upsert({
      where: { personId_organizationId: { personId: actor.personId, organizationId: invite.organizationId } },
      create: { personId: actor.personId, organizationId: invite.organizationId, role: invite.role, permissions: invite.permissions, affiliation: "VERIFIED_ADMIN", isPrimary: !hasPrimary },
      update: { role: invite.role, permissions: invite.permissions, affiliation: "VERIFIED_ADMIN" },
    });
    await db.orgInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
    await audit(db, { actorId: actor.personId, action: "org.invite_accepted", targetType: "Membership", targetId: membership.id, organizationId: invite.organizationId, after: { role: invite.role } });
    const card = await orgCard(db, invite.organizationId);
    return { organization: card, role: membership.role };
  });

  // ── join requests ────────────────────────────────────────────────────────
  app.post("/organizations/:id/join", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const org = await db.organization.findUnique({ where: { id } });
    if (!org) throw notFound("That company");
    const { title } = z.object({ title: z.string().trim().max(100).optional() }).parse(req.body ?? {});
    const person = await db.person.findUniqueOrThrow({ where: { id: actor.personId }, select: { email: true, emailVerifiedAt: true } });
    const domainMatches = !!(org.domainVerifiedAt && org.domain && person.emailVerifiedAt && emailDomain(person.email) === org.domain);
    const affiliation = domainMatches ? "VERIFIED_DOMAIN" : "PENDING";
    const existing = await membershipOf(db, actor.personId, id);
    let membership;
    if (existing) {
      if (existing.affiliation === "VERIFIED_ADMIN" || existing.affiliation === "VERIFIED_DOMAIN") return { status: existing.affiliation, alreadyMember: true };
      membership = await db.membership.update({ where: { id: existing.id }, data: { affiliation, title: title ?? existing.title } });
    } else {
      const hasPrimary = await db.membership.findFirst({ where: { personId: actor.personId, isPrimary: true }, select: { id: true } });
      membership = await db.membership.create({ data: { personId: actor.personId, organizationId: id, affiliation, title: title ?? null, isPrimary: !hasPrimary } });
    }
    if (!domainMatches) {
      await notifyOrgHolders(db, id, ["OWNER", "ADMIN"], { kind: "org.invite", title: `${actor.username} asked to join ${org.displayName}`, href: "/company/admin", actorId: actor.personId });
    }
    await audit(db, { actorId: actor.personId, action: "org.join_requested", targetType: "Membership", targetId: membership.id, organizationId: id, after: { affiliation } });
    reply.status(domainMatches ? 200 : 201);
    return { status: membership.affiliation, alreadyMember: false };
  });

  // ── follow ───────────────────────────────────────────────────────────────
  app.post("/organizations/:id/follow", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const org = await db.organization.findUnique({ where: { id }, select: { id: true, displayName: true } });
    if (!org) throw notFound("That company");
    const existing = await db.follow.findUnique({ where: { followerId_organizationId: { followerId: actor.personId, organizationId: id } } });
    if (!existing) {
      await db.$transaction([
        db.follow.create({ data: { followerId: actor.personId, organizationId: id } }),
        db.organization.update({ where: { id }, data: { followerCount: { increment: 1 } } }),
      ]);
      await track(db, { personId: actor.personId, event: "company_follow", objectType: "Organization", objectId: id });
      await notifyOrgHolders(db, id, ["OWNER"], { kind: "follow.new", title: `${actor.username} followed ${org.displayName}`, href: `/companies/${id}`, actorId: actor.personId, groupKey: `follow:${id}` });
    }
    return { following: true };
  });

  app.delete("/organizations/:id/follow", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const existing = await db.follow.findUnique({ where: { followerId_organizationId: { followerId: actor.personId, organizationId: id } } });
    if (existing) {
      await db.$transaction([
        db.follow.delete({ where: { id: existing.id } }),
        db.organization.update({ where: { id }, data: { followerCount: { decrement: 1 } } }),
      ]);
      await track(db, { personId: actor.personId, event: "unfollow", objectType: "Organization", objectId: id });
    }
    return { following: false };
  });

  // ── claim / unlink a Loopcom tenant ─────────────────────────────────────
  app.post("/organizations/:id/claim-loopcom", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.edit_page");
    if (!actor.loopcomTenantId) throw badRequest("not_loopcom_linked", "Link your Loopcom account first (Settings → Account).");
    const clash = await db.organization.findUnique({ where: { loopcomTenantId: actor.loopcomTenantId }, select: { id: true } });
    if (clash && clash.id !== id) throw conflict("tenant_already_claimed", "That Loopcom account is already linked to a different company page.");
    await db.organization.update({ where: { id }, data: { loopcomTenantId: actor.loopcomTenantId, loopcomLinkedAt: new Date() } });
    const existing = await db.verification.findFirst({ where: { organizationId: id, kind: "LOOPCOM_CUSTOMER" } });
    if (existing) await db.verification.update({ where: { id: existing.id }, data: { status: "VERIFIED", reviewedAt: new Date(), evidence: { tenantId: actor.loopcomTenantId } } });
    else await db.verification.create({ data: { organizationId: id, kind: "LOOPCOM_CUSTOMER", status: "VERIFIED", reviewedAt: new Date(), evidence: { tenantId: actor.loopcomTenantId } } });
    await audit(db, { actorId: actor.personId, action: "org.loopcom_claimed", targetType: "Organization", targetId: id, organizationId: id, after: { tenantId: actor.loopcomTenantId } });
    return { loopcomLinked: true };
  });

  app.delete("/organizations/:id/claim-loopcom", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.edit_page");
    await db.organization.update({ where: { id }, data: { loopcomTenantId: null, loopcomLinkedAt: null } });
    await db.verification.updateMany({ where: { organizationId: id, kind: "LOOPCOM_CUSTOMER" }, data: { status: "EXPIRED" } });
    await audit(db, { actorId: actor.personId, action: "org.loopcom_unlinked", targetType: "Organization", targetId: id, organizationId: id });
    return { loopcomLinked: false };
  });

  // ── catalog ──────────────────────────────────────────────────────────────
  const catalogSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(1000).optional(), priceNote: z.string().trim().max(120).optional(), assetId: z.string().optional() });

  app.get("/organizations/:id/catalog", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return { catalog: await db.catalogItem.findMany({ where: { organizationId: id }, orderBy: { sortOrder: "asc" } }) };
  });

  app.post("/organizations/:id/catalog", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.edit_page");
    const body = catalogSchema.parse(req.body);
    const count = await db.catalogItem.count({ where: { organizationId: id } });
    const item = await db.catalogItem.create({ data: { organizationId: id, name: body.name, description: body.description ?? null, priceNote: body.priceNote ?? null, assetId: body.assetId ?? null, sortOrder: count } });
    reply.status(201);
    return item;
  });

  app.patch("/organizations/:id/catalog/:itemId", async (req) => {
    const actor = requireActor(req);
    const { id, itemId } = z.object({ id: z.string(), itemId: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.edit_page");
    const existing = await db.catalogItem.findFirst({ where: { id: itemId, organizationId: id } });
    if (!existing) throw notFound("That catalog item");
    const body = catalogSchema.partial().extend({ sortOrder: z.number().int().optional() }).parse(req.body);
    return db.catalogItem.update({ where: { id: itemId }, data: body });
  });

  app.delete("/organizations/:id/catalog/:itemId", async (req) => {
    const actor = requireActor(req);
    const { id, itemId } = z.object({ id: z.string(), itemId: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.edit_page");
    const existing = await db.catalogItem.findFirst({ where: { id: itemId, organizationId: id } });
    if (!existing) throw notFound("That catalog item");
    await db.catalogItem.delete({ where: { id: itemId } });
    return { ok: true };
  });

  // ── audit log ────────────────────────────────────────────────────────────
  app.get("/organizations/:id/audit", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.manage_roles");
    const { cursor, limit } = z.object({ cursor: z.string().optional(), limit: z.coerce.number().optional() }).parse(req.query);
    const c = decodeCursor(cursor);
    const lim = clampLimit(limit);
    const rows = await db.auditLog.findMany({
      where: { organizationId: id, ...(c ? { OR: [{ createdAt: { lt: new Date(c.value) } }, { createdAt: new Date(c.value), id: { lt: c.id } }] } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: lim + 1,
    });
    const page = rows.slice(0, lim);
    const nextCursor = rows.length > lim ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null;
    return { items: page, nextCursor };
  });
}
