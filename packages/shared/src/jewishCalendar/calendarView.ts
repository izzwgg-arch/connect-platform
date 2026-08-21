/**
 * The two views the IVR Studio screens render: a month grid, and the list of
 * holidays for the year ahead.
 *
 * Both are built here rather than in the portal so the screen and the dialplan
 * can never disagree — what the calendar shows is produced by the same resolver
 * that decides what callers actually hear.
 */
import {
  evaluateJewishCalendar, treatmentForDay, holidayOn, musicMourningOn,
  closureAround, dayTimes, dayOfWeek, shiftYmd, isDateCovered,
  type JewishCalendarSettings, type DayTreatment, type HolidayKind,
} from "./jewishCalendar";
import { holidayDisplayName, isCommonHoliday, normaliseHolidayKey } from "./holidayNames";

export interface CalendarDay {
  date: string;                 // YYYY-MM-DD
  dayOfWeek: number;            // 0 = Sunday
  /** Holiday name as the table stores it — the key for overrides. */
  holidayKey: string | null;
  /** What it should READ as, in the requested language. */
  label: string | null;
  kind: HolidayKind | "shabbos" | null;
  treatment: DayTreatment;
  /** What the phone actually does, in plain English. */
  verdict: string;
  candleLighting: string | null; // ISO
  nightfall: string | null;      // ISO
  noMusic: boolean;
  noMusicReason: string | null;
  isToday: boolean;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * One month of days, each carrying what the phone will do and why.
 *
 * ⛔ The verdict is computed at MIDDAY, not midnight. A day's character belongs
 * to its daytime: midnight on a Saturday is inside Friday night's closure and
 * would make every Shabbos read as "closed" for reasons attributed to Friday.
 */
export function buildMonthView(
  year: number, month1to12: number, s: JewishCalendarSettings,
  opts: { lang?: "en" | "yi"; today?: string } = {},
): CalendarDay[] {
  const lang = opts.lang ?? "en";
  const days: CalendarDay[] = [];
  const last = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  for (let d = 1; d <= last; d++) {
    const date = `${year}-${String(month1to12).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const hol = holidayOn(date);
    const t = treatmentForDay(date, s);
    const times = dayTimes(date, s);
    const music = musicMourningOn(date, s);
    // Midday local — see the note above.
    const noonUtc = new Date(`${date}T12:00:00Z`);
    const v = evaluateJewishCalendar(s, noonUtc);

    let verdict: string;
    if (v.closed) verdict = `Closed — ${v.reason}`;
    else if (t.treatment === "early") verdict = `Reduced hours — ${t.label}`;
    else if (v.kind === "erev" && v.closesAt) verdict = v.reason;
    else verdict = "Normal hours";

    const key = hol ? hol.name : null;
    days.push({
      date,
      dayOfWeek: dayOfWeek(date),
      holidayKey: key,
      label: key ? holidayDisplayName(key, lang) : (t.kind === "shabbos" ? holidayDisplayName("Shabbat", lang) : null),
      kind: t.kind,
      treatment: t.treatment,
      verdict,
      candleLighting: iso(times.candles),
      nightfall: iso(times.nightfall),
      noMusic: music.noMusic,
      noMusicReason: music.reason,
      isToday: opts.today === date,
    });
  }
  return days;
}

export interface HolidaySpan {
  /** The table's name — the key a per-holiday override is stored under. */
  key: string;
  /** What it reads as. */
  label: string;
  kind: HolidayKind;
  firstDay: string;
  lastDay: string;
  dayCount: number;
  /** When the phone shuts and reopens, if this span closes it. */
  startsAt: string | null;
  endsAt: string | null;
  treatment: DayTreatment;
  /** True when the customer has set this holiday explicitly. */
  overridden: boolean;
  /** e.g. "2 days — falls on Shabbos this year" */
  note: string | null;
}

/**
 * Every holiday in the window ahead, one row per holiday, consecutive days
 * merged — the list Option B renders.
 *
 * ⛔ Merges by NAME as well as adjacency, so Sukkos I and II are one row while
 * Chol Hamoed Sukkos stays its own. A customer setting "Sukkos → closed" means
 * the yom tov days, not the whole nine.
 */
export function buildHolidaySpans(
  fromYmd: string, s: JewishCalendarSettings,
  opts: { months?: number; lang?: "en" | "yi"; commonOnly?: boolean } = {},
): HolidaySpan[] {
  const lang = opts.lang ?? "en";
  const months = opts.months ?? 12;
  const commonOnly = opts.commonOnly !== false;
  const [y, m, d] = fromYmd.split("-").map(Number);
  const endDate = new Date(Date.UTC(y, m - 1 + months, d));
  const endYmd = endDate.toISOString().slice(0, 10);

  const spans: HolidaySpan[] = [];
  let cur: { key: string; kind: HolidayKind; first: string; last: string } | null = null;

  const flush = () => {
    if (!cur) return;
    const t = treatmentForDay(cur.first, s);
    const closure = t.treatment === "closed" ? closureAround(cur.first, s) : null;
    const dayCount = Math.round(
      (Date.parse(cur.last + "T00:00:00Z") - Date.parse(cur.first + "T00:00:00Z")) / 86_400_000) + 1;
    const onShabbos = (() => {
      for (let x = cur!.first; x <= cur!.last; x = shiftYmd(x, 1)) if (dayOfWeek(x) === 6) return true;
      return false;
    })();
    const notes: string[] = [];
    if (dayCount > 1) notes.push(`${dayCount} days`);
    if (onShabbos && cur.kind === "yomtov") notes.push("falls on Shabbos this year");
    spans.push({
      key: cur.key,
      label: holidayDisplayName(cur.key, lang),
      kind: cur.kind,
      firstDay: cur.first,
      lastDay: cur.last,
      dayCount,
      startsAt: closure ? closure.startsAt.toISOString() : null,
      endsAt: closure ? closure.endsAt.toISOString() : null,
      treatment: t.treatment,
      overridden: Object.prototype.hasOwnProperty.call(
        s.holidayOverrides, cur.key) || Object.keys(s.holidayOverrides).some(
        (k) => normaliseHolidayKey(k) === normaliseHolidayKey(cur!.key)),
      note: notes.length ? notes.join(" — ") : null,
    });
    cur = null;
  };

  for (let date = fromYmd; date <= endYmd; date = shiftYmd(date, 1)) {
    if (!isDateCovered(date)) break;
    const hol = holidayOn(date);
    if (!hol || (commonOnly && !isCommonHoliday(hol.name))) { flush(); continue; }
    // Erev rows are not their own holiday — they are the run-up to the next one.
    if (hol.kind === "erev") { flush(); continue; }
    if (cur && cur.key === hol.name && cur.kind === hol.kind && shiftYmd(cur.last, 1) === date) {
      cur.last = date;
    } else {
      flush();
      cur = { key: hol.name, kind: hol.kind, first: date, last: date };
    }
  }
  flush();
  return spans;
}

/** The next moment the phone changes state, for the "what happens next" line. */
export function nextChange(
  s: JewishCalendarSettings, from: Date = new Date(),
): { at: Date; what: string } | null {
  const v = evaluateJewishCalendar(s, from);
  if (v.closed && v.reopensAt) return { at: v.reopensAt, what: `reopening after ${v.reason}` };
  if (v.closesAt && v.closesAt > from) return { at: v.closesAt, what: v.reason };
  return null;
}
