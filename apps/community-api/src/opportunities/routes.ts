import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { Prisma } from "../db.js";
import { requireActor } from "../auth/actor.js";
import { requireNoRestriction, requireVerifiedActor } from "../auth/guards.js";
import { badRequest, conflict, forbidden, notFound, tooMany } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { track } from "../lib/analytics.js";
import { buildSearchText, ftsIds } from "../lib/search.js";
import { isBlockedEitherWay, pairKey } from "../policy/graph.js";
import { sendMessage } from "../messaging/service.js";
import { membershipOf } from "../organizations/permissions.js";
import { personCard, personCards, type PersonCard } from "../profiles/cards.js";
import { orgCard, orgCards, type OrgCard } from "../organizations/cards.js";
import { ensureOpportunityTypes, validateFields, type OpportunityField } from "./types.js";

const CreateOpportunitySchema = z.object({
  typeSlug: z.string().trim().min(1),
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(1).max(8000),
  fields: z.record(z.any()).optional(),
  location: z.string().trim().max(160).optional(),
  organizationId: z.string().trim().optional(),
  expiresInDays: z.coerce.number().int().min(1).max(365).optional(),
});

const PatchOpportunitySchema = z.object({
  title: z.string().trim().min(3).max(160).optional(),
  description: z.string().trim().min(1).max(8000).optional(),
  fields: z.record(z.any()).optional(),
  location: z.string().trim().max(160).nullable().optional(),
});

