export const DEFAULT_BILLING_TIME_ZONE = "America/New_York";

export type BillingSchedule = {
  timeZone: string;
  paymentDate: string;
  nextPaymentDate: string;
  scheduledChargeAt: Date;
  /** Local midnight on the calendar day 3 days before paymentDate (autopay reminder window opens). */
  scheduledReminderAt: Date;
  reminderDate: string;
  periodStart: Date;
  periodEnd: Date;
  /** True on/after scheduledReminderAt and before scheduledChargeAt (T-3 reminder + invoice prep). */
  reminderDue: boolean;
  /**
   * True ONLY on the calendar day the payment is set for, in the tenant's zone.
   *
   * ⛔ This used to stay true for the rest of the month (`today.day >= paymentDay`),
   * which made a charge a *condition* re-evaluated every hour and on every worker
   * restart rather than an event on a date — the reason autopay felt like it
   * "charges every minute" and why a stack of guard clauses was the only thing
   * preventing a double charge. A card must only ever be charged on the date the
   * customer was told.
   */
  due: boolean;
  /**
   * The payment date for this cycle has passed and the charge never ran (worker
   * outage, etc.). Deliberately NOT chargeable — a missed charge is surfaced for a
   * human instead of firing on an arbitrary later day. See runMonthlyBillingAutomation.
   */
  chargeWindowMissed: boolean;
};

type LocalDateParts = {
  year: number;
  month: number;
  day: number;
};

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function resolveBillingTimeZone(metadata: unknown): string {
  const meta = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const candidate = String(meta.billingTimeZone || meta.billingTimezone || meta.timeZone || meta.timezone || "").trim();
  if (candidate && isValidTimeZone(candidate)) return candidate;
  return DEFAULT_BILLING_TIME_ZONE;
}

function localDateParts(now: Date, timeZone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function clampBillingDay(year: number, month: number, billingDayOfMonth: number): number {
  const day = Math.max(1, Math.floor(Number(billingDayOfMonth) || 1));
  return Math.min(day, daysInMonth(year, month));
}

function addMonths(year: number, month: number, monthsToAdd: number): { year: number; month: number } {
  const zeroBased = month - 1 + monthsToAdd;
  const nextYear = year + Math.floor(zeroBased / 12);
  const nextMonth = ((zeroBased % 12) + 12) % 12 + 1;
  return { year: nextYear, month: nextMonth };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localDateKey(parts: LocalDateParts): string {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function timeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return (asUtc - instant.getTime()) / 60000;
}

function localMidnightToUtc(parts: LocalDateParts, timeZone: string): Date {
  const naiveUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
  let utc = new Date(naiveUtc - timeZoneOffsetMinutes(new Date(naiveUtc), timeZone) * 60000);
  utc = new Date(naiveUtc - timeZoneOffsetMinutes(utc, timeZone) * 60000);
  return utc;
}

function addLocalDays(parts: LocalDateParts, days: number, timeZone: string): LocalDateParts {
  const base = localMidnightToUtc(parts, timeZone);
  const shifted = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  return localDateParts(shifted, timeZone);
}

export function buildBillingSchedule(input: {
  now?: Date;
  billingDayOfMonth: number;
  metadata?: unknown;
  timeZone?: string | null;
}): BillingSchedule {
  return buildScheduleForAnchor(input, "current");
}

/**
 * The schedule for the NEXT charge that has not happened yet.
 *
 * ⛔ `buildBillingSchedule` always anchors the payment date inside the CURRENT
 * month, so once that day has passed the whole [reminder, charge) window sits in
 * the past and `reminderDue` can never be true again that month. For
 * `billingDayOfMonth = 1` — the schema default — the window is in the past on
 * every single day of the year, so the T-3 invoice-creation phase never ran and
 * those tenants never got an invoice at all (proven across a full simulated
 * year; see billingSchedule.test.ts).
 *
 * Invoice creation must therefore look FORWARD: anchor on the next occurrence of
 * the billing day at or after today, so the reminder window opens three days
 * before the charge that is actually coming. Charge/`due` semantics are
 * deliberately left to `buildBillingSchedule` so this fix cannot change when or
 * whether a card is charged.
 */
export function buildUpcomingBillingSchedule(input: {
  now?: Date;
  billingDayOfMonth: number;
  metadata?: unknown;
  timeZone?: string | null;
}): BillingSchedule {
  return buildScheduleForAnchor(input, "upcoming");
}

function buildScheduleForAnchor(
  input: {
    now?: Date;
    billingDayOfMonth: number;
    metadata?: unknown;
    timeZone?: string | null;
  },
  anchor: "current" | "upcoming",
): BillingSchedule {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone && isValidTimeZone(input.timeZone)
    ? input.timeZone
    : resolveBillingTimeZone(input.metadata);
  const today = localDateParts(now, timeZone);
  let anchorYear = today.year;
  let anchorMonth = today.month;
  if (anchor === "upcoming" && today.day > clampBillingDay(today.year, today.month, input.billingDayOfMonth)) {
    const shifted = addMonths(today.year, today.month, 1);
    anchorYear = shifted.year;
    anchorMonth = shifted.month;
  }
  const paymentDay = clampBillingDay(anchorYear, anchorMonth, input.billingDayOfMonth);
  const paymentLocal = { year: anchorYear, month: anchorMonth, day: paymentDay };
  const nextMonth = addMonths(paymentLocal.year, paymentLocal.month, 1);
  const nextPaymentLocal = {
    year: nextMonth.year,
    month: nextMonth.month,
    day: clampBillingDay(nextMonth.year, nextMonth.month, input.billingDayOfMonth),
  };
  const scheduledChargeAt = localMidnightToUtc(paymentLocal, timeZone);
  const nextScheduledChargeAt = localMidnightToUtc(nextPaymentLocal, timeZone);
  const reminderLocal = addLocalDays(paymentLocal, -3, timeZone);
  const scheduledReminderAt = localMidnightToUtc(reminderLocal, timeZone);

  return {
    timeZone,
    paymentDate: localDateKey(paymentLocal),
    nextPaymentDate: localDateKey(nextPaymentLocal),
    scheduledChargeAt,
    scheduledReminderAt,
    reminderDate: localDateKey(reminderLocal),
    periodStart: scheduledChargeAt,
    periodEnd: new Date(nextScheduledChargeAt.getTime() - 1),
    reminderDue: now.getTime() >= scheduledReminderAt.getTime() && now.getTime() < scheduledChargeAt.getTime(),
    due:
      now.getTime() >= scheduledChargeAt.getTime() &&
      today.day === paymentDay &&
      today.month === paymentLocal.month &&
      today.year === paymentLocal.year,
    chargeWindowMissed:
      now.getTime() >= scheduledChargeAt.getTime() &&
      !(today.day === paymentDay && today.month === paymentLocal.month && today.year === paymentLocal.year),
  };
}
