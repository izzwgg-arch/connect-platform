import type { Db } from "../db.js";
import { conflict } from "../lib/errors.js";

/**
 * Explainable anti-spam signals. Every number here is something a moderator
 * (or the appealing person) can be shown and understand — never a black-box
 * score.
 */
export type AccountSignalRow = { key: string; label: string; value: string | number; flagged?: boolean };

function normalizeText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Duplicate ratio over a list of message bodies: (sent - distinct) / sent, 0 when there's nothing to compare. */
export function computeDuplicateRatio(texts: string[]): number {
  const nonEmpty = texts.map(normalizeText).filter((t) => t.length > 0);
  if (nonEmpty.length === 0) return 0;
  const distinct = new Set(nonEmpty).size;
  return Math.max(0, (nonEmpty.length - distinct) / nonEmpty.length);
}

export async function accountSignals(db: Db, personId: string): Promise<AccountSignalRow[]> {
  const [person, verifications, stat, recentMessages, priorActions, connTotal, connAccepted, blockCount7d, reportsAgainst] = await Promise.all([
    db.person.findUnique({ where: { id: personId }, select: { createdAt: true } }),
    db.verification.findMany({ where: { personId, status: "VERIFIED" }, select: { kind: true } }),
    db.outreachStat.findUnique({ where: { personId } }),
    db.message.findMany({ where: { senderId: personId, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 50, select: { body: true } }),
    db.moderationAction.count({ where: { case: { OR: [{ subjectPersonId: personId }] } } }),
    db.connection.count({ where: { requesterId: personId } }),
    db.connection.count({ where: { requesterId: personId, acceptedAt: { not: null } } }),
    db.block.count({ where: { blockedId: personId, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }),
    db.report.count({ where: { targetType: "person", targetId: personId } }),
  ]);

  const accountAgeDays = person ? Math.floor((Date.now() - person.createdAt.getTime()) / 86_400_000) : 0;
  const duplicateRatio = computeDuplicateRatio(recentMessages.map((m) => m.body ?? ""));
  const acceptedRate = connTotal > 0 ? connAccepted / connTotal : (stat?.acceptedRate ?? 0);

  const rows: AccountSignalRow[] = [
    { key: "accountAgeDays", label: "Account age", value: `${accountAgeDays} day${accountAgeDays === 1 ? "" : "s"}`, flagged: accountAgeDays < 7 },
    { key: "verification", label: "Verification", value: verifications.length ? verifications.map((v) => v.kind).join(", ") : "None", flagged: verifications.length === 0 },
    { key: "messagesLast24h", label: "Messages sent (24h)", value: stat?.messagesLast24h ?? 0, flagged: (stat?.messagesLast24h ?? 0) > 200 },
    { key: "requestsLast24h", label: "Connection requests (24h)", value: stat?.requestsLast24h ?? 0, flagged: (stat?.requestsLast24h ?? 0) >= 30 },
    { key: "acceptedRate", label: "Connection accept rate", value: `${Math.round(acceptedRate * 100)}%`, flagged: connTotal >= 10 && acceptedRate < 0.1 },
    { key: "duplicateRatio", label: "Duplicate message ratio (last 50)", value: `${Math.round(duplicateRatio * 100)}%`, flagged: duplicateRatio > 0.5 },
    { key: "blockCount7d", label: "Blocked by (7d)", value: blockCount7d, flagged: blockCount7d >= 5 },
    { key: "reportCount", label: "Reports received (all time)", value: reportsAgainst, flagged: reportsAgainst >= 3 },
    { key: "priorActions", label: "Prior moderation actions", value: priorActions, flagged: priorActions > 0 },
  ];
  return rows;
}

/**
 * Runs as the "antispam.sweep" scheduler job (every 15 min). Never bans —
 * it only raises/creates an OPEN case with the tripped signals attached, so a
 * human always makes the call.
 */
export async function antispamSweep(db: Db): Promise<void> {
  const stats = await db.outreachStat.findMany({
    where: {
      OR: [{ messagesLast24h: { gt: 200 } }, { AND: [{ requestsLast24h: { gte: 30 } }, { acceptedRate: { lt: 0.1 } }] }],
    },
  });
  const heavyBlocked = await db.block.groupBy({
    by: ["blockedId"],
    where: { createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
    _count: { blockedId: true },
    having: { blockedId: { _count: { gte: 5 } } },
  });
  const flaggedIds = new Set<string>([...stats.map((s) => s.personId), ...heavyBlocked.map((b) => b.blockedId)]);
  if (flaggedIds.size === 0) return;

  for (const personId of flaggedIds) {
    const stat = stats.find((s) => s.personId === personId);
    const blocked = heavyBlocked.find((b) => b.blockedId === personId);
    const signals = {
      auto: true,
      messagesLast24h: stat?.messagesLast24h ?? 0,
      requestsLast24h: stat?.requestsLast24h ?? 0,
      acceptedRate: stat?.acceptedRate ?? 0,
      blockCount7d: blocked?._count.blockedId ?? 0,
    };
    const openOrReview = await db.moderationCase.findFirst({ where: { targetType: "person", targetId: personId, status: { in: ["OPEN", "IN_REVIEW"] } } });
    if (openOrReview) {
      await db.moderationCase.update({ where: { id: openOrReview.id }, data: { signals: { ...(openOrReview.signals as object), ...signals } } }).catch(() => undefined);
      continue;
    }
    await db.moderationCase
      .create({
        data: { targetType: "person", targetId: personId, subjectPersonId: personId, reason: "MASS_SOLICITATION", reportCount: 0, signals },
      })
      .catch((err: unknown) => {
        // Unique (targetType, targetId, status) race with another sweep tick — fine, it just means one already exists.
        if (!(err instanceof Error) || !/Unique constraint/.test(err.message)) throw err;
      });
  }
}

/** Thrown (409) when a case action is attempted twice concurrently on an already-resolved case. */
export function alreadyResolved() {
  return conflict("case_resolved", "This case was already resolved by someone else — refresh the queue.");
}
