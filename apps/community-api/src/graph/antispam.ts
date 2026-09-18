import type { Db } from "../db.js";
import { tooMany } from "../lib/errors.js";

/**
 * Outreach anti-spam (brief: "explainable per signal" — OutreachStat already
 * carries the counters). `COMMUNITY_TEST_OUTREACH_CAP` lets a test shrink the
 * cap instead of sending 51 real requests.
 */
function normalCap(): number {
  const raw = process.env.COMMUNITY_TEST_OUTREACH_CAP;
  return raw ? Number(raw) : 50;
}
function restrictedCap(): number {
  const raw = process.env.COMMUNITY_TEST_OUTREACH_CAP;
  return raw ? Number(raw) : 30;
}

const WINDOW_24H_MS = 24 * 3600 * 1000;

async function currentStat(db: Db, personId: string) {
  const stat = await db.outreachStat.findUnique({ where: { personId } });
  if (!stat) return { personId, messagesLast24h: 0, requestsLast24h: 0, connectionsSent7d: 0, acceptedRate: 0, blockCount: 0, reportCount: 0, duplicateRatio: 0, windowStart: new Date() };
  // Roll the 24h window forward instead of letting it grow forever between sweeps.
  if (Date.now() - stat.windowStart.getTime() >= WINDOW_24H_MS) {
    return { ...stat, requestsLast24h: 0, windowStart: new Date() };
  }
  return stat;
}

/** Throws a human-readable 429 when the person's outreach rate is over the line. */
export async function assertOutreachAllowed(db: Db, personId: string): Promise<void> {
  const stat = await currentStat(db, personId);
  const restricted = stat.acceptedRate < 0.2 && stat.connectionsSent7d >= 20;
  const cap = restricted ? restrictedCap() : normalCap();
  if (stat.requestsLast24h >= cap) {
    if (restricted) {
      throw tooMany(`You've sent ${stat.requestsLast24h} requests today; most weren't accepted — try again tomorrow.`);
    }
    throw tooMany(`You've sent ${stat.requestsLast24h} connection requests in the last 24 hours — try again tomorrow.`);
  }
}

/** Call once a new outgoing PENDING connection is actually created/reopened. */
export async function recordOutreachSent(db: Db, personId: string): Promise<void> {
  const existing = await db.outreachStat.findUnique({ where: { personId } });
  const rollWindow = !existing || Date.now() - existing.windowStart.getTime() >= WINDOW_24H_MS;
  await db.outreachStat.upsert({
    where: { personId },
    create: { personId, requestsLast24h: 1, connectionsSent7d: 1, windowStart: new Date() },
    update: rollWindow
      ? { requestsLast24h: 1, connectionsSent7d: { increment: 1 }, windowStart: new Date() }
      : { requestsLast24h: { increment: 1 }, connectionsSent7d: { increment: 1 } },
  });
}

/** Recomputes acceptedRate for a requester after one of their requests settles. */
export async function recomputeAcceptedRate(db: Db, personId: string): Promise<void> {
  const [total, accepted] = await Promise.all([
    db.connection.count({ where: { requesterId: personId } }),
    db.connection.count({ where: { requesterId: personId, acceptedAt: { not: null } } }),
  ]);
  const acceptedRate = total > 0 ? accepted / total : 0;
  await db.outreachStat.upsert({
    where: { personId },
    create: { personId, acceptedRate },
    update: { acceptedRate },
  });
}
