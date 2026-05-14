/**
 * Helpers for scheduled billing plan changes.
 * Phase 1: validation + audit-log helpers only.
 * Phase 2 (worker): consumeScheduledPlanChange lives in worker/main.ts.
 */

export type ScheduledPlanChangeValidationResult =
  | { ok: true; effectiveAt: Date }
  | { ok: false; error: string };

/**
 * Validates that `rawEffectiveAt` is:
 * - A parseable date
 * - UTC midnight on the 1st of a month
 * - Strictly after the first day of the current UTC month
 */
export function validateScheduledPlanChangeEffectiveAt(
  rawEffectiveAt: string,
  now = new Date(),
): ScheduledPlanChangeValidationResult {
  const effectiveAt = new Date(rawEffectiveAt);
  if (Number.isNaN(effectiveAt.getTime())) {
    return { ok: false, error: "effective_at_invalid_date" };
  }
  if (
    effectiveAt.getUTCDate() !== 1 ||
    effectiveAt.getUTCHours() !== 0 ||
    effectiveAt.getUTCMinutes() !== 0 ||
    effectiveAt.getUTCSeconds() !== 0 ||
    effectiveAt.getUTCMilliseconds() !== 0
  ) {
    return { ok: false, error: "effective_at_must_be_first_of_month_utc_midnight" };
  }
  const firstOfCurrentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  if (effectiveAt <= firstOfCurrentMonth) {
    return { ok: false, error: "effective_at_must_be_future_month" };
  }
  return { ok: true, effectiveAt };
}
