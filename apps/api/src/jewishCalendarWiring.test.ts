import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toJewishCalendarSettings, loadJewishCalendar } from "./jewishCalendarSettings";
import { computeCurrentMode } from "./ivrModeSelection";
import { DEFAULT_JEWISH_CALENDAR } from "@connect/shared";

/** ⛔ CRLF-normalised: this checkout is CRLF under core.autocrlf and a literal
 *  \n pattern matches nothing, which reads as "the code isn't there". */
const src = (rel: string) =>
  readFileSync(join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
/** Executable lines only — a doc comment quoting the old shape is not the code. */
const code = (rel: string) =>
  src(rel).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// ── the mapper ───────────────────────────────────────────────────────────────
test("no row means a calendar that is switched off", () => {
  const s = toJewishCalendarSettings(null, "America/New_York");
  assert.equal(s.enabled, false);
  assert.equal(s.timezone, "America/New_York");
});

test("the timezone comes from the schedule, never the calendar row", () => {
  const s = toJewishCalendarSettings({ enabled: true }, "America/Chicago");
  assert.equal(s.timezone, "America/Chicago");
});

test("a junk nightfall falls back to Satmar, not to the earliest opinion", () => {
  // ⛔ The failure direction matters: falling back to 42 minutes would reopen a
  // phone half an hour before the customer holds Shabbos is out.
  const s = toJewishCalendarSettings({ enabled: true, nightfallShita: "nonsense" }, "UTC");
  assert.equal(s.nightfallShita, "satmar");
  assert.equal(s.nightfallShita, DEFAULT_JEWISH_CALENDAR.nightfallShita);
});

test("junk in any enum falls back rather than throwing", () => {
  const s = toJewishCalendarSettings(
    { enabled: true, cholHamoed: "sometimes", fastDays: 7 as any, sefirah: "" }, "UTC");
  assert.equal(s.cholHamoed, "open");
  assert.equal(s.fastDays, "open");
  assert.equal(s.sefirah, DEFAULT_JEWISH_CALENDAR.sefirah);
});

test("holiday overrides are filtered to real treatments", () => {
  const s = toJewishCalendarSettings(
    { enabled: true, holidayOverrides: { Purim: "closed", Pesach: "nonsense", Sukkot: "early" } }, "UTC");
  assert.deepEqual(s.holidayOverrides, { Purim: "closed", Sukkot: "early" });
});

test("a non-object holidayOverrides does not throw", () => {
  for (const bad of ["x", 5, [], null, undefined]) {
    const s = toJewishCalendarSettings({ enabled: true, holidayOverrides: bad as any }, "UTC");
    assert.deepEqual(s.holidayOverrides, {});
  }
});

test("negative minute settings are clamped, not passed through", () => {
  const s = toJewishCalendarSettings(
    { enabled: true, earlyCloseMinutesBeforeCandles: -30, reopenMinutesAfterNightfall: -5 }, "UTC");
  assert.equal(s.earlyCloseMinutesBeforeCandles, 0);
  assert.equal(s.reopenMinutesAfterNightfall, 0);
});

test("a read failure yields a switched-off calendar, never a thrown request", async () => {
  const boom = { tenantJewishCalendar: { findUnique: async () => { throw new Error("db down"); } } };
  const s = await loadJewishCalendar(boom, "t1", "UTC");
  assert.equal(s.enabled, false);
});

test("a database with no such table yields a switched-off calendar", async () => {
  const s = await loadJewishCalendar({}, "t1", "UTC");
  assert.equal(s.enabled, false);
});

// ── computeCurrentMode ───────────────────────────────────────────────────────
const schedule = {
  timezone: "America/New_York",
  businessHoursRules: [{ day: 5, open: "09:00", close: "23:00" }], // Friday, deliberately late
  holidayDates: [] as string[],
};

test("without a calendar, nothing changes at all", () => {
  // Friday 6pm ET — inside the weekly hours.
  const at = new Date("2026-09-11T22:00:00Z");
  assert.equal(computeCurrentMode(schedule, null, at), "business");
  assert.equal(computeCurrentMode(schedule, null, at, null), "business");
  assert.equal(
    computeCurrentMode(schedule, null, at, { ...DEFAULT_JEWISH_CALENDAR, enabled: false }), "business");
});

test("with the calendar on, Friday evening is holiday even though the hours say open", () => {
  // This is the whole point: the weekly rule says open until 11pm, and yom tov
  // began at candle lighting. A date list could not express it.
  const at = new Date("2026-09-11T23:30:00Z"); // 7:30pm ET, after candles
  const jewish = { ...DEFAULT_JEWISH_CALENDAR, enabled: true, timezone: "America/New_York" };
  assert.equal(computeCurrentMode(schedule, null, at, jewish), "holiday");
});

test("a manual override still beats the calendar", () => {
  const at = new Date("2026-09-11T23:30:00Z");
  const jewish = { ...DEFAULT_JEWISH_CALENDAR, enabled: true, timezone: "America/New_York" };
  assert.equal(
    computeCurrentMode(schedule, { isActive: true, expiresAt: null }, at, jewish), "override");
});

test("the hand-typed holiday list still works, untouched", () => {
  const withDates = { ...schedule, holidayDates: ["2026-12-25"] };
  assert.equal(computeCurrentMode(withDates, null, new Date("2026-12-25T15:00:00Z")), "holiday");
});

test("a calendar that throws leaves the ordinary hours deciding", () => {
  const at = new Date("2026-09-11T22:00:00Z");
  // Coordinates that cannot produce a sunset must not take the phone down.
  const jewish = { ...DEFAULT_JEWISH_CALENDAR, enabled: true, latitude: NaN, longitude: NaN };
  assert.equal(computeCurrentMode(schedule, null, at, jewish), "business");
});

// ── the call sites ───────────────────────────────────────────────────────────
// ⛔ These read server.ts's SOURCE on purpose. Every defect of this shape in this
// repo has been a CALLER that was never updated — the two IVR publish paths, the
// two SMS ingest paths, the two invite paths. A unit test of computeCurrentMode
// passes straight through a call site that forgets to pass the calendar.
test("EVERY computeCurrentMode call site passes the Jewish calendar", () => {
  const s = code("server.ts");
  // ⛔ NOT /\([^)]*\)/ — that stops at the ")" inside "new Date()" and reports
  // a truncated call, which reads as a missing argument. Take the whole line.
  const calls = s.split(String.fromCharCode(10)).filter((l) => l.includes("computeCurrentMode("));
  assert.ok(calls.length >= 5, `expected at least 5 call sites, found ${calls.length}`);
  for (const c of calls) {
    assert.match(c, /jewish/i,
      `a computeCurrentMode call site does not pass the calendar: ${c.trim()}`);
  }
});

test("the 60-second mode sweep is one of them", () => {
  // The sweep is what actually flips a live menu at a boundary. If it alone were
  // missed, every screen would look right and no caller would ever hear it.
  const s = code("server.ts");
  assert.match(s, /jewishSweep/, "the mode-boundary sweep must load the calendar");
});

test("the per-number didmap pointer is one of them", () => {
  assert.match(code("server.ts"), /jewishDid/, "the didmap resolver must load the calendar");
});

test("the calendar is loaded through the one helper, not inline", () => {
  const s = code("server.ts");
  assert.match(s, /from "\.\/jewishCalendarSettings"/);
  // Nothing should be reading the row and hand-rolling the mapping.
  const inline = s.match(/tenantJewishCalendar\.findUnique/g) ?? [];
  assert.ok(inline.length <= 4,
    `${inline.length} inline reads of tenantJewishCalendar — routes may read it, resolvers must use loadJewishCalendar`);
});

test("computeCurrentMode checks the calendar BEFORE the hand-typed list", () => {
  // Both answer "holiday", so order is not behavioural today — but the calendar
  // is the precise answer and must stay the one that wins.
  const s = code("ivrModeSelection.ts");
  const jewishAt = s.indexOf("evaluateJewishCalendar");
  const listAt = s.indexOf("holidays.includes");
  assert.ok(jewishAt > 0 && listAt > 0, "both paths must exist");
  assert.ok(jewishAt < listAt, "the Jewish calendar must be consulted first");
});

test("the Jewish-calendar branch is wrapped so a fault cannot decide routing", () => {
  const s = code("ivrModeSelection.ts");
  // ⛔ indexOf finds the IMPORT first. Look for the invocation.
  const at = s.indexOf("evaluateJewishCalendar(");
  assert.ok(at > 0, "the call must exist");
  const before = s.slice(Math.max(0, at - 400), at);
  const after = s.slice(at, at + 400);
  assert.match(before, /try\s*\{/, "a try must open before the call");
  assert.match(after, /catch/, "a catch must follow it");
});
