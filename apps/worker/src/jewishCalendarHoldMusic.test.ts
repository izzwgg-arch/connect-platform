import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateJewishCalendar, DEFAULT_JEWISH_CALENDAR, type JewishCalendarSettings } from "@connect/shared";

/**
 * The a cappella switch, from the worker's side.
 *
 * ⛔ These are SOURCE guards on main.ts as well as behaviour tests. The decision
 * itself lives in @connect/shared and is tested there; what can silently break
 * here is the WIRING — the reconcile cycle not loading the calendar, not passing
 * it, or the branch drifting below the schedule rules so a one-time "play the
 * Chanukah playlist" beats the Nine Days.
 */
const main = readFileSync(join(__dirname, "main.ts"), "utf8").replace(/\r\n/g, "\n");
/** Executable lines only — a comment explaining the rule is not the rule. */
const code = main.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const on = (o: Partial<JewishCalendarSettings> = {}): JewishCalendarSettings =>
  ({ ...DEFAULT_JEWISH_CALENDAR, enabled: true, timezone: "America/New_York", ...o });

// ── what the resolver tells the worker ───────────────────────────────────────
test("the Nine Days ask for a cappella", () => {
  const v = evaluateJewishCalendar(on(), new Date("2027-08-06T15:00:00Z"));
  assert.equal(v.noMusic, true);
  assert.equal(v.noMusicReason, "the Nine Days");
});

test("an ordinary Tuesday does not", () => {
  assert.equal(evaluateJewishCalendar(on(), new Date("2026-11-10T15:00:00Z")).noMusic, false);
});

test("music mourning is independent of the phone being open", () => {
  // Mid-week in the Three Weeks: taking calls, no instrumental music.
  const v = evaluateJewishCalendar(on(), new Date("2027-07-27T15:00:00Z"));
  assert.equal(v.closed, false);
  assert.equal(v.noMusic, true);
});

test("a customer who keeps no sefirah and no three weeks is never switched", () => {
  const s = on({ sefirah: "none", threeWeeksNoMusic: false, nineDaysNoMusic: false });
  for (const d of ["2027-05-10", "2027-07-27", "2027-08-06"]) {
    assert.equal(evaluateJewishCalendar(s, new Date(`${d}T15:00:00Z`)).noMusic, false, d);
  }
});

// ── the wiring ───────────────────────────────────────────────────────────────
test("the reconcile cycle loads the tenant's calendar", () => {
  assert.match(code, /tenantJewishCalendar/, "the MOH cycle must read the calendar row");
  assert.match(code, /jewishHold/, "and hold it for the resolver");
});

test("the calendar is passed into the hold-profile resolver", () => {
  const call = code.split("\n").find((l) => l.includes("workerComputeHoldProfile(") && !l.includes("function"));
  assert.ok(call, "the resolver must be called");
  assert.match(call!, /jewishHold/, `the call site must pass the calendar: ${call!.trim()}`);
});

test("a cappella is checked AFTER the manual override but BEFORE the schedule", () => {
  // ⛔ The order is the feature. Below the schedule rules, a one-time "play the
  // Chanukah playlist" would put instrumental music on the line during the Nine
  // Days — which is the exact thing this exists to prevent. Above the override,
  // a person choosing right now could not get their own music back.
  const fn = code.slice(code.indexOf("function workerComputeHoldProfile("));
  const override = fn.indexOf('mode: "override"');
  const acappella = fn.indexOf('mode: "acappella"');
  const oneTime = fn.indexOf('mode: "one_time"');
  const holiday = fn.indexOf('mode: "holiday"');
  assert.ok(override > 0 && acappella > 0 && oneTime > 0 && holiday > 0, "all four modes must exist");
  assert.ok(override < acappella, "the manual override must be checked first");
  assert.ok(acappella < oneTime, "a cappella must beat a one-time rule");
  assert.ok(acappella < holiday, "a cappella must beat the holiday rule");
});

test("with no a cappella profile chosen, nothing is switched", () => {
  // ⛔ Falling through to silence would be worse than the wrong music. The guard
  // is that the branch requires BOTH the calendar and a chosen profile.
  const fn = code.slice(code.indexOf("function workerComputeHoldProfile("));
  const at = fn.indexOf('mode: "acappella"');
  const before = fn.slice(Math.max(0, at - 700), at);
  assert.match(before, /acappellaProfileId/, "the branch must require a chosen profile");
  assert.match(before, /enabled/, "and require the calendar to be switched on");
});

test("a calendar fault cannot change what is already playing", () => {
  const fn = code.slice(code.indexOf("function workerComputeHoldProfile("));
  const at = fn.indexOf("evaluateJewishCalendar(");
  assert.ok(at > 0, "the resolver must be called");
  assert.match(fn.slice(Math.max(0, at - 300), at), /try\s*\{/, "wrapped in a try");
  assert.match(fn.slice(at, at + 400), /catch/, "with a catch");
});

test("the worker's row mapper keeps the same defaults as the api's", () => {
  // Two mappers exist because the worker cannot import from apps/api. If their
  // defaults drift, the hold music and the IVR menu disagree about the day.
  assert.match(code, /function workerJewishSettings/);
  assert.match(code, /DEFAULT_JEWISH_CALENDAR/, "it must build on the shared defaults");
  const fn = code.slice(code.indexOf("function workerJewishSettings("));
  assert.match(fn.slice(0, 900), /satmar/, "the nightfall fallback must stay Satmar");
});
