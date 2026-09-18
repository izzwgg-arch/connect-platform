import type { FastifyInstance } from "fastify";
import { db as getDb, type Db } from "../db.js";
import { sweepIdempotencyKeys } from "../lib/idempotency.js";
import { notify } from "../lib/notify.js";
import { deliverPush } from "../lib/push.js";

/**
 * In-process schedulers (one api instance runs them; set COMMUNITY_SCHEDULERS=0
 * on extra instances). Each job is small, idempotent and logged.
 */
type Job = { name: string; everyMs: number; run: (db: Db) => Promise<void> };

export const jobs: Job[] = [
  { name: "idempotency.sweep", everyMs: 15 * 60_000, run: sweepIdempotencyKeys },
  { name: "person.purge_deleted", everyMs: 60 * 60_000, run: purgeDeletedPersons },
  { name: "reminders.due", everyMs: 60_000, run: fireDueReminders },
  { name: "analytics.rollup", everyMs: 10 * 60_000, run: rollupAnalytics },
  { name: "codes.sweep", everyMs: 30 * 60_000, run: sweepCodes },
  { name: "push.deliver", everyMs: 30_000, run: (db) => deliverPush(db) },
];

/** Domains register extra jobs (scheduled posts, RFQ closing, event reminders). */
export function addJob(job: Job) {
  jobs.push(job);
}

export function startSchedulers(app: FastifyInstance) {
  if (process.env.COMMUNITY_SCHEDULERS === "0") return;
  const db = getDb();
  for (const job of jobs) {
    const tick = async () => {
      try {
        await job.run(db);
      } catch (err) {
        app.log.error({ err, job: job.name }, "scheduler job failed");
      }
    };
    setTimeout(tick, 5_000 + Math.random() * 5_000);
    setInterval(tick, job.everyMs).unref();
  }
}

/** 14-day grace elapsed → anonymise the person; content they sent to others stays, attributed to "Deleted member". */
export async function purgeDeletedPersons(db: Db) {
  const due = await db.person.findMany({ where: { status: "PENDING_DELETION", deleteAfter: { lt: new Date() } }, select: { id: true } });
  for (const p of due) {
    await db.$transaction([
      db.profile.updateMany({ where: { personId: p.id }, data: { firstName: "Deleted", lastName: "member", headline: null, about: null, avatarAssetId: null, coverAssetId: null, skills: [], serviceArea: [], languages: [], objectives: [], links: undefined, searchText: null } }),
      db.experience.deleteMany({ where: { personId: p.id } }),
      db.education.deleteMany({ where: { personId: p.id } }),
      db.profileService.deleteMany({ where: { personId: p.id } }),
      db.certification.deleteMany({ where: { personId: p.id } }),
      db.portfolioItem.deleteMany({ where: { personId: p.id } }),
      db.session.deleteMany({ where: { personId: p.id } }),
      db.passkey.deleteMany({ where: { personId: p.id } }),
      db.oAuthAccount.deleteMany({ where: { personId: p.id } }),
      db.connection.deleteMany({ where: { OR: [{ aId: p.id }, { bId: p.id }] } }),
      db.follow.deleteMany({ where: { OR: [{ followerId: p.id }, { personId: p.id }] } }),
      db.privateNote.deleteMany({ where: { ownerId: p.id } }),
      db.reminder.deleteMany({ where: { ownerId: p.id } }),
      db.notification.deleteMany({ where: { personId: p.id } }),
      db.deviceToken.deleteMany({ where: { personId: p.id } }),
      db.post.updateMany({ where: { authorId: p.id }, data: { deletedAt: new Date() } }),
      db.membership.deleteMany({ where: { personId: p.id } }),
      db.person.update({ where: { id: p.id }, data: { email: null, phoneE164: null, passwordHash: null, loopcomUserId: null, loopcomTenantId: null, loopcomEmail: null, mfaTotpSecret: null, status: "DEACTIVATED", username: `deleted-${p.id.slice(-8)}` } }),
    ]);
    await db.auditLog.create({ data: { action: "person.purged", targetType: "Person", targetId: p.id, source: "scheduler" } });
  }
}

export async function fireDueReminders(db: Db) {
  const due = await db.reminder.findMany({ where: { dueAt: { lte: new Date() }, doneAt: null, notifiedAt: null }, take: 200 });
  for (const r of due) {
    await notify(db, { personId: r.ownerId, kind: "reminder.due", title: r.title, href: r.targetPersonId ? `/people/id/${r.targetPersonId}` : r.targetOrgId ? `/companies/id/${r.targetOrgId}` : "/crm", objectType: "Reminder", objectId: r.id });
    await db.reminder.update({ where: { id: r.id }, data: { notifiedAt: new Date() } });
  }
}

/** Rolls raw events into AnalyticsDaily for the last 2 days (idempotent upsert). */
export async function rollupAnalytics(db: Db) {
  const since = new Date(Date.now() - 2 * 86_400_000);
  since.setUTCHours(0, 0, 0, 0);
  const rows = await db.$queryRaw<Array<{ day: Date; objectType: string; objectId: string; event: string; count: bigint }>>`
    SELECT date_trunc('day', "occurredAt")::date AS day, "objectType", "objectId", "event", count(*)::bigint AS count
    FROM "AnalyticsEvent"
    WHERE "occurredAt" >= ${since} AND "objectType" IS NOT NULL AND "objectId" IS NOT NULL
    GROUP BY 1,2,3,4
  `;
  for (const r of rows) {
    await db.analyticsDaily.upsert({
      where: { day_objectType_objectId_event: { day: r.day, objectType: r.objectType, objectId: r.objectId, event: r.event } },
      create: { day: r.day, objectType: r.objectType, objectId: r.objectId, event: r.event, count: Number(r.count) },
      update: { count: Number(r.count) },
    });
  }
}

export async function sweepCodes(db: Db) {
  await db.verificationCode.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 86_400_000) } } });
}
