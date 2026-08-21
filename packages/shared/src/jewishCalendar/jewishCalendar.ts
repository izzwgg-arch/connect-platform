/**
 * The Jewish calendar, as a phone system needs it.
 *
 * One pure resolver, shared by apps/api (which decides the IVR menu) and
 * apps/worker (which decides the hold music), so the two can never disagree
 * about whether it is yom tov.
 *
 * ⛔⛔ THE THING THAT MAKES THIS DIFFERENT FROM THE OLD holidayDates LIST:
 * a Jewish day turns at SUNSET, not midnight. Rosh Hashanah 5787 runs from
 * candle lighting on Friday 11 September to nightfall on Sunday the 13th — one
 * continuous 49½-hour closure across three Gregorian dates. A whole-day date
 * match marks Saturday and Sunday and leaves Friday evening answering normally.
 * So this returns INTERVALS, never dates.
 *
 * The dates come from a generated table (see holidayTable.json); the times are
 * computed from the customer's own latitude and longitude. Nothing here calls
 * out to anything, and nothing here needs updating each year.
 */
import table from "./holidayTable.json";
import {
  candleLighting, nightfall, sunset,
  type NightfallShita, DEFAULT_NIGHTFALL_SHITA, DEFAULT_CANDLE_LIGHTING_MINUTES,
} from "./zmanim";

export type HolidayKind = "yomtov" | "cholhamoed" | "erev" | "majorfast" | "minorfast" | "minor";
export type DayTreatment = "closed" | "early" | "open";
/** Which sefirah minhag the customer keeps, or none. */
export type SefirahMinhag = "none" | "early" | "late" | "whole";

export interface JewishCalendarSettings {
  enabled: boolean;
  latitude: number;
  longitude: number;
  timezone: string;
  nightfallShita: NightfallShita;
  candleLightingMinutes: number;
  /** Let the calendar close them for Shabbos, rather than the weekly hours. */
  closeForShabbos: boolean;
  closeForYomTov: boolean;
  /** Minutes before candle lighting that the phone stops taking calls. 0 = don't. */
  earlyCloseMinutesBeforeCandles: number;
  /** How long after nightfall the phone comes back. 0 = at nightfall. */
  reopenMinutesAfterNightfall: number;
  /** Whether the phone waits for the next morning's opening hours instead. */
  reopenNextMorning: boolean;
  cholHamoed: DayTreatment;
  /** Applies to the four minor fasts and Tisha B'Av. Minor holidays are separate. */
  fastDays: DayTreatment;
  /** Per-holiday overrides keyed by the table's holiday name ("Pesach", "Purim"…). */
  holidayOverrides: Record<string, DayTreatment>;
  /** Music mourning — drives the switch to a cappella, never the phone menu. */
  sefirah: SefirahMinhag;
  threeWeeksNoMusic: boolean;
  nineDaysNoMusic: boolean;
}

export const DEFAULT_JEWISH_CALENDAR: JewishCalendarSettings = {
  enabled: false,
  latitude: 41.1112, longitude: -74.0687, timezone: "America/New_York", // Monsey
  nightfallShita: DEFAULT_NIGHTFALL_SHITA,
  candleLightingMinutes: DEFAULT_CANDLE_LIGHTING_MINUTES,
  closeForShabbos: true,
  closeForYomTov: true,
  earlyCloseMinutesBeforeCandles: 60,
  reopenMinutesAfterNightfall: 0,
  reopenNextMorning: true,
  cholHamoed: "open",
  fastDays: "open",
  holidayOverrides: {},
  sefirah: "early",
  threeWeeksNoMusic: true,
  nineDaysNoMusic: true,
};

export interface JewishCalendarVerdict {
  /** Is the business closed at this instant because of the Jewish calendar? */
  closed: boolean;
  /** Plain English, for the screen and for "why is my phone doing this". */
  reason: string;
  holidayName: string | null;
  kind: HolidayKind | "shabbos" | null;
  /** Set when today is an erev that closes early — the moment it closes. */
  closesAt: Date | null;
  /** When the current closure lifts. */
  reopensAt: Date | null;
  /** Instrumental music should not play — sefirah, three weeks, nine days. */
  noMusic: boolean;
  noMusicReason: string | null;
}

