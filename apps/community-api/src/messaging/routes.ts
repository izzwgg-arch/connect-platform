import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { requireActor } from "../auth/actor.js";
import { requireVerifiedActor } from "../auth/guards.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { publishTo, publishToMany } from "../lib/realtime.js";
import {
  createGroupThread,
  findOrCreateDirectThread,
  loadThreadForActor,
  messageDto,
  prefsForMany,
  sendMessage,
  threadListItem,
  threadTitle,
  shapeParticipants,
} from "./service.js";
import { isOnline, readReceiptsVisible, resolvePrefs, sanitizeBody } from "./policy.js";
import { personCards } from "../profiles/cards.js";
import { degreeBetween } from "../policy/graph.js";

const kindSchema = z.enum(["TEXT", "IMAGE", "FILE", "AUDIO", "VIDEO"]);

const typingHits = new Map<string, number[]>();
function typingAllowed(key: string): boolean {
  const now = Date.now();
  const hits = (typingHits.get(key) ?? []).filter((t) => now - t < 10_000);
  if (hits.length >= 10) {
    typingHits.set(key, hits);
    return false;
  }
  hits.push(now);
  typingHits.set(key, hits);
  return true;
}

export function registerMessagingRoutes(app: FastifyInstance, db: Db) {
  /* ── create / find a thread ─────────────────────────────────────────── */
  app.post("/threads", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const body = z.object({ personIds: z.array(z.string()).min(1).max(50), title: z.string().trim().max(120).optional() }).parse(req.body);
    // Returns the thread object directly (not wrapped) — other domains (e.g. the
    // company page's "Message" button) already call POST /threads expecting
    // `{ id, ... }` back, so the shape here is a contract, not a free choice.
    if (body.personIds.length === 1) {
      const { thread, created } = await findOrCreateDirectThread(db, actor.personId, body.personIds[0]);
      const participants = await db.threadParticipant.findMany({ where: { threadId: thread.id } });
      const item = await threadListItem(db, thread, participants, actor.personId);
      reply.status(created ? 201 : 200);
      return item;
    }
    const thread = await createGroupThread(db, actor.personId, body.personIds, body.title);
    const participants = await db.threadParticipant.findMany({ where: { threadId: thread.id } });
    const item = await threadListItem(db, thread, participants, actor.personId);
    reply.status(201);
    return item;
  });

  /* ── list ───────────────────────────────────────────────────────────── */
  app.get("/threads", async (req) => {
    const actor = requireActor(req);
    const q = z.object({ tab: z.enum(["inbox", "requests", "archived"]).default("inbox"), cursor: z.string().optional(), limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(q.limit, 20, 50);
    const cursor = decodeCursor(q.cursor);

    const where: Record<string, unknown> =
      q.tab === "requests"
        ? { personId: actor.personId, state: "REQUESTED", archivedAt: null }
        : q.tab === "archived"
        ? { personId: actor.personId, state: { notIn: ["DECLINED"] }, archivedAt: { not: null } }
        : { personId: actor.personId, state: "ACTIVE", archivedAt: null };

    // Sorted in JS (pinned first, then by last activity) rather than via Prisma orderBy,
    // because Postgres's default NULLS FIRST-on-DESC would put pinnedAt=null threads
    // ahead of pinned ones. Fine at this scale; a production-sized inbox would want a
    // dedicated sort key column instead of fetching the whole tab.
    const mineRows = await db.threadParticipant.findMany({ where, include: { thread: true } });
    mineRows.sort((a, b) => {
      const pa = a.pinnedAt ? a.pinnedAt.getTime() : -1;
      const pb = b.pinnedAt ? b.pinnedAt.getTime() : -1;
      if (pa !== pb) return pa > pb ? -1 : 1; // pinned (any pin time) before unpinned; more-recently-pinned first
      const la = a.thread.lastMessageAt?.getTime() ?? a.thread.createdAt.getTime();
      const lb = b.thread.lastMessageAt?.getTime() ?? b.thread.createdAt.getTime();
      return lb - la;
    });
    let rows = mineRows;
    if (cursor) {
      const idx = rows.findIndex((r) => r.thread.id === cursor.id);
      rows = idx >= 0 ? rows.slice(idx + 1) : rows;
    }
    rows = rows.slice(0, limit);

    const items = [];
    for (const r of rows) {
      const participants = await db.threadParticipant.findMany({ where: { threadId: r.threadId } });
      items.push(await threadListItem(db, r.thread, participants, actor.personId));
    }
    const last = rows[rows.length - 1];
    const nextCursor = last && rows.length === limit ? encodeCursor(last.thread.lastMessageAt ?? last.thread.createdAt, last.thread.id) : null;
    return { items, nextCursor };
  });

  app.get("/threads/unread-count", async (req) => {
    const actor = requireActor(req);
    const agg = await db.threadParticipant.aggregate({
      where: { personId: actor.personId, state: { in: ["ACTIVE", "REQUESTED"] }, archivedAt: null },
      _sum: { unreadCount: true },
    });
    return { count: agg._sum.unreadCount ?? 0 };
  });

  app.get("/threads/search", async (req) => {
    const actor = requireActor(req);
    const q = z.object({ q: z.string().trim().min(1).max(200) }).parse(req.query);
    const mine = await db.threadParticipant.findMany({ where: { personId: actor.personId, state: { notIn: ["DECLINED", "LEFT"] } }, select: { threadId: true } });
    const threadIds = mine.map((m) => m.threadId);
    if (!threadIds.length) return { items: [] };
    const messages = await db.message.findMany({
      where: { threadId: { in: threadIds }, deletedAt: null, body: { contains: q.q, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    const items = await Promise.all(messages.map((m) => messageDto(db, m, actor.personId)));
    return { items };
  });

  /* ── presence ───────────────────────────────────────────────────────── */
  app.get("/presence", async (req) => {
    requireActor(req);
    const q = z.object({ personIds: z.string().min(1) }).parse(req.query);
    const ids = q.personIds.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
    const prefs = await prefsForMany(db, ids);
    const out: Record<string, boolean> = {};
    for (const id of ids) {
      const p = prefs.get(id) as any;
      out[id] = isOnline(p?.lastSeenAt ?? null, p);
    }
    return { presence: out };
  });

  /* ── thread detail ──────────────────────────────────────────────────── */
  app.get("/threads/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { thread, participants, mine } = await loadThreadForActor(db, id, actor.personId);
    const cards = await personCards(db, participants.map((p) => p.personId));
    const title = await threadTitle(db, thread, participants, actor.personId, cards);
    const shaped = await shapeParticipants(db, participants, actor.personId);
    const files = await db.message.findMany({ where: { threadId: id, assetId: { not: null }, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 20 });
    const fileDtos = await Promise.all(files.map((f) => messageDto(db, f, actor.personId)));
    return {
      id: thread.id,
      kind: thread.kind,
      title,
      participants: shaped,
      myState: mine.state,
      myRole: mine.role,
      ref: thread.refType && thread.refId ? { type: thread.refType, id: thread.refId } : null,
      sharedFiles: fileDtos.map((f) => f.asset).filter(Boolean),
    };
  });

  /* ── messages ───────────────────────────────────────────────────────── */
  app.get("/threads/:id/messages", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await loadThreadForActor(db, id, actor.personId);
    const q = z.object({ cursor: z.string().optional(), limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(q.limit, 30, 100);
    const cursor = decodeCursor(q.cursor);
    const rows = await db.message.findMany({
      where: { threadId: id, ...(cursor ? { createdAt: { lt: new Date(cursor.value) } } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    const ordered = [...rows].reverse();
    const items = await Promise.all(ordered.map((m) => messageDto(db, m, actor.personId)));
    const oldest = rows[rows.length - 1];
    const nextCursor = oldest && rows.length === limit ? encodeCursor(oldest.createdAt, oldest.id) : null;
    return { items, nextCursor };
  });

  app.post("/threads/:id/messages", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        kind: kindSchema.default("TEXT"),
        body: z.string().max(5000).optional(),
        assetId: z.string().optional(),
        replyToId: z.string().optional(),
        refType: z.string().max(40).optional(),
        refId: z.string().max(80).optional(),
      })
      .parse(req.body);
    const dto = await sendMessage(db, actor.personId, id, body);
    reply.status(201);
    return { message: dto };
  });

  app.patch("/threads/:id/messages/:mid", async (req) => {
    const actor = requireActor(req);
    const { id, mid } = z.object({ id: z.string(), mid: z.string() }).parse(req.params);
    const body = z.object({ body: z.string().min(1).max(5000) }).parse(req.body);
    await loadThreadForActor(db, id, actor.personId);
    const message = await db.message.findUnique({ where: { id: mid } });
    if (!message || message.threadId !== id) throw notFound("That message");
    if (message.senderId !== actor.personId) throw forbidden("You can only edit your own messages.");
    if (message.deletedAt) throw badRequest("message_deleted", "That message was deleted.");
    if (Date.now() - message.createdAt.getTime() > 24 * 60 * 60 * 1000) throw badRequest("edit_window_closed", "You can only edit a message within 24 hours of sending it.");
    const updated = await db.message.update({ where: { id: mid }, data: { body: sanitizeBody(body.body).slice(0, 5000), editedAt: new Date() } });
    const dto = await messageDto(db, updated, actor.personId);
    const others = (await db.threadParticipant.findMany({ where: { threadId: id, state: { not: "DECLINED" } } })).map((p) => p.personId);
    await publishToMany(others, "message", { threadId: id, message: dto });
    return { message: dto };
  });

  app.delete("/threads/:id/messages/:mid", async (req) => {
    const actor = requireActor(req);
    const { id, mid } = z.object({ id: z.string(), mid: z.string() }).parse(req.params);
    await loadThreadForActor(db, id, actor.personId);
    const message = await db.message.findUnique({ where: { id: mid } });
    if (!message || message.threadId !== id) throw notFound("That message");
    if (message.senderId !== actor.personId) throw forbidden("You can only delete your own messages.");
    const updated = await db.message.update({ where: { id: mid }, data: { deletedAt: new Date(), body: null } });
    const dto = await messageDto(db, updated, actor.personId);
    const others = (await db.threadParticipant.findMany({ where: { threadId: id, state: { not: "DECLINED" } } })).map((p) => p.personId);
    await publishToMany(others, "message", { threadId: id, message: dto });
    return { message: dto };
  });

  app.post("/threads/:id/messages/:mid/react", async (req) => {
    const actor = requireActor(req);
    const { id, mid } = z.object({ id: z.string(), mid: z.string() }).parse(req.params);
    const { emoji } = z.object({ emoji: z.string().min(1).max(8) }).parse(req.body);
    await loadThreadForActor(db, id, actor.personId);
    const message = await db.message.findUnique({ where: { id: mid } });
    if (!message || message.threadId !== id) throw notFound("That message");
    const reactions = ((message.reactions as Record<string, string[]> | null) ?? {}) as Record<string, string[]>;
    const set = new Set(reactions[emoji] ?? []);
    if (set.has(actor.personId)) set.delete(actor.personId);
    else set.add(actor.personId);
    reactions[emoji] = [...set];
    if (!reactions[emoji].length) delete reactions[emoji];
    const updated = await db.message.update({ where: { id: mid }, data: { reactions } });
    const dto = await messageDto(db, updated, actor.personId);
    const others = (await db.threadParticipant.findMany({ where: { threadId: id, state: { not: "DECLINED" } } })).map((p) => p.personId);
    await publishToMany(others, "message", { threadId: id, message: dto });
    return { message: dto };
  });

  app.post("/threads/:id/messages/:mid/forward", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const { id, mid } = z.object({ id: z.string(), mid: z.string() }).parse(req.params);
    const { toThreadIds } = z.object({ toThreadIds: z.array(z.string()).min(1).max(20) }).parse(req.body);
    await loadThreadForActor(db, id, actor.personId);
    const original = await db.message.findUnique({ where: { id: mid } });
    if (!original || original.threadId !== id || original.deletedAt) throw notFound("That message");
    const results: Array<{ threadId: string; ok: boolean; message?: unknown; error?: string }> = [];
    for (const targetId of toThreadIds) {
      try {
        const dto = await sendMessage(db, actor.personId, targetId, {
          kind: original.kind as any,
          body: original.body ?? undefined,
          assetId: original.assetId ?? undefined,
        });
        await db.message.update({ where: { id: dto.id }, data: { forwardedFromId: original.id } });
        const refreshed = await db.message.findUnique({ where: { id: dto.id } });
        const finalDto = refreshed ? await messageDto(db, refreshed, actor.personId) : dto;
        results.push({ threadId: targetId, ok: true, message: finalDto });
      } catch (err) {
        results.push({ threadId: targetId, ok: false, error: (err as Error).message });
      }
    }
    return { results };
  });

  /* ── request lifecycle ─────────────────────────────────────────────── */
  app.post("/threads/:id/accept", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { mine, participants } = await loadThreadForActor(db, id, actor.personId);
    if (mine.state !== "REQUESTED") throw badRequest("not_a_request", "That isn't a pending request.");
    await db.threadParticipant.update({ where: { id: mine.id }, data: { state: "ACTIVE" } });
    const others = participants.filter((p) => p.personId !== actor.personId && p.state !== "DECLINED").map((p) => p.personId);
    await publishToMany([actor.personId, ...others], "thread", { threadId: id, accepted: true, by: actor.personId });
    return { ok: true };
  });

  app.post("/threads/:id/decline", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { mine } = await loadThreadForActor(db, id, actor.personId);
    if (mine.state !== "REQUESTED") throw badRequest("not_a_request", "That isn't a pending request.");
    await db.threadParticipant.update({ where: { id: mine.id }, data: { state: "DECLINED" } });
    // Silent — the sender is never told; they keep getting the same "wait" refusal.
    return { ok: true };
  });

  app.post("/threads/:id/read", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { mine, participants } = await loadThreadForActor(db, id, actor.personId);
    const priorUnread = mine.unreadCount;
    const now = new Date();
    await db.threadParticipant.update({ where: { id: mine.id }, data: { lastReadAt: now, unreadCount: 0 } });
    if (priorUnread > 0) await publishTo(actor.personId, "message", { threadId: id, unreadDelta: -priorUnread });

    const others = participants.filter((p) => p.personId !== actor.personId && p.state !== "DECLINED" && p.state !== "LEFT");
    if (others.length) {
      const [mePrefs, otherPrefs] = await Promise.all([
        db.person.findUnique({ where: { id: actor.personId }, select: { preferences: true } }),
        prefsForMany(db, others.map((o) => o.personId)),
      ]);
      const meResolved = resolvePrefs(mePrefs?.preferences);
      const visibleTo = others.filter((o) => readReceiptsVisible(meResolved, otherPrefs.get(o.personId))).map((o) => o.personId);
      if (visibleTo.length) await publishToMany(visibleTo, "thread", { threadId: id, readBy: actor.personId, at: now.toISOString() });
    }
    return { ok: true };
  });

  app.post("/threads/:id/typing", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    let loaded;
    try {
      loaded = await loadThreadForActor(db, id, actor.personId);
    } catch {
      return { ok: true }; // invisible/gone thread — a stray typing ping is not worth a 404
    }
    if (!typingAllowed(`${id}:${actor.personId}`)) return { ok: true };
    const others = loaded.participants.filter((p) => p.personId !== actor.personId && p.state !== "DECLINED").map((p) => p.personId);
    await publishToMany(others, "typing", { threadId: id, personId: actor.personId });
    return { ok: true };
  });

  /* ── mute / pin / archive / leave ───────────────────────────────────── */
  app.post("/threads/:id/mute", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { until } = z.object({ until: z.string().datetime().optional() }).parse(req.body ?? {});
    const { mine } = await loadThreadForActor(db, id, actor.personId);
    const FAR_FUTURE = new Date("2999-01-01T00:00:00.000Z");
    await db.threadParticipant.update({ where: { id: mine.id }, data: { mutedUntil: until ? new Date(until) : FAR_FUTURE } });
    return { ok: true };
  });
  app.delete("/threads/:id/mute", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { mine } = await loadThreadForActor(db, id, actor.personId);
    await db.threadParticipant.update({ where: { id: mine.id }, data: { mutedUntil: null } });
    return { ok: true };
  });

  app.post("/threads/:id/pin", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { mine } = await loadThreadForActor(db, id, actor.personId);
    await db.threadParticipant.update({ where: { id: mine.id }, data: { pinnedAt: new Date() } });
    return { ok: true };
  });
  app.delete("/threads/:id/pin", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { mine } = await loadThreadForActor(db, id, actor.personId);
    await db.threadParticipant.update({ where: { id: mine.id }, data: { pinnedAt: null } });
    return { ok: true };
  });

  app.post("/threads/:id/archive", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { mine } = await loadThreadForActor(db, id, actor.personId);
    await db.threadParticipant.update({ where: { id: mine.id }, data: { archivedAt: new Date() } });
    return { ok: true };
  });
  app.delete("/threads/:id/archive", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { mine } = await loadThreadForActor(db, id, actor.personId);
    await db.threadParticipant.update({ where: { id: mine.id }, data: { archivedAt: null } });
    return { ok: true };
  });

  app.post("/threads/:id/leave", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { thread, mine, participants } = await loadThreadForActor(db, id, actor.personId);
    if (thread.kind !== "GROUP") throw badRequest("not_a_group", "Leave is only for group threads.");
    await db.threadParticipant.update({ where: { id: mine.id }, data: { state: "LEFT" } });
    const others = participants.filter((p) => p.personId !== actor.personId && p.state === "ACTIVE").map((p) => p.personId);
    await publishToMany(others, "thread", { threadId: id, left: actor.personId });
    return { ok: true };
  });

  /* ── group membership ──────────────────────────────────────────────── */
  app.post("/threads/:id/participants", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { personIds } = z.object({ personIds: z.array(z.string()).min(1).max(50) }).parse(req.body);
    const { thread, mine } = await loadThreadForActor(db, id, actor.personId);
    if (thread.kind !== "GROUP") throw badRequest("not_a_group", "You can only add people to a group thread.");
    if (mine.role !== "ADMIN") throw forbidden("Only a group admin can add members.");
    const added: string[] = [];
    for (const pid of new Set(personIds)) {
      if (pid === actor.personId) continue;
      const degree = await degreeBetween(db, actor.personId, pid);
      if (degree !== 1) continue; // skip non-connections rather than fail the whole call
      await db.threadParticipant.upsert({
        where: { threadId_personId: { threadId: id, personId: pid } },
        create: { threadId: id, personId: pid, state: "ACTIVE", role: "MEMBER" },
        update: { state: "ACTIVE" },
      });
      added.push(pid);
    }
    if (added.length) await publishToMany(added, "thread", { threadId: id, added: true });
    return { ok: true, added };
  });

  app.delete("/threads/:id/participants/:pid", async (req) => {
    const actor = requireActor(req);
    const { id, pid } = z.object({ id: z.string(), pid: z.string() }).parse(req.params);
    const { thread, mine } = await loadThreadForActor(db, id, actor.personId);
    if (thread.kind !== "GROUP") throw badRequest("not_a_group", "That only applies to group threads.");
    if (mine.role !== "ADMIN" && pid !== actor.personId) throw forbidden("Only a group admin can remove members.");
    const row = await db.threadParticipant.findUnique({ where: { threadId_personId: { threadId: id, personId: pid } } });
    if (!row) throw notFound("That member");
    await db.threadParticipant.update({ where: { id: row.id }, data: { state: "LEFT" } });
    await publishTo(pid, "thread", { threadId: id, removed: true });
    return { ok: true };
  });
}
