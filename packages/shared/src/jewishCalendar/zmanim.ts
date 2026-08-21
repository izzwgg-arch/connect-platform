/**
 * Sunset / nightfall for the Jewish calendar — NOAA solar position, hand-rolled.
 *
 * ⛔ WHY THIS IS NOT A LIBRARY. The obvious choices (@hebcal/noaa, kosher-zmanim)
 * are ESM-only and/or copyleft, and apps/api + apps/worker are CommonJS. An
 * ESM-only import does not fail at build time — it fails when the process loads
 * it, i.e. a container that will not boot. This repo has been taken down that
 * way once already (`undici`). Forty lines of standard astronomy avoids a
 * dependency, a licence question and a boot risk all at once.
 *
 * Accuracy is ~1 minute against published tables, which is far inside the
 * tolerance of "the phone reopens after Shabbos" — and the customer's own
 * minhag offset (42 / 50 / 72 minutes) dwarfs it either way.
 */

const DEG = Math.PI / 180;

/** Julian day for 00:00 UTC of a civil date. */
function julianDay(y: number, m: number, d: number): number {
  if (m <= 2) { y -= 1; m += 12; }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + b - 1524.5;
}

/**
 * UTC minutes past midnight of the given date at which the sun's centre reaches
 * `zenithDeg` below/above the horizon, going down (sunset) or up (sunrise).
 * Returns null on a polar day/night, where no such crossing exists.
 */
function solarEventUtcMinutes(
  date: { y: number; m: number; d: number },
  latitude: number,
  longitude: number,
  zenithDeg: number,
  rising: boolean,
): number | null {
  const jd = julianDay(date.y, date.m, date.d);
  // Iterate twice: the first pass gets the approximate time, the second refines
  // declination and the equation of time at that time rather than at midnight.
  let minutes = 12 * 60;
  for (let pass = 0; pass < 2; pass++) {
    const t = (jd + minutes / 1440 - 2451545) / 36525; // Julian centuries from J2000
    const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
    const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const centre =
      Math.sin(meanAnom * DEG) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
      Math.sin(2 * meanAnom * DEG) * (0.019993 - 0.000101 * t) +
      Math.sin(3 * meanAnom * DEG) * 0.000289;
    const trueLong = meanLong + centre;
    const omega = 125.04 - 1934.136 * t;
    const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG);
    const obliq =
      23 + (26 + ((21.448 - t * (46.815 + t * (0.00059 - t * 0.001813)))) / 60) / 60 +
      0.00256 * Math.cos(omega * DEG);
    const declin = Math.asin(Math.sin(obliq * DEG) * Math.sin(appLong * DEG)) / DEG;

    const varY = Math.tan((obliq / 2) * DEG) ** 2;
    const eqTime =
      4 * (varY * Math.sin(2 * meanLong * DEG)
        - 2 * eccent * Math.sin(meanAnom * DEG)
        + 4 * eccent * varY * Math.sin(meanAnom * DEG) * Math.cos(2 * meanLong * DEG)
        - 0.5 * varY * varY * Math.sin(4 * meanLong * DEG)
        - 1.25 * eccent * eccent * Math.sin(2 * meanAnom * DEG)) / DEG;

    const cosH =
      (Math.cos(zenithDeg * DEG) - Math.sin(latitude * DEG) * Math.sin(declin * DEG)) /
      (Math.cos(latitude * DEG) * Math.cos(declin * DEG));
    if (cosH > 1 || cosH < -1) return null; // sun never reaches that angle here today
    const hourAngle = (Math.acos(cosH) / DEG) * (rising ? 1 : -1);
    minutes = 720 - 4 * (longitude + hourAngle) - eqTime;
  }
  return minutes;
}

/** Sunset as a real instant. `null` where the sun does not set that day. */
export function sunset(dateYmd: string, latitude: number, longitude: number): Date | null {
  const [y, m, d] = dateYmd.split("-").map(Number);
  // 90.833° accounts for atmospheric refraction and the sun's apparent radius —
  // this is "sunset" as every luach means it.
  const mins = solarEventUtcMinutes({ y, m, d }, latitude, longitude, 90.833, false);
  if (mins == null) return null;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) + Math.round(mins * 60_000));
}

