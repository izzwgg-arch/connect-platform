import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { requireActor } from "../auth/actor.js";
import { badRequest, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { NOTIFICATION_CLASSES, unreadCount } from "../lib/notify.js";
import { personCards } from "../profiles/cards.js";

const FILTERS = ["all", "decisions", "network", "rfq", "jobs", "posts", "events", "security"] as const;
type Filter = (typeof FILTERS)[number];

/** Kinds that put a decision in the person's hands — these lead the list. */
const DECISION_KINDS = ["connection.request", "message.request", "rfq.quote", "rfq.invite", "intro.request", "group.request", "org.invite", "recommendation.new"];

function filterWhere(filter: Filter): Record<string, unknown> {
  switch (filter) {
    case "decisions":
      return { kind: { in: DECISION_KINDS } };
    case "network":
      return { OR: [{ kind: { startsWith: "connection." } }, { kind: { startsWith: "follow." } }, { kind: { startsWith: "intro." } }] };
    case "rfq":
      return { kind: { startsWith: "rfq." } };
    case "jobs":
      return { kind: { startsWith: "job." } };
    case "posts":
      return { kind: { startsWith: "post." } };
    case "events":
      return { kind: { startsWith: "event." } };
    case "security":
      return { OR: [{ kind: { startsWith: "security." } }, { kind: { startsWith: "moderation." } }] };
    default:
      return {};
  }
}

function groupFor(d: Date): "today" | "week" | "earlier" {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (d >= startOfToday) return "today";
  const startOfWeek = new Date(startOfToday.getTime() - 6 * 86_400_000);
  if (d >= startOfWeek) return "week";
  return "earlier";
}

/**
 * Notifications domain: the grouped/filterable inbox, read state, per-class
 * channel prefs (in-app/push/email/sms) and quiet hours (stored on
 * Person.preferences.quietHours — there is no dedicated table for it).
 */
export function registerNotificationRoutes(app: FastifyInstance, db: Db) {
  app.get("/notifications", async (req) => {
    const actor = requireActor(req);
    const q = z
      .object({ cursor: z.string().optional(), filter: z.enum(FILTERS).optional().default("all"), limit: z.any().optional() })
      .parse(req.query);
    const cur = decodeCursor(q.cursor);
    const take = clampLimit(q.limit);
    const clauses: Record<string, unknown>[] = [{ personId: actor.personId }];
    const fw = filterWhere(q.filter);
    if (Object.keys(fw).length) clauses.push(fw);
    if (cur) clauses.push({ OR: [{ createdAt: { lt: new Date(cur.value) } }, { createdAt: new Date(cur.value), id: { lt: cur.id } }] });
    const rows = await db.notification.findMany({
      where: { AND: clauses },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
    });
    const page = rows.slice(0, take);
    const actorIds = page.map((r) => r.actorId).filter((x): x is string => !!x);
    const cards = await personCards(db, actorIds);
    const items = page.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      href: r.href,
      count: r.count,
      readAt: r.readAt,
      createdAt: r.createdAt,
      objectType: r.objectType,
      objectId: r.objectId,
      actor: r.actorId ? cards.get(r.actorId) ?? null : null,
      group: groupFor(r.createdAt),
    }));
    const nextCursor = rows.length > take ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null;
    return { items, nextCursor };
  });

  app.post("/notifications/read", async (req) => {
    const actor = requireActor(req);
    const body = z.object({ ids: z.array(z.string()).max(200).optional(), all: z.boolean().optional() }).parse(req.body);
    if (body.all) {
      await db.notification.updateMany({ where: { personId: actor.personId, readAt: null }, data: { readAt: new Date() } });
    } else if (body.ids?.length) {
      await db.notification.updateMany({ where: { personId: actor.personId, id: { in: body.ids } }, data: { readAt: new Date() } });
    } else {
      throw badRequest("nothing_to_mark", "Choose notifications to mark as read.");
    }
    return { unread: await unreadCount(db, actor.personId) };
  });

  app.get("/notifications/unread-count", async (req) => {
    const actor = requireActor(req);
    return { unread: await unreadCount(db, actor.personId) };
  });

  app.delete("/notifications/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const del = await db.notification.deleteMany({ where: { id, personId: actor.personId } });
    if (!del.count) throw notFound("Notification");
    return { ok: true };
  });

  // ── prefs ────────────────────────────────────────────────────────────
  app.get("/me/notification-prefs", async (req) => {
    const actor = requireActor(req);
    const [rows, person] = await Promise.all([
      db.notificationPref.findMany({ where: { personId: actor.personId } }),
      db.person.findUnique({ where: { id: actor.personId }, select: { preferences: true } }),
    ]);
    const byKind = new Map(rows.map((p) => [p.kind, p]));
    const classes = Object.entries(NOTIFICATION_CLASSES).map(([kind, cls]) => {
      const p = byKind.get(kind);
      return {
        kind,
        label: cls.label,
        inApp: p?.inApp ?? cls.defaults.inApp,
        push: p?.push ?? cls.defaults.push,
        email: p?.email ?? cls.defaults.email,
        sms: p?.sms ?? cls.defaults.sms,
        canSms: kind === "security.alert",
      };
    });
    const prefsJson = (person?.preferences as Record<string, unknown> | null) ?? {};
    const quietHours = (prefsJson.quietHours as unknown) ?? { enabled: false, from: "16:00", to: "21:00", days: [] };
    return { classes, quietHours };
  });

  app.put("/me/notification-prefs", async (req) => {
    const actor = requireActor(req);
    const body = z
      .object({
        classes: z.record(z.object({ inApp: z.boolean(), push: z.boolean(), email: z.boolean(), sms: z.boolean() })).optional(),
        quietHours: z.object({ enabled: z.boolean(), from: z.string(), to: z.string(), days: z.array(z.number().int().min(0).max(6)) }).optional(),
      })
      .parse(req.body);
    const person = await db.person.findUnique({ where: { id: actor.personId }, select: { phoneVerifiedAt: true, preferences: true } });
    if (body.classes) {
      const entries = Object.entries(body.classes).filter(([kind]) => kind in NOTIFICATION_CLASSES);
      for (const [kind, v] of entries) {
        if (v.sms && kind !== "security.alert") throw badRequest("sms_not_allowed", "SMS notifications are only available for security alerts.");
        if (v.sms && !person?.phoneVerifiedAt) throw badRequest("phone_not_verified", "Verify your mobile number first (Settings → Account) to get SMS alerts.");
      }
      for (const [kind, v] of entries) {
        await db.notificationPref.upsert({
          where: { personId_kind: { personId: actor.personId, kind } },
          create: { personId: actor.personId, kind, ...v },
          update: v,
        });
      }
    }
    if (body.quietHours) {
      const prefsJson = { ...((person?.preferences as Record<string, unknown> | null) ?? {}), quietHours: body.quietHours };
      await db.person.update({ where: { id: actor.personId }, data: { preferences: prefsJson } });
    }
    await audit(db, { actorId: actor.personId, action: "person.notification_prefs", targetType: "Person", targetId: actor.personId, after: body });
    return { ok: true };
  });
}
