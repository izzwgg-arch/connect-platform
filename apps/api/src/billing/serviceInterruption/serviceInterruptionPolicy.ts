/**
 * Overdue-account service interruption — the pure policy layer.
 *
 * Two things live here and nothing else: WHO may still be dialled while a
 * tenant is interrupted, and HOW MANY DAYS are left before that happens.
 * No database, no network, no clock of its own — every function takes `now`
 * so the whole thing is testable and can never drift with the server's clock.
 *
 * ⛔⛔ THE EMERGENCY ALLOW-LIST IS NOT CONFIGURABLE, PER TENANT OR OTHERWISE.
 * A customer who has been cut off for an unpaid bill must still be able to
 * reach emergency services. That is not a billing preference, so there is
 * deliberately no setting, no metadata key and no admin control that can
 * remove an entry from `EMERGENCY_ALLOWED_DESTINATIONS`. If a future change
 * makes this list dynamic, it must be reviewed as a safety change, not a
 * billing one.
 */

/** Digits only, no punctuation, no country code. */
export const EMERGENCY_ALLOWED_DESTINATIONS: readonly string[] = Object.freeze([
  // Emergency services.
  "911",
  // Local EMS and fire department (Izzy, 2026-08-17).
  "8457831212",
]);

/** Days between the first failed payment and service being switched off. */
export const SERVICE_INTERRUPTION_GRACE_DAYS = 7;

/** Reminder is sent once per day while this many days remain (7 down to 1). */
export const MAX_REMINDER_DAYS = SERVICE_INTERRUPTION_GRACE_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reduce a dialled string to comparable digits.
 *
 * ⛔ Returns null rather than guessing. A destination we cannot parse is NOT
 * an emergency number, and must fail closed into "blocked", never "allowed".
 */
export function normalizeDialedDigits(dialed: string | null | undefined): string | null {
  if (typeof dialed !== "string") return null;
  const digits = dialed.replace(/\D+/g, "");
  if (!digits) return null;
  // US/Canada long-distance prefix: 1 + 10 digits is the same number as the 10.
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/**
 * May this destination be dialled while the tenant's service is interrupted?
 *
 * ⛔ Matches the WHOLE dialled number, never a substring. `845-911-1234`
 * contains "911" and is an ordinary phone number — treating it as an
 * emergency call would punch a hole straight through the interruption.
 */
export function isEmergencyDestination(dialed: string | null | undefined): boolean {
  const digits = normalizeDialedDigits(dialed);
  if (digits == null) return false;
  return EMERGENCY_ALLOWED_DESTINATIONS.includes(digits);
}

/**
 * The single question the call path asks.
 * `interrupted` false ⇒ everything is allowed, exactly as today.
 */
export function isOutboundCallAllowed(params: {
  interrupted: boolean;
  dialed: string | null | undefined;
}): boolean {
  if (!params.interrupted) return true;
  return isEmergencyDestination(params.dialed);
}

// ─── The seven-day clock ─────────────────────────────────────────────────────

export type InterruptionState = {
  /** Whole days remaining before service is switched off. 0 once due. */
  daysLeft: number;
  /** When service is due to be switched off. */
  interruptAt: Date;
  /** True once the grace period has run out. */
  dueForInterruption: boolean;
  /** True on the day service is switched off and after. */
  inGracePeriod: boolean;
};

/**
 * ⛔ The clock starts at the FIRST failed payment, not the most recent one.
 * Autopay retries a declined card several times; counting from the latest
 * attempt would silently restart the seven days on every retry and the
 * interruption would never arrive.
 */
export function computeInterruptionState(params: {
  firstFailedAt: Date;
  now: Date;
  graceDays?: number;
}): InterruptionState {
  const graceDays = params.graceDays ?? SERVICE_INTERRUPTION_GRACE_DAYS;
  const interruptAt = new Date(params.firstFailedAt.getTime() + graceDays * DAY_MS);
  const msLeft = interruptAt.getTime() - params.now.getTime();
  const dueForInterruption = msLeft <= 0;
  // Round UP: with 6 days and 2 hours to go the customer has "7 days left",
  // because they still have part of today. Rounding down would tell someone
  // with hours remaining that they have a whole extra day.
  const daysLeft = dueForInterruption ? 0 : Math.max(1, Math.ceil(msLeft / DAY_MS));
  return { daysLeft, interruptAt, dueForInterruption, inGracePeriod: !dueForInterruption };
}

/**
 * Should today's reminder be sent, and what should the banner say?
 *
 * Returns null when nothing should go out — already interrupted, already
 * reminded today, or the countdown has not started.
 */
export function decideDailyReminder(params: {
  firstFailedAt: Date;
  now: Date;
  lastReminderSentAt?: Date | null;
  graceDays?: number;
}): { daysLeft: number; interruptAt: Date } | null {
  const state = computeInterruptionState(params);
  if (state.dueForInterruption) return null;
  if (state.daysLeft > (params.graceDays ?? SERVICE_INTERRUPTION_GRACE_DAYS)) return null;

  if (params.lastReminderSentAt) {
    // One per calendar day in the billing time zone is handled by the caller
    // passing day-truncated values; here we simply refuse a second send
    // within the same 24h window, which is the property that matters.
    const since = params.now.getTime() - params.lastReminderSentAt.getTime();
    if (since < DAY_MS) return null;
  }
  return { daysLeft: state.daysLeft, interruptAt: state.interruptAt };
}