/** Sunrise as a real instant. `null` where the sun does not rise that day. */
export function sunrise(dateYmd: string, latitude: number, longitude: number): Date | null {
  const [y, m, d] = dateYmd.split("-").map(Number);
  const mins = solarEventUtcMinutes({ y, m, d }, latitude, longitude, 90.833, true);
  if (mins == null) return null;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) + Math.round(mins * 60_000));
}

/** The instant the sun's centre reaches `deg` below the horizon after sunset. */
export function degreesAfterSunset(
  dateYmd: string, latitude: number, longitude: number, deg: number,
): Date | null {
  const [y, m, d] = dateYmd.split("-").map(Number);
  const mins = solarEventUtcMinutes({ y, m, d }, latitude, longitude, 90 + deg, false);
  if (mins == null) return null;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) + Math.round(mins * 60_000));
}

/**
 * Whose nightfall. This is a HALACHIC choice, not an engineering one — the
 * product exposes it and never decides it.
 *
 *  satmar   72 minutes after sunset, fixed (Rabbeinu Tam). Satmar and Kiryas
 *           Joel keep this, and it is standard Chasidic practice.
 *  chabad   8.5° below the horizon — Chabad's published method.
 *  rmoshe   50 minutes after sunset. Common in much of the US.
 *  medium   42 minutes after sunset (three medium stars).
 *
 * ⛔ Default is `satmar`, and the reason is failure direction, not popularity:
 * set nightfall LATER than a customer holds and the phone stays closed a few
 * extra minutes on a Saturday night, which nobody notices. Set it EARLIER and
 * the phone tells callers the business is open while they are still keeping
 * Shabbos. Only one of those is survivable for this customer base.
 */
export type NightfallShita = "satmar" | "chabad" | "rmoshe" | "medium";

export const NIGHTFALL_SHITOS: ReadonlyArray<{ id: NightfallShita; label: string; detail: string }> = [
  { id: "satmar", label: "Satmar — 72 minutes", detail: "Rabbeinu Tam. Satmar, Kiryas Joel and most Chasidish communities." },
  { id: "chabad", label: "Chabad — 8.5°", detail: "Chabad's published method. Lands about 22 minutes before 72." },
  { id: "rmoshe", label: "50 minutes", detail: "Three small stars; common across much of the US." },
  { id: "medium", label: "42 minutes", detail: "Three medium stars; the earliest in common use." },
];

export const DEFAULT_NIGHTFALL_SHITA: NightfallShita = "satmar";
/** Minutes before sunset that candles are lit. 18 everywhere we serve. */
export const DEFAULT_CANDLE_LIGHTING_MINUTES = 18;

/** Candle lighting for a date — sunset minus the configured offset. */
export function candleLighting(
  dateYmd: string, latitude: number, longitude: number, minutesBefore = DEFAULT_CANDLE_LIGHTING_MINUTES,
): Date | null {
  const ss = sunset(dateYmd, latitude, longitude);
  return ss ? new Date(ss.getTime() - minutesBefore * 60_000) : null;
}

/** Nightfall for a date under the chosen opinion. */
export function nightfall(
  dateYmd: string, latitude: number, longitude: number, shita: NightfallShita = DEFAULT_NIGHTFALL_SHITA,
): Date | null {
  if (shita === "chabad") {
    const byDeg = degreesAfterSunset(dateYmd, latitude, longitude, 8.5);
    if (byDeg) return byDeg;
    // Far north in summer the sun never reaches 8.5° below — fall back to the
    // fixed offset rather than returning nothing, so the phone still reopens.
    const ss = sunset(dateYmd, latitude, longitude);
    return ss ? new Date(ss.getTime() + 72 * 60_000) : null;
  }
  const mins = shita === "satmar" ? 72 : shita === "rmoshe" ? 50 : 42;
  const ss = sunset(dateYmd, latitude, longitude);
  return ss ? new Date(ss.getTime() + mins * 60_000) : null;
}
