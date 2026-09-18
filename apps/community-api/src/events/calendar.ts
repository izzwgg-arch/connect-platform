/**
 * Calendar-aware notes for events. Nothing here is exact halachic timing —
 * it's a "roughly right" heads-up so a host doesn't accidentally schedule a
 * networking event into candle-lighting. Coordinates are fixed to New York
 * (lat 40.7, lng -74.0); every tenant using this module is Tri-State-area.
 */

const NY_LAT = 40.7;
const NY_LNG = -74.0;
const CANDLE_LIGHTING_MINUTES_BEFORE_SUNSET = 18;
/** Havdalah/nightfall approximation used to close the Shabbos window. */
const NIGHTFALL_MINUTES_AFTER_SUNSET = 42;

function toRad(d: number) {
  return (d * Math.PI) / 180;
}
function toDeg(r: number) {
  return (r * 180) / Math.PI;
}

function dayOfYearUTC(y: number, m: number, d: number): number {
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
}

/**
 * Classic "Sunrise/Sunset Algorithm" (Almanac for Computers, 1990), sunset case.
 * Given a calendar date (Y/M/D, as observed at `lat`/`lng`), returns the UTC
 * instant of that day's sunset. Deliberately approximate — no refraction
 * fine-tuning beyond the standard -0.833° horizon offset.
 */
export function sunsetUTC(year: number, month: number, day: number, lat = NY_LAT, lng = NY_LNG): Date {
  const zenith = 90.833;
  const lngHour = lng / 15;
  const n = dayOfYearUTC(year, month, day);
  const t = n + (18 - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  let L = M + 1.916 * Math.sin(toRad(M)) + 0.02 * Math.sin(toRad(2 * M)) + 282.634;
  L = ((L % 360) + 360) % 360;
  let RA = toDeg(Math.atan(0.91764 * Math.tan(toRad(L))));
  RA = ((RA % 360) + 360) % 360;
  const Lquadrant = Math.floor(L / 90) * 90;
  const RAquadrant = Math.floor(RA / 90) * 90;
  RA = RA + (Lquadrant - RAquadrant);
  RA = RA / 15;
  const sinDec = 0.39782 * Math.sin(toRad(L));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(toRad(zenith)) - sinDec * Math.sin(toRad(lat))) / (cosDec * Math.cos(toRad(lat)));
  // Polar day/night at this latitude never happens for NY, but guard anyway.
  const clamped = Math.min(1, Math.max(-1, cosH));
  let H = toDeg(Math.acos(clamped));
  H = H / 15;
  const T = H + RA - 0.06571 * t - 6.622;
  let UT = T - lngHour;
  UT = ((UT % 24) + 24) % 24;
  const hours = Math.floor(UT);
  const minutes = Math.floor((UT - hours) * 60);
  const seconds = Math.round((((UT - hours) * 60) - minutes) * 60);
  return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
}

export type NyDateParts = { year: number; month: number; day: number; weekday: number };

/** The New York calendar date (and 0=Sun..6=Sat weekday) an instant falls on. */
export function nyDateParts(instant: Date): NyDateParts {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  const parts = fmt.formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), weekday: weekdayMap[get("weekday")] ?? 0 };
}

function addDays(p: NyDateParts, delta: number): NyDateParts {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + delta, 12));
  return nyDateParts(d);
}

/**
 * Plain-English Shabbos note for an event window, or null when the event
 * doesn't come near Shabbos. `tz` is accepted for the signature's sake but
 * the solar calculation is fixed to the New York coordinates (brief §events).
 */
export function shabbosNote(startsAt: Date, endsAt: Date, _tz = "America/New_York"): string | null {
  const startParts = nyDateParts(startsAt);
  const endParts = nyDateParts(endsAt);

  // Find the Friday on/adjacent to this window (events rarely span more than a couple of days).
  const candidates: NyDateParts[] = [startParts];
  if (endParts.year !== startParts.year || endParts.month !== startParts.month || endParts.day !== startParts.day) candidates.push(endParts);

  for (const day of candidates) {
    if (day.weekday === 5) {
      // Friday: Shabbos window is [candle-lighting that evening, nightfall the next evening].
      const sunsetFri = sunsetUTC(day.year, day.month, day.day);
      const candleLighting = new Date(sunsetFri.getTime() - CANDLE_LIGHTING_MINUTES_BEFORE_SUNSET * 60_000);
      const sat = addDays(day, 1);
      const sunsetSat = sunsetUTC(sat.year, sat.month, sat.day);
      const shabbosEnds = new Date(sunsetSat.getTime() + NIGHTFALL_MINUTES_AFTER_SUNSET * 60_000);
      const overlaps = startsAt.getTime() < shabbosEnds.getTime() && endsAt.getTime() > candleLighting.getTime();
      if (overlaps) return "Overlaps Shabbos — check the time";
      if (endsAt.getTime() <= candleLighting.getTime()) return "Ends well before Shabbos";
    }
    if (day.weekday === 6) {
      // Saturday: Shabbos window is [candle-lighting the evening before, nightfall that evening].
      const fri = addDays(day, -1);
      const sunsetFri = sunsetUTC(fri.year, fri.month, fri.day);
      const candleLighting = new Date(sunsetFri.getTime() - CANDLE_LIGHTING_MINUTES_BEFORE_SUNSET * 60_000);
      const sunsetSat = sunsetUTC(day.year, day.month, day.day);
      const shabbosEnds = new Date(sunsetSat.getTime() + NIGHTFALL_MINUTES_AFTER_SUNSET * 60_000);
      const overlaps = startsAt.getTime() < shabbosEnds.getTime() && endsAt.getTime() > candleLighting.getTime();
      if (overlaps) return "Overlaps Shabbos — check the time";
    }
  }
  return null;
}

/**
 * Hardcoded Yom Tov dates for 2026–2027 (a real deployment would compute
 * these from the Hebrew calendar; documented here as a fixed table on
 * purpose — see CONVENTIONS discussion in the events build report).
 */
const YOM_TOV_DATES: Array<{ name: string; dates: string[] }> = [
  { name: "Rosh Hashana", dates: ["2026-09-12", "2026-09-13"] },
  { name: "Yom Kippur", dates: ["2026-09-21"] },
  { name: "Sukkos", dates: ["2026-09-26", "2026-09-27"] },
  { name: "Shemini Atzeres/Simchas Torah", dates: ["2026-10-03", "2026-10-04"] },
  { name: "Pesach", dates: ["2027-04-22", "2027-04-23", "2027-04-28", "2027-04-29"] },
  { name: "Shavuos", dates: ["2027-06-11", "2027-06-12"] },
  { name: "Rosh Hashana", dates: ["2027-10-02", "2027-10-03"] },
  { name: "Yom Kippur", dates: ["2027-10-11"] },
  { name: "Sukkos", dates: ["2027-10-16", "2027-10-17", "2027-10-23", "2027-10-24"] },
];

/** Returns the Yom Tov name if the event's (New York local) start date falls on one, else null. */
export function holidayNotes(startsAt: Date): string | null {
  const p = nyDateParts(startsAt);
  const iso = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const hit = YOM_TOV_DATES.find((h) => h.dates.includes(iso));
  return hit?.name ?? null;
}

/** Combines the holiday and Shabbos checks into the one line the event page shows. Holiday takes precedence. */
export function calendarNote(startsAt: Date, endsAt: Date): string | null {
  const holiday = holidayNotes(startsAt);
  if (holiday) return `Falls on ${holiday}`;
  return shabbosNote(startsAt, endsAt);
}
