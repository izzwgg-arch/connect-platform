import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { notFound } from "../lib/errors.js";
import { requireActor } from "../auth/actor.js";
import { audit } from "../lib/audit.js";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { pairKey, connectionIds } from "../policy/graph.js";
import { previewFor } from "../messaging/policy.js";
import { personCards, type PersonCard } from "../profiles/cards.js";
import { orgCards, type OrgCard } from "../organizations/cards.js";
import { registerQrRoutes } from "./qr.js";

type Target = { targetPersonId?: string; targetOrgId?: string };

type NoteRow = {
  id: string;
  ownerId: string;
  targetPersonId: string | null;
  targetOrgId: string | null;
  body: string;
  tags: string[];
  dealValue: unknown;
  nextAction: string | null;
  nextActionAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type ReminderRow = {
  id: string;
  ownerId: string;
  targetPersonId: string | null;
  targetOrgId: string | null;
  title: string;
  dueAt: Date;
  doneAt: Date | null;
  createdAt: Date;
};

export function registerCrmRoutes(app: FastifyInstance, db: Db) {
  function dealValueOf(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    return v.toString();
  }

  async function cardsFor(personIds: string[], orgIds: string[]): Promise<{ people: Map<string, PersonCard>; orgs: Map<string, OrgCard> }> {
    const [people, orgs] = await Promise.all([personCards(db, personIds), orgCards(db, orgIds)]);
    return { people, orgs };
  }

  async function noteDto(row: NoteRow, cards?: { people: Map<string, PersonCard>; orgs: Map<string, OrgCard> }) {
    const c = cards ?? (await cardsFor(row.targetPersonId ? [row.targetPersonId] : [], row.targetOrgId ? [row.targetOrgId] : []));
    return {
      id: row.id,
      body: row.body,
      tags: row.tags,
      dealValue: dealValueOf(row.dealValue),
      nextAction: row.nextAction,
      nextActionAt: row.nextActionAt ? row.nextActionAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      targetPerson: row.targetPersonId ? c.people.get(row.targetPersonId) ?? null : null,
      targetOrg: row.targetOrgId ? c.orgs.get(row.targetOrgId) ?? null : null,
    };
  }

  async function notesDtoList(rows: NoteRow[]) {
    const personIds = rows.map((r) => r.targetPersonId).filter((x): x is string => !!x);
    const orgIds = rows.map((r) => r.targetOrgId).filter((x): x is string => !!x);
    const cards = await cardsFor(personIds, orgIds);
    return Promise.all(rows.map((r) => noteDto(r, cards)));
  }

  async function reminderDto(row: ReminderRow, cards?: { people: Map<string, PersonCard>; orgs: Map<string, OrgCard> }) {
    const c = cards ?? (await cardsFor(row.targetPersonId ? [row.targetPersonId] : [], row.targetOrgId ? [row.targetOrgId] : []));
    return {
      id: row.id,
      title: row.title,
      dueAt: row.dueAt.toISOString(),
      doneAt: row.doneAt ? row.doneAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      targetPerson: row.targetPersonId ? c.people.get(row.targetPersonId) ?? null : null,
      targetOrg: row.targetOrgId ? c.orgs.get(row.targetOrgId) ?? null : null,
    };
  }

  async function remindersDtoList(rows: ReminderRow[]) {
    const personIds = rows.map((r) => r.targetPersonId).filter((x): x is string => !!x);
    const orgIds = rows.map((r) => r.targetOrgId).filter((x): x is string => !!x);
    const cards = await cardsFor(personIds, orgIds);
    return Promise.all(rows.map((r) => reminderDto(r, cards)));
  }

  /* ─────────────────────────── Notes ─────────────────────────── */

  const noteWriteSchema = z
    .object({
      targetPersonId: z.string().min(1).optional(),
      targetOrgId: z.string().min(1).optional(),
      body: z.string().trim().min(1).max(5000),
      tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
      dealValue: z.number().nonnegative().optional().nullable(),
      nextAction: z.string().trim().max(200).optional().nullable(),
      nextActionAt: z.string().datetime().optional().nullable(),
    })
    .refine((v) => !!v.targetPersonId !== !!v.targetOrgId, { message: "A note needs exactly one target — a person or a business." });

  app.get("/crm/notes", async (req, reply) => {
    const actor = requireActor(req);
    const q = z.object({ personId: z.string().optional(), orgId: z.string().optional(), tag: z.string().optional(), cursor: z.string().optional(), limit: z.string().optional() }).parse(req.query);
    const cur = decodeCursor(q.cursor);
    const limit = clampLimit(q.limit);
    const rows = await db.privateNote.findMany({
      where: {
        ownerId: actor.personId,
        ...(q.personId ? { targetPersonId: q.personId } : {}),
        ...(q.orgId ? { targetOrgId: q.orgId } : {}),
        ...(q.tag ? { tags: { has: q.tag } } : {}),
        ...(cur ? { createdAt: { lt: new Date(cur.value) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const items = await notesDtoList(page);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null;
    return reply.send({ items, nextCursor });
  });

  app.post("/crm/notes", async (req, reply) => {
    const actor = requireActor(req);
    const body = noteWriteSchema.parse(req.body);
    if (body.targetPersonId) {
      const t = await db.person.findUnique({ where: { id: body.targetPersonId }, select: { id: true } });
      if (!t) throw notFound("That person");
    } else if (body.targetOrgId) {
      const t = await db.organization.findUnique({ where: { id: body.targetOrgId }, select: { id: true } });
      if (!t) throw notFound("That business");
    }
    const created = await db.privateNote.create({
      data: {
        ownerId: actor.personId,
        targetPersonId: body.targetPersonId ?? null,
        targetOrgId: body.targetOrgId ?? null,
        body: body.body,
        tags: body.tags ?? [],
        dealValue: body.dealValue ?? null,
        nextAction: body.nextAction ?? null,
        nextActionAt: body.nextActionAt ? new Date(body.nextActionAt) : null,
      },
    });
    return reply.status(201).send(await noteDto(created));
  });

  const noteUpdateSchema = z.object({
    body: z.string().trim().min(1).max(5000).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    dealValue: z.number().nonnegative().optional().nullable(),
    nextAction: z.string().trim().max(200).optional().nullable(),
    nextActionAt: z.string().datetime().optional().nullable(),
  });

  app.patch("/crm/notes/:id", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = noteUpdateSchema.parse(req.body);
    const row = await db.privateNote.findUnique({ where: { id } });
    if (!row || row.ownerId !== actor.personId) throw notFound("That note");
    const updated = await db.privateNote.update({
      where: { id },
      data: {
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
        ...(body.dealValue !== undefined ? { dealValue: body.dealValue } : {}),
        ...(body.nextAction !== undefined ? { nextAction: body.nextAction } : {}),
        ...(body.nextActionAt !== undefined ? { nextActionAt: body.nextActionAt ? new Date(body.nextActionAt) : null } : {}),
      },
    });
    return reply.send(await noteDto(updated));
  });

  app.delete("/crm/notes/:id", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const row = await db.privateNote.findUnique({ where: { id } });
    if (!row || row.ownerId !== actor.personId) throw notFound("That note");
    await db.privateNote.delete({ where: { id } });
    return reply.send({ id, deleted: true });
  });

  app.get("/crm/tags", async (req, reply) => {
    const actor = requireActor(req);
    const rows = await db.privateNote.findMany({ where: { ownerId: actor.personId }, select: { tags: true } });
    const counts = new Map<string, number>();
    for (const r of rows) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    const tags = [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
    return reply.send({ tags });
  });

  /* ─────────────────────────── Reminders ─────────────────────────── */

  const reminderWriteSchema = z
    .object({
      targetPersonId: z.string().min(1).optional(),
      targetOrgId: z.string().min(1).optional(),
      title: z.string().trim().min(1).max(200),
      dueAt: z.string().datetime(),
    })
    .refine((v) => !!v.targetPersonId !== !!v.targetOrgId, { message: "A reminder needs exactly one target — a person or a business." });

  app.get("/crm/reminders", async (req, reply) => {
    const actor = requireActor(req);
    const q = z
      .object({ due: z.enum(["today", "week", "all"]).default("all"), done: z.enum(["true", "false"]).optional(), personId: z.string().optional(), orgId: z.string().optional() })
      .parse(req.query);
    const now = new Date();
    let dueAtFilter: Record<string, Date> | undefined;
    if (q.due === "today") {
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      dueAtFilter = { lte: end };
    } else if (q.due === "week") {
      const end = new Date(now);
      end.setDate(end.getDate() + 7);
      dueAtFilter = { lte: end };
    }
    const rows = await db.reminder.findMany({
      where: {
        ownerId: actor.personId,
        ...(dueAtFilter ? { dueAt: dueAtFilter } : {}),
        ...(q.done === "true" ? { doneAt: { not: null } } : q.done === "false" ? { doneAt: null } : {}),
        ...(q.personId ? { targetPersonId: q.personId } : {}),
        ...(q.orgId ? { targetOrgId: q.orgId } : {}),
      },
      orderBy: { dueAt: "asc" },
    });
    return reply.send({ items: await remindersDtoList(rows) });
  });

  app.post("/crm/reminders", async (req, reply) => {
    const actor = requireActor(req);
    const body = reminderWriteSchema.parse(req.body);
    if (body.targetPersonId) {
      const t = await db.person.findUnique({ where: { id: body.targetPersonId }, select: { id: true } });
      if (!t) throw notFound("That person");
    } else if (body.targetOrgId) {
      const t = await db.organization.findUnique({ where: { id: body.targetOrgId }, select: { id: true } });
      if (!t) throw notFound("That business");
    }
    const created = await db.reminder.create({
      data: { ownerId: actor.personId, targetPersonId: body.targetPersonId ?? null, targetOrgId: body.targetOrgId ?? null, title: body.title, dueAt: new Date(body.dueAt) },
    });
    return reply.status(201).send(await reminderDto(created));
  });

  app.patch("/crm/reminders/:id", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ done: z.boolean().optional(), dueAt: z.string().datetime().optional(), title: z.string().trim().min(1).max(200).optional() }).parse(req.body);
    const row = await db.reminder.findUnique({ where: { id } });
    if (!row || row.ownerId !== actor.personId) throw notFound("That reminder");
    const updated = await db.reminder.update({
      where: { id },
      data: {
        ...(body.done !== undefined ? { doneAt: body.done ? new Date() : null } : {}),
        ...(body.dueAt !== undefined ? { dueAt: new Date(body.dueAt), notifiedAt: null } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
      },
    });
    return reply.send(await reminderDto(updated));
  });

  app.delete("/crm/reminders/:id", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const row = await db.reminder.findUnique({ where: { id } });
    if (!row || row.ownerId !== actor.personId) throw notFound("That reminder");
    await db.reminder.delete({ where: { id } });
    return reply.send({ id, deleted: true });
  });

  /* ─────────────────────────── Timeline ─────────────────────────── */

  type TimelineItem = { kind: string; at: string; title: string; href: string };

  const timelineQuerySchema = z
    .object({ personId: z.string().min(1).optional(), orgId: z.string().min(1).optional() })
    .refine((v) => !!v.personId !== !!v.orgId, { message: "Provide exactly one of a person or a business." });

  app.get("/crm/timeline", async (req, reply) => {
    const actor = requireActor(req);
    const parsed = timelineQuerySchema.parse(req.query);
    const q: Target = { targetPersonId: parsed.personId, targetOrgId: parsed.orgId };
    const items: TimelineItem[] = [];
    const push = (arr: TimelineItem[]) => items.push(...arr);

    if (q.targetPersonId) {
      const personId = q.targetPersonId;
      await Promise.allSettled([
        db.privateNote
          .findMany({ where: { ownerId: actor.personId, targetPersonId: personId } })
          .then((rows) => push(rows.map((n) => ({ kind: "note", at: n.updatedAt.toISOString(), title: n.body.length > 120 ? `${n.body.slice(0, 117)}…` : n.body, href: `/crm/${personId}` })))),
        db.reminder
          .findMany({ where: { ownerId: actor.personId, targetPersonId: personId } })
          .then((rows) => push(rows.map((r) => ({ kind: "reminder", at: r.dueAt.toISOString(), title: r.title, href: `/crm/${personId}` })))),
        db.thread
          .findUnique({ where: { pairKey: pairKey(actor.personId, personId) } })
          .then(async (thread) => {
            if (!thread) return;
            const [count, last] = await Promise.all([
              db.message.count({ where: { threadId: thread.id, deletedAt: null } }),
              db.message.findFirst({ where: { threadId: thread.id, deletedAt: null }, orderBy: { createdAt: "desc" } }),
            ]);
            if (last) push([{ kind: "messages", at: last.createdAt.toISOString(), title: `${count} message${count === 1 ? "" : "s"} — last: ${previewFor(last.kind, last.body)}`, href: `/messages/${thread.id}` }]);
          }),
        db.introRequest
          .findMany({ where: { OR: [{ requesterId: actor.personId, middleId: personId }, { requesterId: personId, middleId: actor.personId }, { requesterId: actor.personId, targetPersonId: personId }, { requesterId: personId, targetPersonId: actor.personId }] } })
          .then((rows) => push(rows.map((r) => ({ kind: "intro", at: r.createdAt.toISOString(), title: `Introduction ${r.status.toLowerCase()}`, href: "/network/intros" })))),
        db.relationshipTag
          .findMany({ where: { ownerId: actor.personId, targetPersonId: personId } })
          .then((rows) => push(rows.map((t) => ({ kind: "tag", at: t.createdAt.toISOString(), title: `Tagged ${t.kind.toLowerCase().replace(/_/g, " ")}${t.mutual ? " (mutual)" : ""}`, href: `/crm/${personId}` })))),
      ]);
      // Connection acceptedAt, read directly (canonical pair order).
      try {
        const [a, b] = actor.personId < personId ? [actor.personId, personId] : [personId, actor.personId];
        const conn = await db.connection.findUnique({ where: { aId_bId: { aId: a, bId: b } } });
        if (conn?.status === "ACTIVE" && conn.acceptedAt) items.push({ kind: "connection", at: conn.acceptedAt.toISOString(), title: "Connected", href: `/crm/${personId}` });
      } catch {
        /* tolerate missing rows */
      }
    } else if (q.targetOrgId) {
      const orgId = q.targetOrgId;
      await Promise.allSettled([
        db.privateNote
          .findMany({ where: { ownerId: actor.personId, targetOrgId: orgId } })
          .then((rows) => push(rows.map((n) => ({ kind: "note", at: n.updatedAt.toISOString(), title: n.body.length > 120 ? `${n.body.slice(0, 117)}…` : n.body, href: `/crm/org/${orgId}` })))),
        db.reminder
          .findMany({ where: { ownerId: actor.personId, targetOrgId: orgId } })
          .then((rows) => push(rows.map((r) => ({ kind: "reminder", at: r.dueAt.toISOString(), title: r.title, href: `/crm/org/${orgId}` })))),
        db.relationshipTag
          .findMany({ where: { ownerId: actor.personId, targetOrgId: orgId } })
          .then((rows) => push(rows.map((t) => ({ kind: "tag", at: t.createdAt.toISOString(), title: `Tagged ${t.kind.toLowerCase().replace(/_/g, " ")}${t.mutual ? " (mutual)" : ""}`, href: `/crm/org/${orgId}` })))),
        db.introRequest
          .findMany({ where: { targetOrgId: orgId, OR: [{ requesterId: actor.personId }, { middleId: actor.personId }] } })
          .then((rows) => push(rows.map((r) => ({ kind: "intro", at: r.createdAt.toISOString(), title: `Introduction ${r.status.toLowerCase()}`, href: "/network/intros" })))),
        db.quote
          .findMany({ where: { organizationId: orgId, rfq: { OR: [{ buyerPersonId: actor.personId }] } }, include: { rfq: true } })
          .then((rows) => push(rows.map((q2) => ({ kind: "quote", at: q2.createdAt.toISOString(), title: `Quote on "${q2.rfq.title}"`, href: `/rfq/${q2.rfqId}` })))),
      ]);
    }

    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return reply.send({ items });
  });

  /* ─────────────────────────── Pipeline & contacts ─────────────────────────── */

  app.get("/crm/pipeline", async (req, reply) => {
    const actor = requireActor(req);
    const rows = await db.privateNote.findMany({ where: { ownerId: actor.personId } });
    const byTag = new Map<string, { count: number; dealValue: number; rows: NoteRow[] }>();
    for (const r of rows) {
      const tags = r.tags.length ? r.tags : ["untagged"];
      for (const t of tags) {
        const bucket = byTag.get(t) ?? { count: 0, dealValue: 0, rows: [] };
        bucket.count += 1;
        bucket.dealValue += r.dealValue ? Number(r.dealValue) : 0;
        bucket.rows.push(r);
        byTag.set(t, bucket);
      }
    }
    const groups = await Promise.all(
      [...byTag.entries()]
        .sort((a, b) => b[1].dealValue - a[1].dealValue)
        .map(async ([tag, b]) => ({ tag, count: b.count, dealValue: b.dealValue.toFixed(2), items: await notesDtoList(b.rows.slice(0, 25)) })),
    );
    return reply.send({ groups });
  });

  app.get("/crm/contacts", async (req, reply) => {
    const actor = requireActor(req);
    const q = z.object({ cursor: z.string().optional(), q: z.string().trim().optional(), limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(q.limit);
    const offset = Number(decodeCursor(q.cursor)?.value ?? "0") || 0;

    const [notes, reminders, tags, connections] = await Promise.all([
      db.privateNote.findMany({ where: { ownerId: actor.personId }, select: { targetPersonId: true, updatedAt: true } }),
      db.reminder.findMany({ where: { ownerId: actor.personId }, select: { targetPersonId: true, createdAt: true } }),
      db.relationshipTag.findMany({ where: { ownerId: actor.personId }, select: { targetPersonId: true, createdAt: true } }),
      connectionIds(db, actor.personId),
    ]);
    const lastContact = new Map<string, Date>();
    const bump = (id: string | null, at: Date) => {
      if (!id) return;
      const cur = lastContact.get(id);
      if (!cur || at > cur) lastContact.set(id, at);
    };
    for (const n of notes) bump(n.targetPersonId, n.updatedAt);
    for (const r of reminders) bump(r.targetPersonId, r.createdAt);
    for (const t of tags) bump(t.targetPersonId, t.createdAt);
    for (const id of connections) if (!lastContact.has(id)) lastContact.set(id, new Date(0));

    const ids = [...lastContact.keys()];
    const cards = await personCards(db, ids);
    let list = ids
      .map((id) => ({ id, card: cards.get(id), lastContactAt: lastContact.get(id)! }))
      .filter((r): r is { id: string; card: PersonCard; lastContactAt: Date } => !!r.card);
    if (q.q) {
      const needle = q.q.toLowerCase();
      list = list.filter((r) => r.card.name.toLowerCase().includes(needle) || r.card.username.toLowerCase().includes(needle) || (r.card.headline ?? "").toLowerCase().includes(needle));
    }
    list.sort((a, b) => b.lastContactAt.getTime() - a.lastContactAt.getTime());
    const page = list.slice(offset, offset + limit);
    const nextCursor = offset + limit < list.length ? encodeCursor(String(offset + limit), "o") : null;
    return reply.send({ items: page.map((r) => ({ person: r.card, lastContactAt: r.lastContactAt.getTime() > 0 ? r.lastContactAt.toISOString() : null })), nextCursor });
  });

  /** One person's card, for the CRM contact page to render even before any note exists about them. */
  app.get("/crm/contacts/:personId", async (req, reply) => {
    requireActor(req);
    const { personId } = z.object({ personId: z.string() }).parse(req.params);
    const card = (await personCards(db, [personId])).get(personId);
    if (!card) throw notFound("That person");
    return reply.send({ person: card });
  });

  /* ─────────────────────────── Loopcom hand-off ─────────────────────────── */

  app.post("/crm/push-to-loopcom", async (req, reply) => {
    const actor = requireActor(req);
    const body = z.object({ personId: z.string().min(1) }).parse(req.body);
    const person = await db.person.findUnique({ where: { id: body.personId }, include: { profile: { select: { firstName: true, lastName: true } } } });
    if (!person) throw notFound("That person");

    const [notes, membership] = await Promise.all([
      db.privateNote.findMany({ where: { ownerId: actor.personId, targetPersonId: body.personId }, orderBy: { createdAt: "desc" }, take: 20 }),
      db.membership.findFirst({
        where: { personId: body.personId, affiliation: { in: ["VERIFIED_ADMIN", "VERIFIED_DOMAIN"] } },
        orderBy: { isPrimary: "desc" },
        select: { organization: { select: { displayName: true } } },
      }),
    ]);
    const name = person.profile ? `${person.profile.firstName} ${person.profile.lastName}`.trim() : person.username;
    const payload = {
      name,
      phone: person.phoneE164 ?? undefined,
      email: person.email ?? undefined,
      company: membership?.organization.displayName ?? undefined,
      notes: notes.length ? notes.map((n) => n.body).join("\n---\n") : undefined,
    };

    await audit(db, { actorId: actor.personId, action: "crm.push_requested", targetType: "Person", targetId: body.personId });

    // Documented seam, not yet a live call: CONVENTIONS.md is explicit that Community
    // reaches Loopcom only through auth/loopcomSso.ts today. Once Loopcom ships a
    // `/community/crm-import` route, this becomes `POST {LOOPCOM_API_URL}/community/crm-import`
    // with `{ payload, sourcePersonId, pushedById }`. Until then this never fakes success.
    return reply.send({ queued: false, reason: "Loopcom CRM import endpoint not configured yet", payload });
  });

  /* ─────────────────────────── Export ─────────────────────────── */

  app.get("/crm/export.csv", async (req, reply) => {
    const actor = requireActor(req);
    const [notes, reminders] = await Promise.all([
      db.privateNote.findMany({ where: { ownerId: actor.personId }, orderBy: { createdAt: "desc" } }),
      db.reminder.findMany({ where: { ownerId: actor.personId }, orderBy: { dueAt: "desc" } }),
    ]);
    const personIds = [...new Set([...notes.map((n) => n.targetPersonId), ...reminders.map((r) => r.targetPersonId)].filter((x): x is string => !!x))];
    const orgIds = [...new Set([...notes.map((n) => n.targetOrgId), ...reminders.map((r) => r.targetOrgId)].filter((x): x is string => !!x))];
    const { people, orgs } = await cardsFor(personIds, orgIds);
    const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows: string[][] = [["Type", "Contact", "Body / title", "Tags", "Deal value", "Next action", "Due / next action at", "Created"]];
    for (const n of notes) {
      const who = n.targetPersonId ? people.get(n.targetPersonId)?.name ?? "" : n.targetOrgId ? orgs.get(n.targetOrgId)?.displayName ?? "" : "";
      rows.push(["Note", who, n.body, n.tags.join(" | "), dealValueOf(n.dealValue) ?? "", n.nextAction ?? "", n.nextActionAt ? n.nextActionAt.toISOString().slice(0, 10) : "", n.createdAt.toISOString().slice(0, 10)]);
    }
    for (const r of reminders) {
      const who = r.targetPersonId ? people.get(r.targetPersonId)?.name ?? "" : r.targetOrgId ? orgs.get(r.targetOrgId)?.displayName ?? "" : "";
      rows.push(["Reminder", who, r.title, "", "", "", r.dueAt.toISOString().slice(0, 10), r.createdAt.toISOString().slice(0, 10)]);
    }
    const csv = rows.map((r) => r.map(cell).join(",")).join("\r\n");
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="crm-export.csv"');
    return reply.send(csv);
  });

  registerQrRoutes(app, db);
}

export type { NoteRow };