// ── table access ─────────────────────────────────────────────────────────────
type TableDay = [string, HolidayKind, number];
const DAYS = table.days as unknown as Record<string, TableDay>;
const PERIODS = table.periods as unknown as Record<string, Array<[string, string]>>;

/** First and last Gregorian date the generated table covers. */
export const TABLE_RANGE: readonly [string, string] =
  table.gregorianRange as unknown as [string, string];

/** True when `dateYmd` is inside the generated table. Outside it we know nothing. */
export function isDateCovered(dateYmd: string): boolean {
  return dateYmd >= TABLE_RANGE[0] && dateYmd <= TABLE_RANGE[1];
}

/** How many days of table are left after `dateYmd`. Feeds the refresh alarm. */
export function daysOfTableRemaining(dateYmd: string): number {
  const end = Date.parse(TABLE_RANGE[1] + "T00:00:00Z");
  const at = Date.parse(dateYmd + "T00:00:00Z");
  if (!Number.isFinite(end) || !Number.isFinite(at)) return 0;
  return Math.max(0, Math.round((end - at) / 86_400_000));
}

export function holidayOn(dateYmd: string): { name: string; kind: HolidayKind; endsTonight: boolean } | null {
  const row = DAYS[dateYmd];
  if (!row) return null;
  return { name: row[0], kind: row[1], endsTonight: row[2] === 1 };
}

// ── local date helpers ───────────────────────────────────────────────────────
const ymdFormatters = new Map<string, Intl.DateTimeFormat>();
/** "YYYY-MM-DD" for an instant, in the tenant's own timezone. */
export function localYmd(at: Date, timezone: string): string {
  let f = ymdFormatters.get(timezone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      f = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
    }
    ymdFormatters.set(timezone, f);
  }
  return f.format(at);
}