const ListQuerySchema = z.object({
  type: z.string().trim().max(80).optional(),
  q: z.string().trim().max(200).optional(),
  location: z.string().trim().max(160).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const RATE_LIMIT_PER_DAY = 20;

function offsetOf(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function encodeOffset(n: number): string {
  return Buffer.from(String(n)).toString("base64url");
}

type OppRow = NonNullable<Awaited<ReturnType<Db["opportunity"]["findUnique"]>>>;

async function shapeMany(db: Db, rows: OppRow[], viewerId: string | null) {
  const orgIds = [...new Set(rows.map((r) => r.organizationId).filter((x): x is string => !!x))];
  const posterIds = [...new Set(rows.map((r) => r.posterId))];
  const typeIds = [...new Set(rows.map((r) => r.typeId))];
  const [orgs, people, types, myInterests] = await Promise.all([
    orgCards(db, orgIds),
    personCards(db, posterIds),
    db.opportunityType.findMany({ where: { id: { in: typeIds } } }),
    viewerId ? db.opportunityInterest.findMany({ where: { personId: viewerId, opportunityId: { in: rows.map((r) => r.id) } }, select: { opportunityId: true } }) : Promise.resolve([]),
  ]);
  const typeById = new Map(types.map((t) => [t.id, t]));
  const myInterestSet = new Set(myInterests.map((i) => i.opportunityId));
  return rows.map((r) => shapeOne(r, orgs, people, typeById, myInterestSet));
}

function shapeOne(
  r: OppRow,
  orgs: Map<string, OrgCard>,
  people: Map<string, PersonCard>,
  typeById: Map<string, { id: string; slug: string; name: string; fieldSchema: unknown }>,
  myInterestSet: Set<string>,
) {
  const type = typeById.get(r.typeId);
  return {
    opportunity: {
      id: r.id,
      title: r.title,
      description: r.description,
      fields: r.fields ?? {},
      location: r.location,
      status: r.status,
      interestCount: r.interestCount,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    },
    type: type ? { id: type.id, slug: type.slug, name: type.name, fieldSchema: type.fieldSchema } : null,
    poster: people.get(r.posterId) ?? null,
    organization: r.organizationId ? orgs.get(r.organizationId) ?? null : null,
    interestCount: r.interestCount,
    myInterest: myInterestSet.has(r.id),
  };
}

export async function registerOpportunityRoutes(app: FastifyInstance, db: Db) {
  await ensureOpportunityTypes(db);

  /* ───────────────────────────── Types ───────────────────────────── */
  app.get("/opportunities/types", async () => {
    const types = await db.opportunityType.findMany({ orderBy: { sortOrder: "asc" } });
    const counts = await db.opportunity.groupBy({ by: ["typeId"], where: { status: "OPEN", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, _count: { _all: true } });
    const countMap = new Map(counts.map((c) => [c.typeId, c._count._all]));
    return {
      types: types.map((t) => ({ id: t.id, slug: t.slug, name: t.name, description: t.description, fieldSchema: t.fieldSchema, count: countMap.get(t.id) ?? 0 })),
    };
  });

  /* ───────────────────────────── Create ───────────────────────────── */
  app.post("/opportunities", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    await requireNoRestriction(db, actor.personId, "OUTREACH");
    const input = CreateOpportunitySchema.parse(req.body);

    const type = await db.opportunityType.findUnique({ where: { slug: input.typeSlug } });
    if (!type) throw badRequest("type_not_found", "Choose a valid opportunity type.");
    const errors = validateFields(type.fieldSchema as unknown as OpportunityField[], input.fields);
    if (errors.length) throw badRequest("invalid_fields", errors.join(" "));

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const postedToday = await db.opportunity.count({ where: { posterId: actor.personId, createdAt: { gte: since } } });
    if (postedToday >= RATE_LIMIT_PER_DAY) throw tooMany("You've posted the daily limit of opportunities. Try again tomorrow.");

    let organizationId: string | null = null;
    let ownerName = "";
    if (input.organizationId) {
      const m = await membershipOf(db, actor.personId, input.organizationId);
      if (!m) throw forbidden("You're not a member of that company.");
      organizationId = input.organizationId;
      ownerName = (await orgCard(db, organizationId))?.displayName ?? "";
    } else {
      ownerName = (await personCard(db, actor.personId))?.name ?? "";
    }

    const fieldValues = input.fields ? Object.values(input.fields).map((v) => String(v)) : [];
    const searchText = buildSearchText([input.title, input.description, type.name, input.location, ownerName, fieldValues]);
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000) : null;

    const created = await db.opportunity.create({
      data: {
        typeId: type.id,
        posterId: actor.personId,
        organizationId,
        title: input.title,
        description: input.description,
        fields: (input.fields ?? {}) as object,
        location: input.location ?? null,
        expiresAt,
        searchText,
      },
    });

    await audit(db, { actorId: actor.personId, action: "opportunity.create", targetType: "Opportunity", targetId: created.id, organizationId, after: { title: created.title, type: type.slug } });
    reply.status(201);
    const [shaped] = await shapeMany(db, [created], actor.personId);
    return shaped;
  });

  /* ───────────────────────────── Browse ───────────────────────────── */
  app.get("/opportunities", async (req) => {
    const actor = requireActor(req);
    const q = ListQuerySchema.parse(req.query);
    const take = q.limit ?? 20;
    const offset = offsetOf(q.cursor);

    const where: Record<string, unknown> = { status: "OPEN", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] };
    if (q.type) {
      const type = await db.opportunityType.findUnique({ where: { slug: q.type } });
      if (!type) return { items: [], nextCursor: null };
      where.typeId = type.id;
    }
    if (q.location) where.location = { contains: q.location, mode: "insensitive" };

    let ids: string[] | null = null;
    if (q.q) {
      const rows = await ftsIds(db, "Opportunity", "id", q.q, 300, Prisma.sql`AND "status" = 'OPEN'`);
      ids = rows.map((r) => r.id);
      if (!ids.length) {
        await track(db, { personId: actor.personId, event: "opportunity_view", props: { q: q.q } });
        return { items: [], nextCursor: null };
      }
      where.id = { in: ids };
    }

    let rows = await db.opportunity.findMany({ where: where as any, take: 500 });
    if (ids) {
      const rank = new Map(ids.map((id, i) => [id, i]));
      rows = [...rows].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
    } else {
      rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
    }

    const page = rows.slice(offset, offset + take);
    const nextCursor = offset + take < rows.length ? encodeOffset(offset + take) : null;
    const items = await shapeMany(db, page, actor.personId);
    return { items, nextCursor };
  });

  app.get("/public/opportunities/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const opp = await db.opportunity.findUnique({ where: { id } });
    if (!opp) throw notFound("That opportunity");
    await track(db, { personId: req.actor?.personId ?? null, event: "opportunity_view", objectType: "Opportunity", objectId: id });
    const [shaped] = await shapeMany(db, [opp], req.actor?.personId ?? null);
    return shaped;
  });

  async function loadMine(actorId: string, id: string): Promise<OppRow> {
    const opp = await db.opportunity.findUnique({ where: { id } });
    if (!opp) throw notFound("That opportunity");
    if (opp.posterId !== actorId) throw forbidden("Only the person who posted this can do that.");
    return opp;
  }

  app.patch("/opportunities/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const before = await loadMine(actor.personId, id);
    const input = PatchOpportunitySchema.parse(req.body);

    let fields = before.fields as Record<string, unknown> | null;
    if (input.fields) {
      const type = await db.opportunityType.findUnique({ where: { id: before.typeId } });
      const errors = validateFields(type!.fieldSchema as unknown as OpportunityField[], input.fields);
      if (errors.length) throw badRequest("invalid_fields", errors.join(" "));
      fields = input.fields;
    }

    const ownerName = before.organizationId ? (await orgCard(db, before.organizationId))?.displayName ?? "" : (await personCard(db, before.posterId))?.name ?? "";
    const type = await db.opportunityType.findUnique({ where: { id: before.typeId } });
    const fieldValues = fields ? Object.values(fields).map((v) => String(v)) : [];
    const searchText = buildSearchText([input.title ?? before.title, input.description ?? before.description, type?.name, input.location === undefined ? before.location : input.location, ownerName, fieldValues]);

    const updated = await db.opportunity.update({
      where: { id },
      data: { title: input.title, description: input.description, fields: fields as object, location: input.location === undefined ? undefined : input.location, searchText },
    });
    await audit(db, { actorId: actor.personId, action: "opportunity.update", targetType: "Opportunity", targetId: id, organizationId: before.organizationId, before: { title: before.title }, after: { title: updated.title } });
    const [shaped] = await shapeMany(db, [updated], actor.personId);
    return shaped;
  });

  app.delete("/opportunities/:id", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const before = await loadMine(actor.personId, id);
    await db.opportunity.update({ where: { id }, data: { status: "REMOVED" } });
    await audit(db, { actorId: actor.personId, action: "opportunity.remove", targetType: "Opportunity", targetId: id, organizationId: before.organizationId });
    reply.status(204);
    return null;
  });

  app.post("/opportunities/:id/close", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const before = await loadMine(actor.personId, id);
    const updated = await db.opportunity.update({ where: { id }, data: { status: "CLOSED" } });
    await audit(db, { actorId: actor.personId, action: "opportunity.close", targetType: "Opportunity", targetId: id, organizationId: before.organizationId });
    const [shaped] = await shapeMany(db, [updated], actor.personId);
    return shaped;
  });

  /* ───────────────────────────── Interest / question ───────────────────────────── */
  async function findOrCreateConsentThread(actorId: string, otherId: string, opportunityId: string) {
    if (actorId === otherId) throw badRequest("cant_message_self", "That's your own opportunity.");
    if (await isBlockedEitherWay(db, actorId, otherId)) throw notFound("That opportunity");
    const key = pairKey(actorId, otherId);
    let thread = await db.thread.findUnique({ where: { pairKey: key } });
    if (!thread) {
      thread = await db.thread.create({
        data: {
          kind: "DIRECT",
          pairKey: key,
          refType: "Opportunity",
          refId: opportunityId,
          createdById: actorId,
          participants: { create: [{ personId: actorId, state: "ACTIVE", role: "MEMBER" }, { personId: otherId, state: "ACTIVE", role: "MEMBER" }] },
        },
      });
    }
    return thread;
  }

  app.post("/opportunities/:id/interest", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { message } = z.object({ message: z.string().trim().max(2000).optional() }).parse(req.body ?? {});
    const opp = await db.opportunity.findUnique({ where: { id } });
    if (!opp || opp.status !== "OPEN") throw notFound("That opportunity");
    if (opp.posterId === actor.personId) throw badRequest("own_opportunity", "You can't express interest in your own opportunity.");

    const existing = await db.opportunityInterest.findUnique({ where: { opportunityId_personId: { opportunityId: id, personId: actor.personId } } });
    if (existing) throw conflict("already_interested", "You already expressed interest in this opportunity.");

    const thread = await findOrCreateConsentThread(actor.personId, opp.posterId, id);
    const interestedCard = await personCard(db, actor.personId);
    const body = message?.trim() || `${interestedCard?.name ?? "Someone"} is interested in "${opp.title}".`;
    await sendMessage(db, actor.personId, thread.id, { kind: "TEXT", body, refType: "Opportunity", refId: id });

    const [interest] = await db.$transaction([
      db.opportunityInterest.create({ data: { opportunityId: id, personId: actor.personId, message: message ?? null, threadId: thread.id } }),
      db.opportunity.update({ where: { id }, data: { interestCount: { increment: 1 } } }),
    ]);

    await notify(db, {
      personId: opp.posterId,
      kind: "opportunity.interest",
      title: "Someone is interested in your opportunity",
      body: `About "${opp.title}"`,
      href: `/opportunities/${id}`,
      actorId: actor.personId,
      objectType: "Opportunity",
      objectId: id,
    });
    reply.status(201);
    return { opportunityId: id, threadId: thread.id, message: interest.message, createdAt: interest.createdAt.toISOString() };
  });

  app.delete("/opportunities/:id/interest", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const existing = await db.opportunityInterest.findUnique({ where: { opportunityId_personId: { opportunityId: id, personId: actor.personId } } });
    if (!existing) throw notFound("That interest");
    await db.$transaction([
      db.opportunityInterest.delete({ where: { opportunityId_personId: { opportunityId: id, personId: actor.personId } } }),
      db.opportunity.update({ where: { id }, data: { interestCount: { decrement: 1 } } }),
    ]);
    reply.status(204);
    return null;
  });

  app.get("/opportunities/:id/interests", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await loadMine(actor.personId, id);
    const rows = await db.opportunityInterest.findMany({ where: { opportunityId: id }, orderBy: { createdAt: "desc" } });
    const cards = await personCards(db, rows.map((r) => r.personId));
    return {
      interests: rows.map((r) => ({ person: cards.get(r.personId) ?? null, message: r.message, threadId: r.threadId, createdAt: r.createdAt.toISOString() })),
    };
  });

  app.post("/opportunities/:id/question", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { question } = z.object({ question: z.string().trim().min(1).max(2000) }).parse(req.body);
    const opp = await db.opportunity.findUnique({ where: { id } });
    if (!opp || opp.status !== "OPEN") throw notFound("That opportunity");
    if (opp.posterId === actor.personId) throw badRequest("own_opportunity", "You can't ask a question about your own opportunity.");

    const thread = await findOrCreateConsentThread(actor.personId, opp.posterId, id);
    await sendMessage(db, actor.personId, thread.id, { kind: "TEXT", body: question, refType: "Opportunity", refId: id });
    await notify(db, {
      personId: opp.posterId,
      kind: "inquiry.business",
      title: "A question about your opportunity",
      body: `About "${opp.title}"`,
      href: `/opportunities/${id}`,
      actorId: actor.personId,
      objectType: "Opportunity",
      objectId: id,
    });
    reply.status(201);
    return { threadId: thread.id };
  });
}
