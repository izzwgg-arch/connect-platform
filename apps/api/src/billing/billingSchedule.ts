export const DEFAULT_BILLING_TIME_ZONE = "America/New_York";

export type BillingSchedule = {
  timeZone: string;
  paymentDate: string;
  nextPaymentDate: string;
  scheduledChargeAt: Date;
  periodStart: Date;
  periodEnd: Date;
  due: boolean;
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

export function buildBillingSchedule(input: {
  now?: Date;
  billingDayOfMonth: number;
  metadata?: unknown;
  timeZone?: string | null;
}): BillingSchedule {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone && isValidTimeZone(input.timeZone)
    ? input.timeZone
    : resolveBillingTimeZone(input.metadata);
  const today = localDateParts(now, timeZone);
  const paymentDay = clampBillingDay(today.year, today.month, input.billingDayOfMonth);
  const paymentLocal = { year: today.year, month: today.month, day: paymentDay };
  const nextMonth = addMonths(paymentLocal.year, paymentLocal.month, 1);
  const nextPaymentLocal = {
    year: nextMonth.year,
    month: nextMonth.month,
    day: clampBillingDay(nextMonth.year, nextMonth.month, input.billingDayOfMonth),
  };
  const scheduledChargeAt = localMidnightToUtc(paymentLocal, timeZone);
  const nextScheduledChargeAt = localMidnightToUtc(nextPaymentLocal, timeZone);

  return {
    timeZone,
    paymentDate: localDateKey(paymentLocal),
    nextPaymentDate: localDateKey(nextPaymentLocal),
    scheduledChargeAt,
    periodStart: scheduledChargeAt,
    periodEnd: new Date(nextScheduledChargeAt.getTime() - 1),
    due: now.getTime() >= scheduledChargeAt.getTime() && today.day >= paymentDay,
  };
}