const dowFormatters = new Map<string, Intl.DateTimeFormat>();
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** Day of week (0=Sun) for a "YYYY-MM-DD", independent of timezone. */
export function dayOfWeek(dateYmd: string): number {
  const [y, m, d] = dateYmd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function shiftYmd(dateYmd: string, days: number): string {
  const [y, m, d] = dateYmd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

// ── how a single calendar day is treated ─────────────────────────────────────
/**
 * Whether the business is shut for the WHOLE of `dateYmd`, and why.
 *
 * ⛔ A per-holiday override wins over the blanket switches, so a customer who
 * works Chol Hamoed but not Purim gets exactly that.
 */
export function treatmentForDay(
  dateYmd: string, s: JewishCalendarSettings,
): { treatment: DayTreatment; label: string; kind: HolidayKind | "shabbos" | null } {
  const hol = holidayOn(dateYmd);
  const isShabbos = dayOfWeek(dateYmd) === 6;

  if (hol) {
    const override = s.holidayOverrides[hol.name];
    if (hol.kind === "yomtov") {
      const t = override ?? (s.closeForYomTov ? "closed" : "open");
      if (t === "closed") return { treatment: "closed", label: hol.name, kind: "yomtov" };
      if (t === "early") return { treatment: "early", label: hol.name, kind: "yomtov" };
      // explicitly opened yom tov still yields to Shabbos below
    } else if (hol.kind === "cholhamoed") {
      const t = override ?? s.cholHamoed;
      if (t !== "open") return { treatment: t, label: `Chol Hamoed ${hol.name}`, kind: "cholhamoed" };
    } else if (hol.kind === "majorfast" || hol.kind === "minorfast") {
      const t = override ?? s.fastDays;
      if (t !== "open") return { treatment: t, label: hol.name, kind: hol.kind };
    } else if (hol.kind === "minor") {
      // Purim, Chanukah, Lag BaOmer. Nobody is halachically shut, so these are
      // open unless the customer says otherwise — but plenty do close for Purim,
      // which is exactly why they are in the table.
      const t = override ?? "open";
      if (t !== "open") return { treatment: t, label: hol.name, kind: "minor" };
    }
  }
  if (isShabbos && s.closeForShabbos) return { treatment: "closed", label: "Shabbos", kind: "shabbos" };
  // An erev is not itself closed — the early close is derived from the day that
  // FOLLOWS it, so that erev Shabbos works even though no holiday row exists.
  return { treatment: "open", label: hol ? hol.name : "", kind: hol ? hol.kind : null };
}

const isClosedDay = (d: string, s: JewishCalendarSettings) => treatmentForDay(d, s).treatment === "closed";

// ── the closure interval ─────────────────────────────────────────────────────
/**
 * The full closure that `dateYmd` belongs to, as real instants.
 *
 * ⛔ Consecutive closed days MERGE. Rosh Hashanah on Shabbos is one closure from
 * Friday's candle lighting to Sunday's nightfall, not three. Getting this wrong
 * reopens the phone at midnight in the middle of yom tov.
 */
export function closureAround(
  dateYmd: string, s: JewishCalendarSettings,
): { startsAt: Date; endsAt: Date; days: string[]; label: string } | null {
  if (!isClosedDay(dateYmd, s)) return null;
  let first = dateYmd, last = dateYmd;
  // Bounded walk — a closure is at most Rosh Hashanah + Shabbos, but cap it so a
  // pathological setting can never spin.
  for (let i = 0; i < 6 && isClosedDay(shiftYmd(first, -1), s); i++) first = shiftYmd(first, -1);
  for (let i = 0; i < 6 && isClosedDay(shiftYmd(last, 1), s); i++) last = shiftYmd(last, 1);

  const dayBefore = shiftYmd(first, -1);
  const startsAt = candleLighting(dayBefore, s.latitude, s.longitude, s.candleLightingMinutes);
  const endsAtRaw = nightfall(last, s.latitude, s.longitude, s.nightfallShita);
  if (!startsAt || !endsAtRaw) return null;
  const endsAt = new Date(endsAtRaw.getTime() + Math.max(0, s.reopenMinutesAfterNightfall) * 60_000);

  const days: string[] = [];
  for (let d = first; d <= last; d = shiftYmd(d, 1)) days.push(d);
  // Name the closure after the first thing in it that has a name.
  const named = days.map((d) => treatmentForDay(d, s)).find((t) => t.kind !== "shabbos" && t.label);
  const label = named?.label || "Shabbos";
  return { startsAt, endsAt, days, label };
}

// ── music mourning ───────────────────────────────────────────────────────────
const inAnyRange = (dateYmd: string, ranges: Array<[string, string]> | undefined): boolean =>
  Array.isArray(ranges) && ranges.some(([a, b]) => dateYmd >= a && dateYmd <= b);

/**
 * Should instrumental music be off today? Sefirah, the Three Weeks and the Nine
 * Days are periods when most of this customer base does not listen to music —
 * so the hold music switches to a cappella rather than going silent.
 *
 * ⛔ The Nine Days sit INSIDE the Three Weeks, so a customer who keeps only the
 * Nine Days still gets those nine days even with the Three Weeks switched off.
 */
export function musicMourningOn(
  dateYmd: string, s: JewishCalendarSettings,
): { noMusic: boolean; reason: string | null } {
  if (s.nineDaysNoMusic && inAnyRange(dateYmd, PERIODS.nineDays)) return { noMusic: true, reason: "the Nine Days" };
  if (s.threeWeeksNoMusic && inAnyRange(dateYmd, PERIODS.threeWeeks)) return { noMusic: true, reason: "the Three Weeks" };
  if (s.sefirah !== "none") {
    const key = s.sefirah === "early" ? "sefirahEarly" : s.sefirah === "late" ? "sefirahLate" : "sefirahWhole";
    if (inAnyRange(dateYmd, PERIODS[key])) return { noMusic: true, reason: "Sefirah" };
  }
  return { noMusic: false, reason: null };
}

// ── the answer ───────────────────────────────────────────────────────────────
/**
 * What the Jewish calendar says about this exact moment.
 *
 * ⛔ FAILS OPEN, DELIBERATELY. If the calendar is switched off, the date is past
 * the end of the generated table, or the coordinates are unusable, this returns
 * "not closed" and the tenant's ordinary weekly hours decide. A calendar that
 * cannot answer must never close a working business's phone.
 */
export function evaluateJewishCalendar(
  s: JewishCalendarSettings, at: Date = new Date(),
): JewishCalendarVerdict {
  const none: JewishCalendarVerdict = {
    closed: false, reason: "", holidayName: null, kind: null,
    closesAt: null, reopensAt: null, noMusic: false, noMusicReason: null,
  };
  if (!s.enabled) return none;
  if (!Number.isFinite(s.latitude) || !Number.isFinite(s.longitude)) return none;

  const today = localYmd(at, s.timezone);
  if (!isDateCovered(today)) return none;

  const music = musicMourningOn(today, s);
  const base = { ...none, noMusic: music.noMusic, noMusicReason: music.reason };

  // 1. Are we inside a closure? It may have started YESTERDAY evening, so both
  //    yesterday's and today's closures have to be considered.
  for (const day of [shiftYmd(today, -1), today, shiftYmd(today, 1)]) {
    const c = closureAround(day, s);
    if (c && at >= c.startsAt && at < c.endsAt) {
      const hol = holidayOn(day);
      return {
        ...base,
        closed: true,
        reason: c.label === "Shabbos" ? "Shabbos" : c.label,
        holidayName: c.label === "Shabbos" ? null : c.label,
        kind: c.label === "Shabbos" ? "shabbos" : (hol?.kind ?? "yomtov"),
        closesAt: null,
        reopensAt: c.endsAt,
      };
    }
  }

  // 2. Not closed. Is today an erev that closes early, or a reduced-hours day?
  const t = treatmentForDay(today, s);
  const tomorrow = shiftYmd(today, 1);
  const nextClosure = closureAround(tomorrow, s);
  if (nextClosure && s.earlyCloseMinutesBeforeCandles > 0 && nextClosure.days[0] === tomorrow) {
    const closesAt = new Date(nextClosure.startsAt.getTime() - s.earlyCloseMinutesBeforeCandles * 60_000);
    if (at < closesAt) {
      return {
        ...base,
        closed: false,
        reason: `Closing early at ${fmtTime(closesAt, s.timezone)} before ${nextClosure.label}`,
        holidayName: nextClosure.label === "Shabbos" ? null : nextClosure.label,
        kind: "erev",
        closesAt,
        reopensAt: nextClosure.endsAt,
      };
    }
    // Past the early-close time but before candle lighting: already shut.
    return {
      ...base,
      closed: true,
      reason: `Closed early before ${nextClosure.label}`,
      holidayName: nextClosure.label === "Shabbos" ? null : nextClosure.label,
      kind: "erev",
      closesAt,
      reopensAt: nextClosure.endsAt,
    };
  }

  if (t.treatment === "early") {
    return { ...base, closed: false, reason: `Reduced hours — ${t.label}`, holidayName: t.label, kind: t.kind as HolidayKind, closesAt: null, reopensAt: null };
  }
  return { ...base, holidayName: t.label || null, kind: t.kind };
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
function fmtTime(d: Date, timezone: string): string {
  let f = timeFormatters.get(timezone);
  if (!f) {
    try { f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }); }
    catch { f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" }); }
    timeFormatters.set(timezone, f);
  }
  return f.format(d).replace(/\s/, "").toLowerCase();
}

/** Candle lighting / nightfall for a date, for the calendar screen. */
export function dayTimes(dateYmd: string, s: JewishCalendarSettings): { candles: Date | null; nightfall: Date | null; sunset: Date | null } {
  return {
    candles: candleLighting(dateYmd, s.latitude, s.longitude, s.candleLightingMinutes),
    nightfall: nightfall(dateYmd, s.latitude, s.longitude, s.nightfallShita),
    sunset: sunset(dateYmd, s.latitude, s.longitude),
  };
}
