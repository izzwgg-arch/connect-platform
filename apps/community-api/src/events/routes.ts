import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { requireActor } from "../auth/actor.js";
import { requireVerifiedActor } from "../auth/guards.js";
import { requireOrgPermission } from "../organizations/permissions.js";
import { audit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { track } from "../lib/analytics.js";
import { storeUpload } from "../media/service.js";
import { personCard, personCards, type PersonCard } from "../profiles/cards.js";
import { connectionIds } from "../policy/graph.js";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { addJob } from "../core/schedulers.js";
import { canSeeAttendeeList, reminderAtFor, rsvpOutcome, spotsLeft, type AttendeeListVisibility, type RsvpStatus } from "./policy.js";
import { attendeeCards, buildIcs, eventCard, eventSearchText, googleCalendarUrl, hydrateEventDetail, uniqueEventSlug } from "./service.js";

const ModeIn = z.enum(["ONLINE", "IN_PERSON", "HYBRID"]);
const VisibilityIn = z.enum(["PUBLIC", "ATTENDEES", "HOST"]);
const RsvpStatusIn = z.enum(["GOING", "INTERESTED", "NOT_GOING"]);

const SpeakerSchema = z.object({ name: z.string().min(1).max(120), title: z.string().max(160).optional(), personId: z.string().optional() });
const SponsorSchema = z.object({ name: z.string().min(1).max(120), url: z.string().url().optional() });

const CreateEventSchema = z
  .object({
    title: z.string().trim().min(2).max(160),
    description: z.string().trim().max(6000).optional(),
    mode: ModeIn.default("IN_PERSON"),
    startsAt: z.string(),
    endsAt: z.string(),
    timezone: z.string().max(60).default("America/New_York"),
    venue: z.string().trim().max(200).optional(),
    address: z.string().trim().max(300).optional(),
    onlineUrl: z.string().url().optional(),
    capacity: z.number().int().positive().max(100_000).optional(),
    isFree: z.boolean().default(true),
    price: z.number().nonnegative().max(1_000_000).optional(),
    attendeeListVisibility: VisibilityIn.default("ATTENDEES"),
    organizationId: z.string().optional(),
    groupId: z.string().optional(),
    speakers: z.array(SpeakerSchema).max(20).optional(),
    sponsors: z.array(SponsorSchema).max(20).optional(),
  })
  .refine((v) => new Date(v.endsAt).getTime() > new Date(v.startsAt).getTime(), { message: "The event has to end after it starts.", path: ["endsAt"] });

const PatchEventSchema = z.object({
  title: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().max(6000).optional(),
  mode: ModeIn.optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  timezone: z.string().max(60).optional(),
  venue: z.string().trim().max(200).optional(),
  address: z.string().trim().max(300).optional(),
  onlineUrl: z.string().url().optional(),
  capacity: z.number().int().positive().max(100_000).nullable().optional(),
  isFree: z.boolean().optional(),
  price: z.number().nonnegative().max(1_000_000).nullable().optional(),
  attendeeListVisibility: VisibilityIn.optional(),
  speakers: z.array(SpeakerSchema).max(20).optional(),
  sponsors: z.array(SponsorSchema).max(20).optional(),
});

async function requireGroupEventPermission(db: Db, personId: string, groupId: string) {
  const group = await db.group.findUnique({ where: { id: groupId } });
  if (!group) throw notFound("That group");
  const m = await db.groupMember.findUnique({ where: { groupId_personId: { groupId, personId } } });
  if (!m || m.state !== "ACTIVE" || (m.role !== "OWNER" && m.role !== "ADMIN")) throw forbidden("Only a group owner or admin can create events for this group.");
  return group;
}

async function canManageEvent(db: Db, actor: { personId: string; staffRole: string | null }, event: { hostId: string; organizationId: string | null; groupId: string | null }): Promise<boolean> {
  if (actor.staffRole === "ADMIN") return true;
  if (event.hostId === actor.personId) return true;
  if (event.organizationId) {
    try {
      await requireOrgPermission(db, actor as any, event.organizationId, "org.manage_events");
      return true;
    } catch {
      return false;
    }
  }
  if (event.groupId) {
    const m = await db.groupMember.findUnique({ where: { groupId_personId: { groupId: event.groupId, personId: actor.personId } } });
    if (m && m.state === "ACTIVE" && (m.role === "OWNER" || m.role === "ADMIN")) return true;
  }
  return false;
}

export function registerEventRoutes(app: FastifyInstance, db: Db) {
  const viewerOf = (req: FastifyRequest) => req.actor?.personId ?? null;

  /* ───────────────────────────── Create ───────────────────────────── */
  app.post("/events", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const input = CreateEventSchema.parse(req.body);
    if (input.organizationId) await requireOrgPermission(db, actor, input.organizationId, "org.manage_events");
    if (input.groupId) await requireGroupEventPermission(db, actor.personId, input.groupId);

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw badRequest("invalid_dates", "Enter a valid start and end time.");

    const slug = await uniqueEventSlug(db, input.title);
    const searchText = eventSearchText(input);

    const created = await db.$transaction(async (tx) => {
      const thread = await tx.thread.create({ data: { kind: "EVENT", title: input.title, createdById: actor.personId, participants: { create: [{ personId: actor.personId, role: "ADMIN", state: "ACTIVE" }] } } });
      const event = await tx.event.create({
        data: {
          slug,
          title: input.title,
          description: input.description ?? null,
          mode: input.mode,
          startsAt,
          endsAt,
          timezone: input.timezone,
          venue: input.venue ?? null,
          address: input.address ?? null,
          onlineUrl: input.onlineUrl ?? null,
          capacity: input.capacity ?? null,
          isFree: input.isFree,
          price: input.isFree ? null : input.price ?? null,
          attendeeListVisibility: input.attendeeListVisibility,
          organizationId: input.organizationId ?? null,
          groupId: input.groupId ?? null,
          hostId: actor.personId,
          speakers: input.speakers ?? undefined,
          sponsors: input.sponsors ?? undefined,
          chatThreadId: thread.id,
          searchText,
        },
      });
      await tx.eventRsvp.create({ data: { eventId: event.id, personId: actor.personId, status: "GOING", reminderAt: reminderAtFor(startsAt) } });
      await tx.event.update({ where: { id: event.id }, data: { rsvpCount: 1 } });
      return event;
    });

    await track(db, { personId: actor.personId, event: "event_view", objectType: "Event", objectId: created.id });
    reply.status(201);
    return { event: eventCard(await db.event.findUniqueOrThrow({ where: { id: created.id } })) };
  });

  /* ───────────────────────────── Discover / mine ───────────────────────────── */
  app.get("/events", async (req) => {
    requireActor(req);
    const q = z.object({ when: z.enum(["upcoming", "past"]).default("upcoming"), mode: ModeIn.optional(), q: z.string().trim().max(200).optional(), cursor: z.string().optional(), limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(q.limit, 20, 50);
    const cur = decodeCursor(q.cursor);
    const now = new Date();
    const where: any = q.when === "upcoming" ? { startsAt: { gte: now } } : { startsAt: { lt: now } };
    if (q.mode) where.mode = q.mode;
    if (q.q) {
      const needle = q.q.toLowerCase();
      where.OR = [{ title: { contains: needle, mode: "insensitive" } }, { description: { contains: needle, mode: "insensitive" } }, { venue: { contains: needle, mode: "insensitive" } }];
    }
    if (cur) where.startsAt = { ...where.startsAt, [q.when === "upcoming" ? "gt" : "lt"]: new Date(cur.value) };
    const rows = await db.event.findMany({ where, orderBy: { startsAt: q.when === "upcoming" ? "asc" : "desc" }, take: limit + 1 });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].startsAt, page[page.length - 1].id) : null;
    return { items: page.map(eventCard), nextCursor };
  });

  app.get("/me/events", async (req) => {
    const actor = requireActor(req);
    const [hosting, rsvps] = await Promise.all([
      db.event.findMany({ where: { hostId: actor.personId }, orderBy: { startsAt: "desc" }, take: 100 }),
      db.eventRsvp.findMany({ where: { personId: actor.personId, status: { in: ["GOING", "INTERESTED", "WAITLIST"] } }, include: { event: true }, orderBy: { event: { startsAt: "asc" } }, take: 100 }),
    ]);
    const items = [
      ...hosting.map((e) => ({ ...eventCard(e), relation: "HOST" as const })),
      ...rsvps.filter((r) => r.event.hostId !== actor.personId).map((r) => ({ ...eventCard(r.event), relation: r.status as "GOING" | "INTERESTED" | "WAITLIST" })),
    ];
    return { items };
  });

  /* ───────────────────────────── Public detail ───────────────────────────── */
  app.get("/public/events/:slug", async (req) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const viewerId = viewerOf(req);
    const event = await db.event.findUnique({ where: { slug } });
    if (!event) throw notFound("That event");
    const detail = await hydrateEventDetail(db, event);
    const myRsvp = viewerId ? await db.eventRsvp.findUnique({ where: { eventId_personId: { eventId: event.id, personId: viewerId } } }) : null;
    const [going, interested] = await Promise.all([
      db.eventRsvp.count({ where: { eventId: event.id, status: "GOING" } }),
      db.eventRsvp.count({ where: { eventId: event.id, status: "INTERESTED" } }),
    ]);
    const isHost = viewerId === event.hostId;
    const canSeeList = canSeeAttendeeList(event.attendeeListVisibility as AttendeeListVisibility, { isHost, hasRsvp: !!myRsvp });
    const attendees = canSeeList ? await attendeeCards(db, event.id, 60) : [];
    let inYourNetwork: { count: number; people: PersonCard[] } = { count: 0, people: [] };
    if (viewerId && canSeeList) {
      const mine = new Set(await connectionIds(db, viewerId));
      const known = attendees.filter((a) => mine.has(a.person.id)).map((a) => a.person);
      inYourNetwork = { count: known.length, people: known.slice(0, 6) };
    }
    await track(db, { personId: viewerId, event: "event_view", objectType: "Event", objectId: event.id });
    return {
      event: detail,
      myRsvp: myRsvp ? { status: myRsvp.status, visible: myRsvp.visible } : null,
      counts: { going, interested, spotsLeft: spotsLeft(event.capacity, going) },
      attendeeListVisible: canSeeList,
      attendees: attendees.map((a) => ({ person: a.person, status: a.status })),
      inYourNetwork,
      calendar: {
        icsUrl: `/events/${event.id}/ics`,
        googleUrl: googleCalendarUrl(event),
      },
    };
  });

  /* ───────────────────────────── Edit / cancel / cover ───────────────────────────── */
  app.patch("/events/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const event = await db.event.findUnique({ where: { id } });
    if (!event) throw notFound("That event");
    if (!(await canManageEvent(db, actor, event))) throw forbidden("You don't have permission to edit this event.");
    const body = PatchEventSchema.parse(req.body);
    const data: Record<string, unknown> = { ...body };
    if (body.startsAt) data.startsAt = new Date(body.startsAt);
    if (body.endsAt) data.endsAt = new Date(body.endsAt);
    const nextStarts = body.startsAt ? new Date(body.startsAt) : event.startsAt;
    const nextEnds = body.endsAt ? new Date(body.endsAt) : event.endsAt;
    if (nextEnds.getTime() <= nextStarts.getTime()) throw badRequest("invalid_dates", "The event has to end after it starts.");
    if (["title", "description", "venue", "address"].some((k) => k in body)) {
      data.searchText = eventSearchText({ title: body.title ?? event.title, description: body.description ?? event.description, venue: body.venue ?? event.venue, address: body.address ?? event.address });
    }
    const updated = await db.event.update({ where: { id }, data });
    await audit(db, { actorId: actor.personId, action: "event.update", targetType: "Event", targetId: id, before: { startsAt: event.startsAt, venue: event.venue }, after: body });

    const timeOrVenueChanged = body.startsAt || body.venue !== undefined || body.address !== undefined || body.onlineUrl !== undefined;
    if (timeOrVenueChanged) {
      const attendees = await db.eventRsvp.findMany({ where: { eventId: id, status: { in: ["GOING", "INTERESTED", "WAITLIST"] } }, select: { personId: true } });
      await Promise.all(
        attendees
          .filter((a) => a.personId !== actor.personId)
          .map((a) => notify(db, { personId: a.personId, kind: "event.update", title: `${updated.title} was updated`, href: `/events/${updated.slug}`, actorId: actor.personId, objectType: "Event", objectId: id })),
      );
    }
    return { event: eventCard(updated) };
  });

  app.delete("/events/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const event = await db.event.findUnique({ where: { id } });
    if (!event) throw notFound("That event");
    if (!(await canManageEvent(db, actor, event))) throw forbidden("You don't have permission to cancel this event.");
    const attendees = await db.eventRsvp.findMany({ where: { eventId: id, status: { in: ["GOING", "INTERESTED", "WAITLIST"] } }, select: { personId: true } });
    await Promise.all(
      attendees
        .filter((a) => a.personId !== actor.personId)
        .map((a) => notify(db, { personId: a.personId, kind: "event.update", title: `${event.title} was canceled`, actorId: actor.personId, objectType: "Event", objectId: id })),
    );
    await db.$transaction(async (tx) => {
      if (event.chatThreadId) await tx.thread.delete({ where: { id: event.chatThreadId } }).catch(() => undefined);
      await tx.event.delete({ where: { id } });
    });
    await audit(db, { actorId: actor.personId, action: "event.canceled", targetType: "Event", targetId: id });
    return { ok: true };
  });

  app.post("/events/:id/cover", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const event = await db.event.findUnique({ where: { id } });
    if (!event) throw notFound("That event");
    if (!(await canManageEvent(db, actor, event))) throw forbidden("You don't have permission to edit this event.");
    const file = await req.file();
    if (!file) throw badRequest("file_required", "Choose an image to upload.");
    const asset = await storeUpload(db, actor.personId, { buffer: await file.toBuffer(), filename: file.filename, mimetype: file.mimetype }, { allow: ["image"] });
    await db.event.update({ where: { id }, data: { coverAssetId: asset.id } });
    return { asset };
  });

  /* ───────────────────────────── RSVP ───────────────────────────── */
  app.post("/events/:id/rsvp", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const event = await db.event.findUnique({ where: { id } });
    if (!event) throw notFound("That event");
    const input = z.object({ status: RsvpStatusIn, visible: z.boolean().optional() }).parse(req.body);

    const existing = await db.eventRsvp.findUnique({ where: { eventId_personId: { eventId: id, personId: actor.personId } } });
    const currentGoing = await db.eventRsvp.count({ where: { eventId: id, status: "GOING" } });
    const outcome: RsvpStatus = rsvpOutcome(input.status, event.capacity, currentGoing, existing?.status === "GOING") as RsvpStatus;

    await db.eventRsvp.upsert({
      where: { eventId_personId: { eventId: id, personId: actor.personId } },
      create: { eventId: id, personId: actor.personId, status: outcome, visible: input.visible ?? true, reminderAt: reminderAtFor(event.startsAt) },
      update: { status: outcome, visible: input.visible ?? existing?.visible ?? true, reminderAt: reminderAtFor(event.startsAt) },
    });
    const goingCount = await db.eventRsvp.count({ where: { eventId: id, status: "GOING" } });
    await db.event.update({ where: { id }, data: { rsvpCount: goingCount } });

    if (outcome === "GOING" && event.chatThreadId) {
      const existingP = await db.threadParticipant.findUnique({ where: { threadId_personId: { threadId: event.chatThreadId, personId: actor.personId } } });
      if (!existingP) await db.threadParticipant.create({ data: { threadId: event.chatThreadId, personId: actor.personId, state: "ACTIVE" } });
      else if (existingP.state !== "ACTIVE") await db.threadParticipant.update({ where: { id: existingP.id }, data: { state: "ACTIVE" } });
    }
    await track(db, { personId: actor.personId, event: "event_rsvp", objectType: "Event", objectId: id, props: { status: outcome } });
    return { status: outcome, spotsLeft: spotsLeft(event.capacity, goingCount) };
  });

  app.delete("/events/:id/rsvp", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const event = await db.event.findUnique({ where: { id } });
    if (!event) throw notFound("That event");
    const existing = await db.eventRsvp.findUnique({ where: { eventId_personId: { eventId: id, personId: actor.personId } } });
    if (existing) {
      await db.eventRsvp.delete({ where: { eventId_personId: { eventId: id, personId: actor.personId } } });
      const goingCount = await db.eventRsvp.count({ where: { eventId: id, status: "GOING" } });
      await db.event.update({ where: { id }, data: { rsvpCount: goingCount } });
      if (event.chatThreadId) await db.threadParticipant.updateMany({ where: { threadId: event.chatThreadId, personId: actor.personId }, data: { state: "LEFT" } });
    }
    return { ok: true };
  });

  /* ───────────────────────────── Attendees / ics / chat ───────────────────────────── */
  app.get("/events/:id/attendees", async (req) => {
    const viewerId = viewerOf(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const event = await db.event.findUnique({ where: { id } });
    if (!event) throw notFound("That event");
    const myRsvp = viewerId ? await db.eventRsvp.findUnique({ where: { eventId_personId: { eventId: id, personId: viewerId } } }) : null;
    const isHost = viewerId === event.hostId;
    if (!canSeeAttendeeList(event.attendeeListVisibility as AttendeeListVisibility, { isHost, hasRsvp: !!myRsvp })) {
      throw forbidden("Only the host can see who's going to this event.");
    }
    const q = z.object({ cursor: z.string().optional(), limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(q.limit, 30, 100);
    const cur = decodeCursor(q.cursor);
    const where: any = { eventId: id, visible: true, status: { in: ["GOING", "INTERESTED"] } };
    if (cur) where.createdAt = { gt: new Date(cur.value) };
    const rows = await db.eventRsvp.findMany({ where, orderBy: { createdAt: "asc" }, take: limit + 1 });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].personId) : null;
    const cards = await personCards(db, page.map((r) => r.personId));
    return { items: page.map((r) => ({ person: cards.get(r.personId) ?? null, status: r.status })), nextCursor };
  });

  app.get("/events/:id/ics", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const event = await db.event.findUnique({ where: { id } });
    if (!event) throw notFound("That event");
    const ics = buildIcs(event);
    reply.header("content-type", "text/calendar; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${event.slug}.ics"`);
    return ics;
  });

  app.get("/events/:id/chat", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const event = await db.event.findUnique({ where: { id } });
    if (!event) throw notFound("That event");
    const isHost = event.hostId === actor.personId;
    const rsvp = await db.eventRsvp.findUnique({ where: { eventId_personId: { eventId: id, personId: actor.personId } } });
    if (!isHost && rsvp?.status !== "GOING") throw forbidden("RSVP as going to open this event's chat.");
    if (!event.chatThreadId) throw notFound("This event's chat");
    const existingP = await db.threadParticipant.findUnique({ where: { threadId_personId: { threadId: event.chatThreadId, personId: actor.personId } } });
    if (!existingP) await db.threadParticipant.create({ data: { threadId: event.chatThreadId, personId: actor.personId, state: "ACTIVE" } });
    return { threadId: event.chatThreadId };
  });

  /* ───────────────────────────── Invite ───────────────────────────── */
  app.post("/events/:id/invite", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const event = await db.event.findUnique({ where: { id } });
    if (!event) throw notFound("That event");
    const body = z.object({ personIds: z.array(z.string()).min(1).max(50) }).parse(req.body);
    const mine = new Set(await connectionIds(db, actor.personId));
    const inviter = await personCard(db, actor.personId);
    const invited: string[] = [];
    for (const personId of body.personIds) {
      if (personId === actor.personId || !mine.has(personId)) continue;
      await notify(db, { personId, kind: "event.update", title: `${inviter?.name ?? "Someone"} invited you to ${event.title}`, href: `/events/${event.slug}`, actorId: actor.personId, objectType: "Event", objectId: id });
      invited.push(personId);
    }
    return { invited };
  });

  /* ───────────────────────────── Reminders ───────────────────────────── */
  addJob({ name: "events.reminders", everyMs: 5 * 60_000, run: sendDueEventReminders });
}

export async function sendDueEventReminders(db: Db): Promise<void> {
  const due = await db.eventRsvp.findMany({ where: { reminderAt: { lte: new Date() } }, include: { event: true }, take: 200 });
  for (const r of due) {
    if (!r.event) {
      await db.eventRsvp.update({ where: { eventId_personId: { eventId: r.eventId, personId: r.personId } }, data: { reminderAt: null } }).catch(() => undefined);
      continue;
    }
    await notify(db, {
      personId: r.personId,
      kind: "event.reminder",
      title: `${r.event.title} starts soon`,
      body: `${r.event.venue ?? r.event.onlineUrl ?? ""}`.trim() || null,
      href: `/events/${r.event.slug}`,
      objectType: "Event",
      objectId: r.eventId,
    });
    await db.eventRsvp.update({ where: { eventId_personId: { eventId: r.eventId, personId: r.personId } }, data: { reminderAt: null } });
  }
}
