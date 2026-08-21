import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ⛔ Izzy opened the built screen and said: "I don't see anywhere where I can set
 * schedules per holiday, and I don't see a calendar." Both were there and both
 * were hidden — the per-holiday list behind a preset radio a fresh calendar never
 * matches, and the calendar behind a plain button in the footer next to Save.
 *
 * A feature that has to be discovered is not built. These guards read the
 * component's SOURCE, because the bug was not in any function — it was in a
 * render condition and a piece of layout, which no unit test can see.
 */
const src = readFileSync(
  join(__dirname, "..", "app", "(platform)", "pbx", "ivr-studio", "JewishCalendar.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");
const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("the per-holiday list is not gated behind anything", () => {
  assert.ok(code.includes("<HolidayList"), "the list must be rendered");
  assert.doesNotMatch(code, /showHolidays/,
    "the list must not be hidden behind a toggle — that is what made it invisible");
  assert.doesNotMatch(code, /preset === "custom" &&\s*\(?\s*<HolidayList/,
    "and it must not be gated on a preset either");
});

test("the calendar button is in the header, not buried in the footer", () => {
  const headerStart = code.indexOf('className="jc-headright"');
  const bodyStart = code.indexOf('className="card-b"');
  const btn = code.indexOf("See the calendar");
  assert.ok(headerStart > 0 && bodyStart > headerStart, "header precedes the body");
  assert.ok(btn > headerStart && btn < bodyStart,
    "the calendar button must sit in the card header where it can be seen");
});

test("the calendar button reads as a primary action", () => {
  // ⛔ The button spans two lines, so look at a WINDOW — not the single line
  // the text sits on, which carries no className at all.
  const at = code.indexOf("See the calendar");
  const win = code.slice(Math.max(0, at - 300), at);
  assert.match(win, /btn primary/, `it must not be a plain secondary button: ${win.slice(-160)}`);
});

test("the footer no longer competes with Save", () => {
  const foot = code.slice(code.indexOf('className="foot"'));
  assert.doesNotMatch(foot.slice(0, 600), /See the calendar/,
    "the calendar button must not be next to Save");
});

test("the per-holiday section says what it is", () => {
  assert.match(code, /A schedule for each holiday/,
    "the heading must name the thing Izzy went looking for");
});
