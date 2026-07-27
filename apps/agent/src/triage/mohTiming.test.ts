/**
 * parseMohTiming — deterministic clock/date extraction for MOH requests.
 * Fixed now = 2026-07-26T20:00:00Z (Sunday, 4:00 PM EDT). tz America/New_York.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMohTiming, zonedTimeToUtc } from "./mohTiming";

const TZ = "America/New_York";
const NOW = new Date("2026-07-26T20:00:00Z"); // Sun 16:00 EDT

test("tz helper: 5pm EDT == 21:00Z; 5pm EST (january) == 22:00Z", () => {
  assert.equal(zonedTimeToUtc(TZ, 2026, 7, 26, 17, 0).toISOString(), "2026-07-26T21:00:00.000Z");
  assert.equal(zonedTimeToUtc(TZ, 2026, 1, 15, 17, 0).toISOString(), "2026-01-15T22:00:00.000Z");
});

test("duration: minutes and hours", () => {
  assert.deepEqual(parseMohTiming("change it back in 15 minutes", TZ, NOW), { kind: "duration", minutes: 15, label: "15 minutes" });
  const d2 = parseMohTiming("play jazz for 2 hours please", TZ, NOW);
  assert.equal(d2.kind, "duration");
  assert.equal((d2 as any).minutes, 120);
  assert.equal((parseMohTiming("switch it for an hour", TZ, NOW) as any).minutes, 60);
  assert.equal((parseMohTiming("for half an hour", TZ, NOW) as any).minutes, 30);
  // spelled-out counts (live client phrasing 2026-07-27: "for twenty minutes")
  assert.equal((parseMohTiming("change it to main for twenty minutes", TZ, NOW) as any).minutes, 20);
  assert.equal((parseMohTiming("for twenty-five minutes", TZ, NOW) as any).minutes, 25);
  assert.equal((parseMohTiming("in forty five mins", TZ, NOW) as any).minutes, 45);
  assert.equal((parseMohTiming("for two hours", TZ, NOW) as any).minutes, 120);
  assert.equal((parseMohTiming("in the next 20 mins", TZ, NOW) as any).minutes, 20);
});

test("until: same-day future time", () => {
  const r = parseMohTiming("play classic until 5pm", TZ, NOW);
  assert.equal(r.kind, "until");
  assert.equal((r as any).endAt.toISOString(), "2026-07-26T21:00:00.000Z");
});

test("until: past time rolls to tomorrow", () => {
  const r = parseMohTiming("until 3pm", TZ, NOW); // 3pm EDT already passed (now 4pm)
  assert.equal(r.kind, "until");
  assert.equal((r as any).endAt.toISOString(), "2026-07-27T19:00:00.000Z");
});

test("until: weekday + time", () => {
  const r = parseMohTiming("holiday music until monday 9am", TZ, NOW);
  assert.equal(r.kind, "until");
  assert.equal((r as any).endAt.toISOString(), "2026-07-27T13:00:00.000Z"); // Mon 9am EDT
});

test("until: bare weekday defaults to 9am", () => {
  const r = parseMohTiming("until tuesday", TZ, NOW);
  assert.equal(r.kind, "until");
  assert.equal((r as any).endAt.toISOString(), "2026-07-28T13:00:00.000Z");
});

test("window: tomorrow from 3pm to 5pm", () => {
  const r = parseMohTiming("tomorrow from 3pm to 5pm play jazz", TZ, NOW);
  assert.equal(r.kind, "window");
  assert.equal((r as any).startAt.toISOString(), "2026-07-27T19:00:00.000Z");
  assert.equal((r as any).endAt.toISOString(), "2026-07-27T21:00:00.000Z");
});

test("window: explicit date, start inherits pm from the end time", () => {
  const r = parseMohTiming("on july 30 from 3 to 5pm", TZ, NOW);
  assert.equal(r.kind, "window");
  assert.equal((r as any).startAt.toISOString(), "2026-07-30T19:00:00.000Z");
  assert.equal((r as any).endAt.toISOString(), "2026-07-30T21:00:00.000Z");
});

test("window: numeric date with between/and", () => {
  const r = parseMohTiming("on 7/30 between 9am and 11am", TZ, NOW);
  assert.equal(r.kind, "window");
  assert.equal((r as any).startAt.toISOString(), "2026-07-30T13:00:00.000Z");
  assert.equal((r as any).endAt.toISOString(), "2026-07-30T15:00:00.000Z");
});

test("window: day phrase separated from the range by words", () => {
  const r = parseMohTiming("on july 30 play the jazz music from 3pm to 5pm", TZ, NOW);
  assert.equal(r.kind, "window");
  assert.equal((r as any).startAt.toISOString(), "2026-07-30T19:00:00.000Z");
});

test("window: bare range = today, rolls to tomorrow when already past", () => {
  const r = parseMohTiming("from 2pm to 3pm", TZ, NOW); // both past (now 4pm EDT)
  assert.equal(r.kind, "window");
  assert.equal((r as any).startAt.toISOString(), "2026-07-27T18:00:00.000Z");
  assert.equal((r as any).endAt.toISOString(), "2026-07-27T19:00:00.000Z");
});

test("weekly: every friday from 3pm to 5pm", () => {
  const r = parseMohTiming("play jazz every friday from 3pm to 5pm", TZ, NOW);
  assert.deepEqual(r, { kind: "weekly", weekday: 5, startTime: "15:00", endTime: "17:00", label: "every Friday from 3 PM to 5 PM" });
});

test("no timing: plain switch request", () => {
  assert.deepEqual(parseMohTiming("change our hold music to Jazz", TZ, NOW), { kind: "none" });
  assert.deepEqual(parseMohTiming("set the hold music back to normal", TZ, NOW), { kind: "none" });
});

test("extension numbers are never mistaken for durations", () => {
  // "extension 102" has no in/for/until context — must stay none.
  assert.deepEqual(parseMohTiming("change extension 102 hold music to jazz", TZ, NOW), { kind: "none" });
});
