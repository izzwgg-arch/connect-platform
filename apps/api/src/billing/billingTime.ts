export const CONNECT_BILLING_TIME_ZONE = "America/New_York";

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const BILLING_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: CONNECT_BILLING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function billingLocalParts(instant: Date): LocalDateTimeParts {
  const parts = BILLING_DATE_FORMATTER.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function billingOffsetMs(instant: Date): number {
  const parts = billingLocalParts(instant);
  const localAsUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
  const instantSecondMs = Math.trunc(instant.getTime() / 1000) * 1000;
  return localAsUtcMs - instantSecondMs;
}

export function billingLocalDateTimeToUtc(input: LocalDateTimeParts & { millisecond?: number }): Date {
  const localAsUtcMs = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    input.second,
    input.millisecond ?? 0,
  );
  let utcMs = localAsUtcMs;
  for (let i = 0; i < 3; i++) {
    utcMs = localAsUtcMs - billingOffsetMs(new Date(utcMs));
  }
  return new Date(utcMs);
}

export function billingMonthBounds(anchor = new Date()): { periodStart: Date; periodEnd: Date } {
  const parts = billingLocalParts(anchor);
  return billingMonthBoundsForYearMonth(parts.year, parts.month);
}

export function billingMonthBoundsForYearMonth(year: number, month: number): { periodStart: Date; periodEnd: Date } {
  const periodStart = billingLocalDateTimeToUtc({ year, month, day: 1, hour: 0, minute: 0, second: 0 });
  const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const nextPeriodStart = billingLocalDateTimeToUtc({
    year: nextMonth.year,
    month: nextMonth.month,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
  });
  return { periodStart, periodEnd: new Date(nextPeriodStart.getTime() - 1) };
}

export function addBillingDays(date: Date, days: number): Date {
  const parts = billingLocalParts(date);
  const targetCalendar = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 0, 0, 0, 0));
  const targetParts = {
    year: targetCalendar.getUTCFullYear(),
    month: targetCalendar.getUTCMonth() + 1,
    day: targetCalendar.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    millisecond: date.getUTCMilliseconds(),
  };
  return billingLocalDateTimeToUtc(targetParts);
}

export function billingYearMonth(at = new Date()): { year: number; month: number } {
  const parts = billingLocalParts(at);
  return { year: parts.year, month: parts.month };
}

export function formatBillingDate(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: CONNECT_BILLING_TIME_ZONE,
  });
}

export function formatBillingDateIso(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  const parts = billingLocalParts(dt);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}
