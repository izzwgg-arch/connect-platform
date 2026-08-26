/**
 * The learning loop (supermarket plan Phases 3 + 7): the correction-rate
 * gauge, week by week, and the auto-submit decision it gates.
 *
 * ⛔ Auto-submit turns on ONLY when BOTH are true: the tenant's switch is
 * enabled (Izzy's explicit flip) AND the written threshold has been met —
 * correction rate under `maxCorrectionPct` for `minWeeks` CONSECUTIVE recent
 * weeks with real volume. Flipping the switch alone does nothing until the
 * numbers earn it; the numbers alone do nothing until the switch is flipped.
 * Pure functions; the stress suite sweeps them.
 */

export type WeekStat = {
  /** ISO Monday of the week. */
  weekStart: string;
  drafts: number;
  /** Mean correctionRatePct across the week's reviewed drafts. */
  correctionRatePct: number;
};

export type AutoSubmitConfig = {
  autoSubmitEnabled: boolean;
  autoSubmitMaxCorrectionPct: number;
  autoSubmitMinWeeks: number;
};

/** Minimum reviewed drafts a week needs to count as evidence at all. */
export const MIN_WEEK_VOLUME = 5;

function mondayOf(d: Date): string {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (day.getUTCDay() + 6) % 7; // Monday = 0
  day.setUTCDate(day.getUTCDate() - dow);
  return day.toISOString().slice(0, 10);
}

/**
 * Aggregate reviewed drafts into weekly correction stats. Input rows carry
 * the stored `corrections` json (from computeCorrections) + approvedAt.
 */
export function weeklyCorrectionStats(
  rows: Array<{ approvedAt: Date | string | null; corrections: unknown }>,
): WeekStat[] {
  const byWeek = new Map<string, { n: number; sum: number }>();
  for (const row of rows) {
    if (!row.approvedAt) continue;
    const at = new Date(row.approvedAt as any);
    if (Number.isNaN(at.getTime())) continue;
    const c: any = row.corrections;
    const rate = typeof c?.correctionRatePct === "number" && Number.isFinite(c.correctionRatePct)
      ? Math.max(0, Math.min(100, c.correctionRatePct))
      : null;
    if (rate === null) continue;
    const week = mondayOf(at);
    const agg = byWeek.get(week) ?? { n: 0, sum: 0 };
    agg.n++;
    agg.sum += rate;
    byWeek.set(week, agg);
  }
  return [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([weekStart, { n, sum }]) => ({ weekStart, drafts: n, correctionRatePct: Math.round((sum / n) * 10) / 10 }));
}

export type AutoSubmitDecision = {
  allowed: boolean;
  reason:
    | "ok"
    | "switch_off"
    | "not_enough_weeks"
    | "rate_above_threshold"
    | "insufficient_volume";
  /** The most recent consecutive qualifying weeks counted. */
  qualifyingWeeks: number;
};

/** The Phase 7 gate. Judged on the MOST RECENT weeks, newest backwards. */
export function decideAutoSubmit(weeks: WeekStat[], config: AutoSubmitConfig): AutoSubmitDecision {
  if (!config.autoSubmitEnabled) return { allowed: false, reason: "switch_off", qualifyingWeeks: 0 };
  const minWeeks = Math.max(1, Math.floor(config.autoSubmitMinWeeks));
  const threshold = Math.max(0, config.autoSubmitMaxCorrectionPct);
  const recent = [...weeks].sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1)).slice(-minWeeks);
  if (recent.length < minWeeks) return { allowed: false, reason: "not_enough_weeks", qualifyingWeeks: recent.length };
  let qualifying = 0;
  for (const week of recent) {
    if (week.drafts < MIN_WEEK_VOLUME) return { allowed: false, reason: "insufficient_volume", qualifyingWeeks: qualifying };
    if (week.correctionRatePct > threshold) {
      return { allowed: false, reason: "rate_above_threshold", qualifyingWeeks: qualifying };
    }
    qualifying++;
  }
  return { allowed: true, reason: "ok", qualifyingWeeks: qualifying };
}
