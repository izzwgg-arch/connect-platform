/**
 * Loopcom Meetings — scheduling helpers. Pure functions, no db, no network,
 * so the two things most likely to embarrass us in a customer's inbox — the
 * address list and the time — are directly testable.
 *
 * ⛔ Two rules live here and both were chosen deliberately:
 *
 *  1. The email ALWAYS names the time zone. Recipients are elsewhere, and
 *     "2:00 PM" with no zone is a missed meeting and a support call. The zone
 *     is rendered for the meeting's own date, so it says "Eastern Daylight
 *     Time" in July and "Eastern Standard Time" in January rather than a
 *     generic label that is wrong half the year.
 *
 *  2. A pasted address list is taken as people actually paste it — from
 *     Outlook, from a spreadsheet, from another email. Commas, semicolons,
 *     newlines, tabs and `Name <a@b.com>` all work. Anything we cannot read is
 *     REPORTED back, never silently dropped: a host who pastes twelve addresses
 *     and gets ten invites with no explanation has been failed quietly.
 */

export {
  MAX_INVITES_PER_MEETING,
  parseInviteEmails,
  type ParsedInviteList,
} from "@connect/shared";

export const MIN_DURATION_MINUTES = 5;
export const MAX_DURATION_MINUTES = 12 * 60;

/** True when Node can actually format in this zone. An unknown zone must be
 *  refused at the door — silently falling back to UTC would put a time in the
 *  email that is right for nobody. */
export function isUsableTimeZone(zone: unknown): boolean {
  const tz = String(zone ?? "").trim();
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export type MeetingWhen = {
  /** "Thursday, September 4" — the year appears only when the meeting is NOT
   *  in the current year. The approved mockup shows it without a year, and a
   *  year on every invite reads like a form letter; but an invite for next
   *  January sent in December must not be ambiguous. */
  dateLine: string;
  /** "2:00 – 2:30 PM", or with both periods when they differ. */
  timeLine: string;
  /** "Eastern Daylight Time" — the zone as it applies on the meeting's date. */
  zoneLine: string;
  /** Compact form for the subject line: "Thu, Sep 4 at 2:00 PM". */
  subjectWhen: string;
};

function partsIn(date: Date, timeZone: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-US", { timeZone, ...opts }).formatToParts(date);
}

function pick(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

/** Render a start time + length the way the invite email states it.
 *
 *  ⛔ `timeZone` must already have passed `isUsableTimeZone`. It throws
 *  otherwise rather than inventing a time — see the rule at the top. */
export function formatMeetingWhen(params: {
  startAt: Date;
  durationMinutes: number;
  timeZone: string;
  /** Reference point for "is this the current year?". Injectable for tests. */
  now?: Date;
}): MeetingWhen {
  const { startAt, timeZone } = params;
  const duration = Math.max(MIN_DURATION_MINUTES, Math.round(params.durationMinutes));
  const endAt = new Date(startAt.getTime() + duration * 60_000);

  const yearIn = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(d);
  const sameYear = yearIn(startAt) === yearIn(params.now ?? new Date());
  const dateLine = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" as const }),
  }).format(startAt);

  const timeOpts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", hour12: true };
  const sp = partsIn(startAt, timeZone, timeOpts);
  const ep = partsIn(endAt, timeZone, timeOpts);
  const sClock = `${pick(sp, "hour")}:${pick(sp, "minute")}`;
  const eClock = `${pick(ep, "hour")}:${pick(ep, "minute")}`;
  const sPeriod = pick(sp, "dayPeriod").toUpperCase();
  const ePeriod = pick(ep, "dayPeriod").toUpperCase();

  // Same half of the day → say "AM"/"PM" once, at the end: "2:00 – 2:30 PM".
  const samePeriod = sPeriod === ePeriod;
  const start = samePeriod ? sClock : `${sClock} ${sPeriod}`;
  let timeLine = `${start} – ${eClock} ${ePeriod}`;

  // A meeting that runs past midnight must say so, or the end time reads as
  // earlier than the start.
  const dayKey = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  if (dayKey(startAt) !== dayKey(endAt)) {
    const endDay = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(endAt);
    timeLine = `${sClock} ${sPeriod} – ${eClock} ${ePeriod} (${endDay})`;
  }

  const zoneLine =
    partsIn(startAt, timeZone, { timeZoneName: "long" }).find((p) => p.type === "timeZoneName")?.value ||
    partsIn(startAt, timeZone, { timeZoneName: "short" }).find((p) => p.type === "timeZoneName")?.value ||
    timeZone;

  const subjectDate = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(startAt);
  const subjectWhen = `${subjectDate} at ${sClock} ${sPeriod}`;

  return { dateLine, timeLine, zoneLine, subjectWhen };
}
