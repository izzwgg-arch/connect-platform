/**
 * Shared CRM aggregate date boundaries and recurring Prisma filter fragments (Phase 15B).
 * Logic copied verbatim from historical per-route copies — single source to prevent drift.
 */

export type TodayBounds = { now: Date; start: Date; end: Date };

export function todayBounds(): TodayBounds {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { now, start, end };
}

export function daysAgoBounds(days: number): { now: Date; since: Date } {
  const now = new Date();
  const since = new Date(now);
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);
  return { now, since };
}

export function endOfWeek(): Date {
  const d = new Date();
  d.setDate(d.getDate() + (6 - d.getDay()));
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Same construction as GET /crm/reports/follow-ups (`tomorrow` from midnight today). */
export function startOfTomorrowFromDayStart(todayStart: Date): Date {
  const tomorrow = new Date(todayStart);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow;
}

/** Nested campaign filter: ACTIVE only (shared shape across diagnostics / counts). */
export const crmCampaignActiveWhere = { status: "ACTIVE" as const };
