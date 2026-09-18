import type { Db } from "../db.js";
import { publishTo } from "./realtime.js";
import { sendMail } from "./mail.js";

/**
 * Notification classes (brief §22). `batch` = collapse window in minutes;
 * classes with batch 0 are never collapsed (they need a decision).
 */
export const NOTIFICATION_CLASSES: Record<string, { label: string; batchMinutes: number; defaults: { inApp: boolean; push: boolean; email: boolean; sms: boolean } }> = {
  "connection.request": { label: "Connection requests", batchMinutes: 0, defaults: { inApp: true, push: true, email: false, sms: false } },
  "connection.accepted": { label: "Accepted connections", batchMinutes: 30, defaults: { inApp: true, push: true, email: false, sms: false } },
  "follow.new": { label: "New followers", batchMinutes: 60, defaults: { inApp: true, push: false, email: false, sms: false } },
  "post.reaction": { label: "Reactions on your posts", batchMinutes: 30, defaults: { inApp: true, push: false, email: false, sms: false } },
  "post.comment": { label: "Comments", batchMinutes: 0, defaults: { inApp: true, push: true, email: false, sms: false } },
  "post.mention": { label: "Mentions", batchMinutes: 0, defaults: { inApp: true, push: true, email: false, sms: false } },
  "post.repost": { label: "Reposts", batchMinutes: 60, defaults: { inApp: true, push: false, email: false, sms: false } },
  "message.new": { label: "Messages", batchMinutes: 0, defaults: { inApp: true, push: true, email: false, sms: false } },
  "message.request": { label: "Message requests", batchMinutes: 0, defaults: { inApp: true, push: true, email: false, sms: false } },
  "job.match": { label: "Job matches", batchMinutes: 0, defaults: { inApp: true, push: true, email: true, sms: false } },
  "job.application": { label: "Applications (employers)", batchMinutes: 0, defaults: { inApp: true, push: true, email: true, sms: false } },
  "job.stage": { label: "Application updates", batchMinutes: 0, defaults: { inApp: true, push: true, email: true, sms: false } },
  "rfq.invite": { label: "RFQs for your business", batchMinutes: 0, defaults: { inApp: true, push: true, email: true, sms: false } },
  "rfq.quote": { label: "Quotes on your RFQs", batchMinutes: 0, defaults: { inApp: true, push: true, email: true, sms: false } },
  "rfq.question": { label: "RFQ questions", batchMinutes: 0, defaults: { inApp: true, push: true, email: false, sms: false } },
  "rfq.decision": { label: "Quote decisions", batchMinutes: 0, defaults: { inApp: true, push: true, email: true, sms: false } },
  "rfq.closing": { label: "RFQ closing soon", batchMinutes: 0, defaults: { inApp: true, push: true, email: false, sms: false } },
  "event.reminder": { label: "Event reminders", batchMinutes: 0, defaults: { inApp: true, push: true, email: true, sms: false } },
  "event.update": { label: "Event updates", batchMinutes: 0, defaults: { inApp: true, push: true, email: false, sms: false } },
  "recommendation.new": { label: "Recommendations", batchMinutes: 0, defaults: { inApp: true, push: true, email: false, sms: false } },
  "inquiry.business": { label: "Business inquiries", batchMinutes: 0, defaults: { inApp: true, push: true, email: true, sms: false } },
  "opportunity.interest": { label: "Opportunity interest", batchMinutes: 0, defaults: { inApp: true, push: true, email: false, sms: false } },
  "intro.request": { label: "Introduction requests", batchMinutes: 0, defaults: { inApp: true, push: true, email: false, sms: false } },
  "intro.decision": { label: "Introduction decisions", batchMinutes: 0, defaults: { inApp: true, push: true, email: false, sms: false } },
  "group.request": { label: "Group join requests", batchMinutes: 0, defaults: { inApp: true, push: false, email: false, sms: false } },
  "group.approved": { label: "Group approvals", batchMinutes: 0, defaults: { inApp: true, push: true, email: false, sms: false } },
  "org.invite": { label: "Company invitations", batchMinutes: 0, defaults: { inApp: true, push: true, email: true, sms: false } },
  "org.verification": { label: "Verification results", batchMinutes: 0, defaults: { inApp: true, push: true, email: true, sms: false } },
  "security.alert": { label: "Security alerts", batchMinutes: 0, defaults: { inApp: true, push: true, email: true, sms: true } },
  "moderation.action": { label: "Moderation notices", batchMinutes: 0, defaults: { inApp: true, push: true, email: true, sms: false } },
  "reminder.due": { label: "Your reminders", batchMinutes: 0, defaults: { inApp: true, push: true, email: false, sms: false } },
};

export type NotifyInput = {
  personId: string;
  kind: keyof typeof NOTIFICATION_CLASSES | string;
  title: string;
  body?: string | null;
  href?: string | null;
  actorId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  /** When set, repeats inside the class's batch window collapse into one row (count++). */
  groupKey?: string | null;
};

export async function notify(db: Db, input: NotifyInput) {
  if (input.actorId && input.actorId === input.personId) return null;
  const cls = NOTIFICATION_CLASSES[input.kind] ?? { batchMinutes: 0, defaults: { inApp: true, push: true, email: false, sms: false } };
  const pref = await db.notificationPref.findUnique({ where: { personId_kind: { personId: input.personId, kind: input.kind } } });
  const p = pref ?? cls.defaults;
  if (!p.inApp && !p.push && !p.email && !p.sms) return null;

  let row;
  if (input.groupKey && cls.batchMinutes > 0) {
    const since = new Date(Date.now() - cls.batchMinutes * 60_000);
    const existing = await db.notification.findFirst({
      where: { personId: input.personId, groupKey: input.groupKey, readAt: null, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      row = await db.notification.update({
        where: { id: existing.id },
        data: { count: { increment: 1 }, title: input.title, body: input.body ?? null, actorId: input.actorId ?? null },
      });
    }
  }
  if (!row) {
    row = await db.notification.create({
      data: {
        personId: input.personId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        href: input.href ?? null,
        actorId: input.actorId ?? null,
        objectType: input.objectType ?? null,
        objectId: input.objectId ?? null,
        groupKey: input.groupKey ?? null,
      },
    });
  }
  await publishTo(input.personId, "notification", { id: row.id, kind: row.kind, title: row.title, body: row.body, href: row.href, count: row.count });
  if (p.email) {
    const person = await db.person.findUnique({ where: { id: input.personId }, select: { email: true, emailVerifiedAt: true } });
    if (person?.email && person.emailVerifiedAt) {
      await sendMail(db, {
        to: person.email,
        subject: input.title,
        text: `${input.title}\n\n${input.body ?? ""}\n\n${input.href ?? ""}`.trim(),
      });
      await db.notification.update({ where: { id: row.id }, data: { emailedAt: new Date() } });
    }
  }
  // pushedAt null = waiting for the push.deliver job (lib/push.ts); a class the
  // person muted for push is stamped immediately so the job never picks it up.
  if (!p.push) {
    row = await db.notification.update({ where: { id: row.id }, data: { pushedAt: new Date() } });
  }
  return row;
}

export async function unreadCount(db: Db, personId: string) {
  return db.notification.count({ where: { personId, readAt: null } });
}
