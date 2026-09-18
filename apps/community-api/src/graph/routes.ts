import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { requireActor } from "../auth/actor.js";
import { requireVerifiedActor, requireNoRestriction } from "../auth/guards.js";
import { audit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { track } from "../lib/analytics.js";
import { publishTo } from "../lib/realtime.js";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { normalizePhone } from "../lib/phone.js";
import { pairKey, canonicalPair, isBlockedEitherWay, connectionIds, mutualConnections } from "../policy/graph.js";
import { personCards, type PersonCard } from "../profiles/cards.js";
import { orgCards } from "../organizations/cards.js";
import { RELATIONSHIP_COMPLEMENT, RELATIONSHIP_FILTER_KIND, ignoredCooldownOver, ignoredCooldownMessage } from "./policy.js";
import { assertOutreachAllowed, recordOutreachSent, recomputeAcceptedRate } from "./antispam.js";

const RELATIONSHIP_KINDS = ["WORKED_WITH", "PURCHASED_FROM", "SOLD_TO", "REFERRED", "PARTNER", "CUSTOMER", "VENDOR", "MENTOR"] as const;
const REPORT_REASONS = ["SPAM", "SCAM", "HARASSMENT", "IMPERSONATION", "PHISHING", "MALWARE", "FAKE_JOB", "FAKE_COMPANY", "FAKE_REVIEW", "BOT", "MASS_SOLICITATION", "OTHER"] as const;
const REPORT_TARGET_TYPES = ["person", "organization", "post", "comment", "message", "job", "listing", "rfq", "event", "group"] as const;

const CONNECTION_FILTERS = ["all", "customers", "vendors", "worked_with", "referred", "partners", "loopcom"] as const;

export function registerGraphRoutes(app: FastifyInstance, db: Db) {
  /* ─────────────────────────── Connections ─────────────────────────── */

  app.post("/connections/request", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const body = z.object({ personId: z.string().min(1), message: z.string().trim().max(1000).optional() }).parse(req.body);
    await requireNoRestriction(db, actor.personId, "OUTREACH");
    if (body.personId === actor.personId) throw badRequest("self_connection", "You can't send a connection request to yourself.");

    const target = await db.person.findUnique({ where: { id: body.personId }, select: { id: true } });
    if (!target) throw notFound("That person");
    if (await isBlockedEitherWay(db, actor.personId, body.personId)) throw notFound("That person");

    const pair = canonicalPair(actor.personId, body.personId);
    const existing = await db.connection.findUnique({ where: { aId_bId: pair } });

    if (existing) {
      if (existing.status === "ACTIVE") throw conflict("already_connected", "You're already connected.");
      if (existing.status === "PENDING") {
        if (existing.requesterId === actor.personId) {
          return reply.status(200).send({ id: existing.id, status: existing.status });
        }
        // They already asked us — accepting their request instead of sending a second one.
        const updated = await acceptConnection(db, existing.id, existing);
        return reply.status(200).send({ id: updated.id, status: updated.status });
      }
      if (existing.status === "IGNORED" && !ignoredCooldownOver(existing.updatedAt)) {
        throw conflict("recently_ignored", ignoredCooldownMessage());
      }
      // WITHDRAWN / IGNORED (cooled down) / REMOVED — reopen as a fresh ask.
      await assertOutreachAllowed(db, actor.personId);
      const reopened = await db.connection.update({
        where: { id: existing.id },
        data: { status: "PENDING", requesterId: actor.personId, message: body.message ?? null, acceptedAt: null },
      });
      await recordOutreachSent(db, actor.personId);
      const recipientId = reopened.aId === actor.personId ? reopened.bId : reopened.aId;
      await notify(db, { personId: recipientId, kind: "connection.request", title: "New connection request", body: body.message ?? null, href: "/network", actorId: actor.personId, objectType: "connection", objectId: reopened.id });
      await track(db, { personId: actor.personId, event: "connection_request", objectType: "person", objectId: body.personId });
      return reply.status(200).send({ id: reopened.id, status: reopened.status });
    }

    await assertOutreachAllowed(db, actor.personId);
    const created = await db.connection.create({
      data: { aId: pair.aId, bId: pair.bId, requesterId: actor.personId, message: body.message ?? null, status: "PENDING" },
    });
    await recordOutreachSent(db, actor.personId);
    await notify(db, { personId: body.personId, kind: "connection.request", title: "New connection request", body: body.message ?? null, href: "/network", actorId: actor.personId, objectType: "connection", objectId: created.id });
    await track(db, { personId: actor.personId, event: "connection_request", objectType: "person", objectId: body.personId });
    return reply.status(201).send({ id: created.id, status: created.status });
  });

  async function acceptConnection(db: Db, id: string, row: { aId: string; bId: string; requesterId: string; status: string }) {
    const updated = await db.connection.update({ where: { id }, data: { status: "ACTIVE", acceptedAt: new Date() } });
    const otherId = row.requesterId === row.aId ? row.bId : row.aId;
    await notify(db, { personId: row.requesterId, kind: "connection.accepted", title: "Connection accepted", href: "/connections", actorId: otherId, objectType: "connection", objectId: id });
    await publishTo(row.aId, "connection", { personId: row.bId, status: "ACTIVE" });
    await publishTo(row.bId, "connection", { personId: row.aId, status: "ACTIVE" });
    await track(db, { personId: otherId, event: "connection_accept", objectType: "person", objectId: row.requesterId });
    await recomputeAcceptedRate(db, row.requesterId);
    return updated;
  }

  app.post("/connections/:id/accept", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const row = await db.connection.findUnique({ where: { id } });
    if (!row) throw notFound("That request");
    const recipientId = row.requesterId === row.aId ? row.bId : row.aId;
    if (recipientId !== actor.personId) throw forbidden("Only the recipient can accept this request.");
    if (row.status !== "PENDING") throw conflict("not_pending", "That request isn't pending anymore.");
    const updated = await acceptConnection(db, id, row);
    return reply.send({ id: updated.id, status: updated.status });
  });

  app.post("/connections/:id/ignore", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const row = await db.connection.findUnique({ where: { id } });
    if (!row) throw notFound("That request");
    const recipientId = row.requesterId === row.aId ? row.bId : row.aId;
    if (recipientId !== actor.personId) throw forbidden("Only the recipient can ignore this request.");
    if (row.status !== "PENDING") throw conflict("not_pending", "That request isn't pending anymore.");
    const updated = await db.connection.update({ where: { id }, data: { status: "IGNORED" } });
    return reply.send({ id: updated.id, status: updated.status });
  });

  app.post("/connections/:id/withdraw", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const row = await db.connection.findUnique({ where: { id } });
    if (!row) throw notFound("That request");
    if (row.requesterId !== actor.personId) throw forbidden("Only the person who sent this request can withdraw it.");
    if (row.status !== "PENDING") throw conflict("not_pending", "That request isn't pending anymore.");
    const updated = await db.connection.update({ where: { id }, data: { status: "WITHDRAWN" } });
    return reply.send({ id: updated.id, status: updated.status });
  });

  app.delete("/connections/:id", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const row = await db.connection.findUnique({ where: { id } });
    if (!row) throw notFound("That connection");
    if (row.aId !== actor.personId && row.bId !== actor.personId) throw forbidden("That's not your connection.");
    if (row.status !== "ACTIVE") throw conflict("not_active", "That connection isn't active.");
    await db.connection.update({ where: { id }, data: { status: "REMOVED" } });
    return reply.send({ id, status: "REMOVED" });
  });

  /* Shared list builder used by GET /connections and the CSV export. */
  async function loadConnectionRows(db: Db, personId: string) {
    const rows = await db.connection.findMany({
      where: { status: "ACTIVE", OR: [{ aId: personId }, { bId: personId }] },
      orderBy: { acceptedAt: "desc" },
    });
    const partnerIds = rows.map((r) => (r.aId === personId ? r.bId : r.aId));
    const [cards, tags, threads, loopcomRows] = await Promise.all([
      personCards(db, partnerIds),
      db.relationshipTag.findMany({ where: { ownerId: personId, targetPersonId: { in: partnerIds } }, select: { targetPersonId: true, kind: true } }),
      db.thread.findMany({ where: { kind: "DIRECT", pairKey: { in: partnerIds.map((p) => pairKey(personId, p)) } }, select: { id: true, pairKey: true } }),
      db.person.findMany({ where: { id: { in: partnerIds }, loopcomTenantId: { not: null } }, select: { id: true } }),
    ]);
    const threadIds = threads.map((t) => t.id);
    const lastMsgByThread = threadIds.length
      ? await db.message.groupBy({ by: ["threadId"], where: { threadId: { in: threadIds }, deletedAt: null }, _max: { createdAt: true } })
      : [];
    const threadByPair = new Map(threads.map((t) => [t.pairKey!, t.id]));
    const lastByThread = new Map(lastMsgByThread.map((m) => [m.threadId, m._max.createdAt]));
    const loopcomIds = new Set(loopcomRows.map((r) => r.id));

    return rows.map((r) => {
      const partnerId = r.aId === personId ? r.bId : r.aId;
      const threadId = threadByPair.get(pairKey(personId, partnerId));
      return {
        connection: { id: r.id, acceptedAt: r.acceptedAt },
        person: cards.get(partnerId) ?? null,
        relationship: tags.filter((t) => t.targetPersonId === partnerId).map((t) => t.kind),
        lastContactAt: threadId ? lastByThread.get(threadId) ?? null : null,
        loopcomLinked: loopcomIds.has(partnerId),
      };
    }).filter((r) => r.person !== null) as Array<{ connection: { id: string; acceptedAt: Date | null }; person: PersonCard; relationship: string[]; lastContactAt: Date | null; loopcomLinked: boolean }>;
  }

  function applyConnectionFilters(all: Awaited<ReturnType<typeof loadConnectionRows>>, filter: string, q: string, tag: string) {
    let out = all;
    if (filter && filter !== "all") {
      if (filter === "loopcom") out = out.filter((r) => r.loopcomLinked);
      else {
        const kind = RELATIONSHIP_FILTER_KIND[filter];
        if (kind) out = out.filter((r) => r.relationship.includes(kind));
      }
    }
    if (tag) out = out.filter((r) => r.relationship.includes(tag as any));
    if (q) {
      const needle = q.trim().toLowerCase();
      out = out.filter(
        (r) =>
          r.person.name.toLowerCase().includes(needle) ||
          (r.person.headline ?? "").toLowerCase().includes(needle) ||
          (r.person.primaryOrg?.displayName ?? "").toLowerCase().includes(needle),
      );
    }
    return out;
  }

  app.get("/connections", async (req, reply) => {
    const actor = requireActor(req);
    const query = z.object({ filter: z.enum(CONNECTION_FILTERS).optional(), q: z.string().optional(), tag: z.string().optional(), cursor: z.string().optional(), limit: z.string().optional() }).parse(req.query);
    const all = applyConnectionFilters(await loadConnectionRows(db, actor.personId), query.filter ?? "all", query.q ?? "", query.tag ?? "");
    const limit = clampLimit(query.limit, 25, 100);
    const cursor = decodeCursor(query.cursor);
    let startIndex = 0;
    if (cursor) {
      const idx = all.findIndex((r) => r.connection.id === cursor.id);
      startIndex = idx >= 0 ? idx + 1 : 0;
    }
    const page = all.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < all.length ? encodeCursor(page[page.length - 1]?.connection.acceptedAt ?? new Date(), page[page.length - 1]?.connection.id ?? "") : null;
    return reply.send({ items: page, nextCursor, total: all.length });
  });

  app.get("/connections/counts", async (req, reply) => {
    const actor = requireActor(req);
    const all = await loadConnectionRows(db, actor.personId);
    const counts: Record<string, number> = { all: all.length };
    for (const [filterKey, kind] of Object.entries(RELATIONSHIP_FILTER_KIND)) counts[filterKey] = all.filter((r) => r.relationship.includes(kind)).length;
    counts.loopcom = all.filter((r) => r.loopcomLinked).length;
    return reply.send({ counts });
  });

  app.get("/connections/export.csv", async (req, reply) => {
    const actor = requireActor(req);
    const all = await loadConnectionRows(db, actor.personId);
    const header = "Name,Username,Headline,Location,Relationship,Connected\n";
    const rows = all
      .map((r) => {
        const cells = [r.person.name, r.person.username, r.person.headline ?? "", r.person.location ?? "", r.relationship.join(" | "), r.connection.acceptedAt ? new Date(r.connection.acceptedAt).toISOString().slice(0, 10) : ""];
        return cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",");
      })
      .join("\n");
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="connections.csv"');
    return reply.send(header + rows + "\n");
  });

  app.get("/connections/pending", async (req, reply) => {
    const actor = requireActor(req);
    // Ignore is silent to the requester: their outgoing tab still reads "pending"
    // even after the recipient quietly closed it, so we also pull IGNORED rows
    // and only ever surface those on the requester's own outgoing side.
    const rows = await db.connection.findMany({ where: { status: { in: ["PENDING", "IGNORED"] }, OR: [{ aId: actor.personId }, { bId: actor.personId }] }, orderBy: { createdAt: "desc" } });
    const incomingRows = rows.filter((r) => r.requesterId !== actor.personId && r.status === "PENDING");
    const outgoingRows = rows.filter((r) => r.requesterId === actor.personId);
    const partnerIds = rows.map((r) => (r.aId === actor.personId ? r.bId : r.aId));
    const cards = await personCards(db, partnerIds);
    const shape = (r: (typeof rows)[number]) => {
      const partnerId = r.aId === actor.personId ? r.bId : r.aId;
      return { id: r.id, person: cards.get(partnerId) ?? null, message: r.message, createdAt: r.createdAt };
    };
    return reply.send({ incoming: incomingRows.map(shape), outgoing: outgoingRows.map(shape) });
  });

  app.get("/people/:id/mutual", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const result = await mutualConnections(db, actor.personId, id);
    return reply.send(result);
  });

  /* ─────────────────────────── Follow ─────────────────────────── */

  app.post("/people/:id/follow", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    if (id === actor.personId) throw badRequest("self_follow", "You can't follow yourself.");
    const target = await db.person.findUnique({ where: { id }, select: { id: true } });
    if (!target || (await isBlockedEitherWay(db, actor.personId, id))) throw notFound("That person");
    await db.follow.upsert({ where: { followerId_personId: { followerId: actor.personId, personId: id } }, create: { followerId: actor.personId, personId: id }, update: {} });
    await notify(db, { personId: id, kind: "follow.new", title: "New follower", href: `/people/${id}`, actorId: actor.personId, objectType: "person", objectId: actor.personId, groupKey: `follow:${id}` });
    await track(db, { personId: actor.personId, event: "follow", objectType: "person", objectId: id });
    return reply.status(200).send({ following: true });
  });

  app.delete("/people/:id/follow", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await db.follow.deleteMany({ where: { followerId: actor.personId, personId: id } });
    await track(db, { personId: actor.personId, event: "unfollow", objectType: "person", objectId: id });
    return reply.send({ following: false });
  });

  app.get("/me/following", async (req, reply) => {
    const actor = requireActor(req);
    const query = z.object({ type: z.enum(["people", "organizations"]).default("people") }).parse(req.query);
    if (query.type === "organizations") {
      const rows = await db.follow.findMany({ where: { followerId: actor.personId, organizationId: { not: null } } });
      const cards = await orgCards(db, rows.map((r) => r.organizationId!));
      return reply.send({ items: rows.map((r) => cards.get(r.organizationId!)).filter(Boolean) });
    }
    const rows = await db.follow.findMany({ where: { followerId: actor.personId, personId: { not: null } } });
    const cards = await personCards(db, rows.map((r) => r.personId!));
    return reply.send({ items: rows.map((r) => cards.get(r.personId!)).filter(Boolean) });
  });

  /* ─────────────────────────── Block ─────────────────────────── */

  app.post("/people/:id/block", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    if (id === actor.personId) throw badRequest("self_block", "You can't block yourself.");
    const target = await db.person.findUnique({ where: { id }, select: { id: true } });
    if (!target) throw notFound("That person");

    await db.block.upsert({ where: { blockerId_blockedId: { blockerId: actor.personId, blockedId: id } }, create: { blockerId: actor.personId, blockedId: id }, update: {} });

    const pair = canonicalPair(actor.personId, id);
    const conn = await db.connection.findUnique({ where: { aId_bId: pair } });
    if (conn && (conn.status === "ACTIVE" || conn.status === "PENDING")) {
      await db.connection.update({ where: { id: conn.id }, data: { status: "REMOVED" } });
    }
    await db.follow.deleteMany({ where: { OR: [{ followerId: actor.personId, personId: id }, { followerId: id, personId: actor.personId }] } });
    const pk = pairKey(actor.personId, id);
    const thread = await db.thread.findFirst({ where: { kind: "DIRECT", pairKey: pk } });
    if (thread) {
      await db.threadParticipant.updateMany({ where: { threadId: thread.id, personId: { in: [actor.personId, id] } }, data: { state: "LEFT" } });
    }
    await audit(db, { actorId: actor.personId, action: "person.block", targetType: "person", targetId: id });
    return reply.status(200).send({ blocked: true });
  });

  app.delete("/people/:id/block", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await db.block.deleteMany({ where: { blockerId: actor.personId, blockedId: id } });
    await audit(db, { actorId: actor.personId, action: "person.unblock", targetType: "person", targetId: id });
    return reply.send({ blocked: false });
  });

  app.get("/me/blocked", async (req, reply) => {
    const actor = requireActor(req);
    const rows = await db.block.findMany({ where: { blockerId: actor.personId }, orderBy: { createdAt: "desc" } });
    const cards = await personCards(db, rows.map((r) => r.blockedId));
    return reply.send({ items: rows.map((r) => ({ person: cards.get(r.blockedId) ?? null, createdAt: r.createdAt })).filter((r) => r.person) });
  });

  /* ─────────────────────────── Mute ─────────────────────────── */

  app.post("/people/:id/mute", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await db.mute.upsert({ where: { personId_targetPersonId: { personId: actor.personId, targetPersonId: id } }, create: { personId: actor.personId, targetPersonId: id }, update: {} });
    return reply.status(200).send({ muted: true });
  });
  app.delete("/people/:id/mute", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await db.mute.deleteMany({ where: { personId: actor.personId, targetPersonId: id } });
    return reply.send({ muted: false });
  });
  app.post("/organizations/:id/mute", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await db.mute.upsert({ where: { personId_targetOrgId: { personId: actor.personId, targetOrgId: id } }, create: { personId: actor.personId, targetOrgId: id }, update: {} });
    return reply.status(200).send({ muted: true });
  });
  app.delete("/organizations/:id/mute", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await db.mute.deleteMany({ where: { personId: actor.personId, targetOrgId: id } });
    return reply.send({ muted: false });
  });
  app.get("/me/muted", async (req, reply) => {
    const actor = requireActor(req);
    const rows = await db.mute.findMany({ where: { personId: actor.personId } });
    const personIds = rows.filter((r) => r.targetPersonId).map((r) => r.targetPersonId!);
    const orgIds = rows.filter((r) => r.targetOrgId).map((r) => r.targetOrgId!);
    const [people, orgs] = await Promise.all([personCards(db, personIds), orgCards(db, orgIds)]);
    return reply.send({ people: [...people.values()], organizations: [...orgs.values()] });
  });

  /* ─────────────────────────── Relationship tags ─────────────────────────── */

  const relKindsSchema = z.object({ kinds: z.array(z.enum(RELATIONSHIP_KINDS)) });

  app.put("/people/:id/relationship", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = relKindsSchema.parse(req.body);
    const pair = canonicalPair(actor.personId, id);
    const conn = await db.connection.findUnique({ where: { aId_bId: pair } });
    if (!conn || conn.status !== "ACTIVE") throw badRequest("not_connected", "Add them as a connection first to tag the relationship.");

    await db.$transaction([
      db.relationshipTag.deleteMany({ where: { ownerId: actor.personId, targetPersonId: id } }),
      ...body.kinds.map((kind) => db.relationshipTag.create({ data: { ownerId: actor.personId, targetPersonId: id, kind } })),
    ]);

    await recomputePersonMutuality(db, actor.personId, id);
    const mine = await db.relationshipTag.findMany({ where: { ownerId: actor.personId, targetPersonId: id } });
    return reply.send({ kinds: mine.map((t) => ({ kind: t.kind, mutual: t.mutual })) });
  });

  app.get("/people/:id/relationship", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const mine = await db.relationshipTag.findMany({ where: { ownerId: actor.personId, targetPersonId: id } });
    return reply.send({ kinds: mine.map((t) => ({ kind: t.kind, mutual: t.mutual })) });
  });

  app.put("/organizations/:id/relationship", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = relKindsSchema.parse(req.body);
    const org = await db.organization.findUnique({ where: { id }, select: { id: true } });
    if (!org) throw notFound("That business");

    await db.$transaction([
      db.relationshipTag.deleteMany({ where: { ownerId: actor.personId, targetOrgId: id } }),
      ...body.kinds.map((kind) => db.relationshipTag.create({ data: { ownerId: actor.personId, targetOrgId: id, kind } })),
    ]);

    const admins = await db.membership.findMany({ where: { organizationId: id, role: { in: ["OWNER", "ADMIN"] } }, select: { personId: true } });
    const theirTags = admins.length ? await db.relationshipTag.findMany({ where: { targetPersonId: actor.personId, ownerId: { in: admins.map((a) => a.personId) } } }) : [];
    const updates = [];
    for (const kind of body.kinds) {
      const complement = RELATIONSHIP_COMPLEMENT[kind];
      const mutual = theirTags.some((t) => t.kind === complement);
      updates.push(db.relationshipTag.updateMany({ where: { ownerId: actor.personId, targetOrgId: id, kind }, data: { mutual } }));
    }
    if (updates.length) await db.$transaction(updates);

    const mine = await db.relationshipTag.findMany({ where: { ownerId: actor.personId, targetOrgId: id } });
    return reply.send({ kinds: mine.map((t) => ({ kind: t.kind, mutual: t.mutual })) });
  });

  app.get("/organizations/:id/relationship", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const mine = await db.relationshipTag.findMany({ where: { ownerId: actor.personId, targetOrgId: id } });
    return reply.send({ kinds: mine.map((t) => ({ kind: t.kind, mutual: t.mutual })) });
  });

  /* ─────────────────────────── Reports ─────────────────────────── */

  app.post("/reports", async (req, reply) => {
    const actor = requireActor(req);
    const body = z
      .object({ targetType: z.enum(REPORT_TARGET_TYPES), targetId: z.string().min(1), reason: z.enum(REPORT_REASONS), details: z.string().trim().max(2000).optional() })
      .parse(req.body);

    const existing = await db.report.findUnique({ where: { reporterId_targetType_targetId: { reporterId: actor.personId, targetType: body.targetType, targetId: body.targetId } } });
    if (existing) return reply.status(200).send({ id: existing.id, caseId: existing.caseId, alreadyReported: true });

    let subjectPersonId: string | null = null;
    let subjectOrgId: string | null = null;
    if (body.targetType === "person") subjectPersonId = body.targetId;
    else if (body.targetType === "organization") subjectOrgId = body.targetId;
    else if (body.targetType === "post") {
      const post = await db.post.findUnique({ where: { id: body.targetId }, select: { authorId: true, organizationId: true } }).catch(() => null);
      subjectPersonId = post?.authorId ?? null;
      subjectOrgId = post?.organizationId ?? null;
    } else if (body.targetType === "comment") {
      const comment = await db.comment.findUnique({ where: { id: body.targetId }, select: { authorId: true } }).catch(() => null);
      subjectPersonId = comment?.authorId ?? null;
    }

    const openCase = await db.moderationCase.findFirst({ where: { targetType: body.targetType, targetId: body.targetId, status: { in: ["OPEN", "IN_REVIEW"] } } });
    const kase = openCase
      ? await db.moderationCase.update({ where: { id: openCase.id }, data: { reportCount: { increment: 1 }, signals: { reporterCount: openCase.reportCount + 1 } } })
      : await db.moderationCase.create({ data: { targetType: body.targetType, targetId: body.targetId, subjectPersonId, subjectOrgId, reason: body.reason, reportCount: 1, signals: { reporterCount: 1 } } });

    const report = await db.report.create({ data: { reporterId: actor.personId, targetType: body.targetType, targetId: body.targetId, reason: body.reason, details: body.details ?? null, caseId: kase.id } });
    await audit(db, { actorId: actor.personId, action: "report.create", targetType: body.targetType, targetId: body.targetId });
    await track(db, { personId: actor.personId, event: "report", objectType: body.targetType, objectId: body.targetId });
    return reply.status(201).send({ id: report.id, caseId: kase.id });
  });

  /* ─────────────────────────── Suggestions ─────────────────────────── */

  app.get("/network/suggestions", async (req, reply) => {
    const actor = requireActor(req);
    const query = z.object({ limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(query.limit, 12, 30);

    const [mine, myBlocks, theirBlocks, pending, dismissedRows, myProfile] = await Promise.all([
      connectionIds(db, actor.personId),
      db.block.findMany({ where: { blockerId: actor.personId }, select: { blockedId: true } }),
      db.block.findMany({ where: { blockedId: actor.personId }, select: { blockerId: true } }),
      db.connection.findMany({ where: { status: "PENDING", OR: [{ aId: actor.personId }, { bId: actor.personId }] }, select: { aId: true, bId: true } }),
      db.recommendationImpression.findMany({ where: { personId: actor.personId, objectType: "person", outcome: "dismissed", createdAt: { gte: new Date(Date.now() - 90 * 24 * 3600 * 1000) } }, select: { objectId: true } }),
      db.profile.findUnique({ where: { personId: actor.personId }, select: { industry: true, location: true } }),
    ]);

    const excluded = new Set<string>([actor.personId]);
    for (const b of myBlocks) excluded.add(b.blockedId);
    for (const b of theirBlocks) excluded.add(b.blockerId);
    for (const p of pending) excluded.add(p.aId === actor.personId ? p.bId : p.aId);
    for (const d of dismissedRows) excluded.add(d.objectId);
    for (const m of mine) excluded.add(m);

    const reasons = new Map<string, string>();

    // 1) 2nd-degree with mutual count.
    if (mine.length) {
      const second = await db.connection.findMany({
        where: { status: "ACTIVE", OR: [{ aId: { in: mine } }, { bId: { in: mine } }] },
        select: { aId: true, bId: true },
      });
      const mutualCount = new Map<string, number>();
      for (const c of second) {
        for (const candidate of [c.aId, c.bId]) {
          if (excluded.has(candidate)) continue;
          mutualCount.set(candidate, (mutualCount.get(candidate) ?? 0) + 1);
        }
      }
      for (const [candidate, count] of mutualCount) {
        if (!reasons.has(candidate)) reasons.set(candidate, `${count} mutual`);
      }
    }

    // 2) Same organization.
    if (reasons.size < limit) {
      const myOrgs = await db.membership.findMany({ where: { personId: actor.personId, affiliation: { in: ["VERIFIED_ADMIN", "VERIFIED_DOMAIN"] } }, select: { organizationId: true, organization: { select: { displayName: true } } } });
      if (myOrgs.length) {
        const peers = await db.membership.findMany({ where: { organizationId: { in: myOrgs.map((o) => o.organizationId) }, personId: { notIn: [...excluded] } }, select: { personId: true, organizationId: true } });
        const orgName = new Map(myOrgs.map((o) => [o.organizationId, o.organization.displayName]));
        for (const p of peers) {
          if (!reasons.has(p.personId)) reasons.set(p.personId, `Works at ${orgName.get(p.organizationId) ?? "your company"}`);
        }
      }
    }

    // 3) Same industry + location.
    if (reasons.size < limit && myProfile?.industry && myProfile?.location) {
      const peers = await db.profile.findMany({ where: { industry: myProfile.industry, location: myProfile.location, personId: { notIn: [...excluded] } }, select: { personId: true } });
      for (const p of peers) {
        if (!reasons.has(p.personId)) reasons.set(p.personId, `Same industry in ${myProfile.location}`);
      }
    }

    // 4) Followed the same organizations.
    if (reasons.size < limit) {
      const myFollows = await db.follow.findMany({ where: { followerId: actor.personId, organizationId: { not: null } }, select: { organizationId: true } });
      if (myFollows.length) {
        const others = await db.follow.findMany({ where: { organizationId: { in: myFollows.map((f) => f.organizationId!) }, followerId: { notIn: [...excluded] } }, select: { followerId: true } });
        for (const o of others) {
          if (!reasons.has(o.followerId)) reasons.set(o.followerId, "Follows companies you follow");
        }
      }
    }

    const candidateIds = [...reasons.keys()].slice(0, limit);
    const cards = await personCards(db, candidateIds);
    const items: Array<{ person: PersonCard; reason: string; recommendationId: string }> = [];
    for (let i = 0; i < candidateIds.length; i++) {
      const id = candidateIds[i];
      const card = cards.get(id);
      if (!card) continue;
      const impression = await db.recommendationImpression.create({
        data: { personId: actor.personId, surface: "network", model: "pymk-v1", objectType: "person", objectId: id, reason: reasons.get(id), position: i },
      });
      items.push({ person: card, reason: reasons.get(id)!, recommendationId: impression.id });
    }
    return reply.send({ items });
  });

  app.post("/network/suggestions/:recommendationId/dismiss", async (req, reply) => {
    const actor = requireActor(req);
    const { recommendationId } = z.object({ recommendationId: z.string() }).parse(req.params);
    const impression = await db.recommendationImpression.findUnique({ where: { id: recommendationId } });
    if (!impression || impression.personId !== actor.personId) throw notFound("That suggestion");
    await db.recommendationImpression.update({ where: { id: recommendationId }, data: { outcome: "dismissed" } });
    return reply.send({ ok: true });
  });

  /* ─────────────────────────── Contact import (consented match) ─────────────────────────── */

  app.post("/network/match", async (req, reply) => {
    const actor = requireActor(req);
    const body = z.object({ emails: z.array(z.string()).max(2000).optional(), phones: z.array(z.string()).max(2000).optional() }).parse(req.body);
    const emails = [...new Set((body.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const phones = [...new Set((body.phones ?? []).map((p) => normalizePhone(p)).filter((p): p is string => !!p))];

    const [byEmail, byPhone] = await Promise.all([
      emails.length ? db.person.findMany({ where: { email: { in: emails }, emailVerifiedAt: { not: null } }, select: { id: true, preferences: true } }) : Promise.resolve([]),
      phones.length ? db.person.findMany({ where: { phoneE164: { in: phones }, phoneVerifiedAt: { not: null } }, select: { id: true, preferences: true } }) : Promise.resolve([]),
    ]);
    const phoneAllowed = byPhone.filter((p) => (p.preferences as any)?.findableByPhone !== false);
    const ids = [...new Set([...byEmail.map((p) => p.id), ...phoneAllowed.map((p) => p.id)])].filter((id) => id !== actor.personId);
    const blocked = await db.block.findMany({ where: { OR: [{ blockerId: actor.personId, blockedId: { in: ids } }, { blockedId: actor.personId, blockerId: { in: ids } }] } });
    const blockedIds = new Set([...blocked.map((b) => b.blockerId), ...blocked.map((b) => b.blockedId)]);
    const cards = await personCards(db, ids.filter((id) => !blockedIds.has(id)));
    return reply.send({ matches: [...cards.values()] });
  });
}

/** After a person's tags toward another change, recompute mutual on both sides. */
async function recomputePersonMutuality(db: Db, ownerId: string, targetPersonId: string) {
  const [mine, theirs] = await Promise.all([
    db.relationshipTag.findMany({ where: { ownerId, targetPersonId } }),
    db.relationshipTag.findMany({ where: { ownerId: targetPersonId, targetPersonId: ownerId } }),
  ]);
  const theirKinds = new Set(theirs.map((t) => t.kind));
  const mineKinds = new Set(mine.map((t) => t.kind));
  const ops = [];
  for (const t of mine) {
    const mutual = theirKinds.has(RELATIONSHIP_COMPLEMENT[t.kind]);
    if (mutual !== t.mutual) ops.push(db.relationshipTag.update({ where: { id: t.id }, data: { mutual } }));
  }
  for (const t of theirs) {
    const mutual = mineKinds.has(RELATIONSHIP_COMPLEMENT[t.kind]);
    if (mutual !== t.mutual) ops.push(db.relationshipTag.update({ where: { id: t.id }, data: { mutual } }));
  }
  if (ops.length) await db.$transaction(ops);
}
