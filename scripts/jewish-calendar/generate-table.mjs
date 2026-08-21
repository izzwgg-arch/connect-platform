/**
 * Generates packages/shared/src/jewishCalendar/holidayTable.json.
 *
 * ⛔ THIS IS AN OFFLINE TOOL. It is the ONLY place @hebcal/core is used, and it
 * is deliberately NOT a dependency of any app:
 *
 *   • @hebcal/core v6 is ESM-only; apps/api and apps/worker are CommonJS with
 *     classic Node resolution. `require()` throws ERR_PACKAGE_PATH_NOT_EXPORTED
 *     at RUNTIME — a container that will not boot (the `undici` class).
 *   • @hebcal/core and @hebcal/hdate are GPL-2.0. Shipping their OUTPUT (dates,
 *     which are facts) carries no licence obligation; shipping their CODE in the
 *     portal or mobile bundle would.
 *
 * So we run the calculation once, here, and check in the answer. The Hebrew
 * calendar is fixed arithmetic, so the table is correct for its whole range.
 *
 * Run:  node scripts/jewish-calendar/generate-table.mjs
 * (needs a throwaway `npm i @hebcal/core` — never add it to a workspace)
 */
import { HebrewCalendar, HDate, months, flags } from "@hebcal/core";
import fs from "node:fs";
import path from "node:path";

const FROM_YEAR = 2026;
const TO_YEAR = 2081;           // 55 years
const OUT = path.join(process.cwd(), "packages/shared/src/jewishCalendar/holidayTable.json");

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ── 1. day table ──────────────────────────────────────────────────────────────
// Diaspora (il:false) — 2nd day yom tov, 8-day Pesach, Simchas Torah its own day.
const evs = HebrewCalendar.calendar({
  start: new Date(FROM_YEAR, 0, 1), end: new Date(TO_YEAR, 11, 31),
  il: false, noRoshChodesh: true, noModern: true, noMinorFast: false,
  sedrot: false, omer: false,
});

const days = {};
for (const e of evs) {
  const f = e.getFlags();
  // ⛔ MINOR_HOLIDAY and CHANUKAH_CANDLES matter here even though they are not
  // days anyone is halachically shut. Plenty of these businesses DO close for
  // Purim, and a customer cannot override a day the table never mentions — the
  // first cut of this generator dropped them and Purim silently became
  // un-closable.
  const kind =
    (f & flags.CHAG) ? "yomtov" :
    (f & flags.CHOL_HAMOED) ? "cholhamoed" :
    (f & flags.MAJOR_FAST) ? "majorfast" :
    (f & flags.MINOR_FAST) ? "minorfast" :
    (f & flags.EREV) ? "erev" :
    (f & flags.MINOR_HOLIDAY) ? "minor" :
    (f & flags.CHANUKAH_CANDLES) ? "minor" : null;
  if (!kind) continue;
  const key = iso(e.getDate().greg());
  const base = e.basename();
  // yomtov wins over erev when a day carries both (erev of day 2 etc.)
  const rank = { yomtov: 6, majorfast: 5, cholhamoed: 4, minorfast: 3, minor: 2, erev: 1 };
  const prev = days[key];
  if (!prev || rank[kind] > rank[prev[1]]) {
    days[key] = [base, kind, (f & flags.YOM_TOV_ENDS) ? 1 : 0];
  } else if (prev && prev[0] === base && (f & flags.YOM_TOV_ENDS)) {
    prev[2] = 1;
  }
}

// ── 2. music-mourning periods, per Hebrew year ────────────────────────────────
// Sefirah minhagim differ, so all three windows are generated and the customer
// picks. Three Weeks / Nine Days are the same for everyone.
const range = (y, m1, d1, m2, d2) => [iso(new HDate(d1, m1, y).greg()), iso(new HDate(d2, m2, y).greg())];
const periods = { sefirahEarly: [], sefirahLate: [], sefirahWhole: [], threeWeeks: [], nineDays: [] };
const hFrom = new HDate(new Date(FROM_YEAR, 0, 1)).getFullYear();
const hTo = new HDate(new Date(TO_YEAR, 11, 31)).getFullYear();
for (let y = hFrom; y <= hTo; y++) {
  // 16 Nissan → 17 Iyyar (music returns on Lag BaOmer, 18 Iyyar)
  periods.sefirahEarly.push(range(y, months.NISAN, 16, months.IYYAR, 17));
  // 1 Iyyar → 3 Sivan
  periods.sefirahLate.push(range(y, months.IYYAR, 1, months.SIVAN, 3));
  // 16 Nissan → 5 Sivan (erev Shavuos)
  periods.sefirahWhole.push(range(y, months.NISAN, 16, months.SIVAN, 5));
  // 17 Tammuz → 9 Av
  periods.threeWeeks.push(range(y, months.TAMUZ, 17, months.AV, 9));
  // 1 Av → 9 Av
  periods.nineDays.push(range(y, months.AV, 1, months.AV, 9));
}

const out = {
  version: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  engine: "@hebcal/core (offline) — diaspora, il=false",
  note: "Generated data, not code. Regenerate with scripts/jewish-calendar/generate-table.mjs.",
  gregorianRange: [`${FROM_YEAR}-01-01`, `${TO_YEAR}-12-31`],
  hebrewYearRange: [hFrom, hTo],
  dayFormat: "YYYY-MM-DD -> [holidayName, kind, yomTovEndsTonight]",
  kinds: ["yomtov", "cholhamoed", "minorfast", "majorfast", "minor", "erev"],
  days,
  periods,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`wrote ${OUT}`);
console.log(`  ${Object.keys(days).length} dated rows, ${periods.threeWeeks.length} Hebrew years, ${kb} KB`);
