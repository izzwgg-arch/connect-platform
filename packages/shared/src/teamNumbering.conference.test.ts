import { test } from "node:test";
import assert from "node:assert/strict";

import { candidateConferenceNumbers, nextConferenceNumber, type UsedNumbers } from "./teamNumbering";

/**
 * Conference rooms get the 700-series (ring groups 8xx, queues 9xx), widening
 * the same way. The trap the team series already recorded holds here doubled:
 * "free" must mean free across EVERYTHING in the dial plan, and conference
 * rooms live in their own table (ombu_conferences) that UsedNumbers cannot
 * see — so the existing-conference list is a separate, mandatory input.
 */

const used = (over: Partial<UsedNumbers> = {}): UsedNumbers => ({
  extensions: [],
  ringGroups: [],
  queues: [],
  ...over,
});

test("the first room lands on 700", () => {
  assert.equal(nextConferenceNumber(used()), "700");
});

test("the series is 700–709 then 7000–7099 — widening only when a band is full", () => {
  const first12 = [...candidateConferenceNumbers()].slice(0, 12);
  assert.deepEqual(first12, ["700", "701", "702", "703", "704", "705", "706", "707", "708", "709", "7000", "7001"]);
});

test("a number taken by an EXTENSION is never handed out — the cross-series rule", () => {
  assert.equal(nextConferenceNumber(used({ extensions: ["700"] })), "701");
});

test("⛔ existing conference rooms block their numbers — they are invisible to UsedNumbers", () => {
  // Without the second argument this returns "700" while room 700 already
  // answers a meeting: the exact silent collision the parameter exists for.
  assert.equal(nextConferenceNumber(used(), ["700", "701"]), "702");
});

test("queues at 750 (the Gesheft shape) do not collide with the 70x band", () => {
  assert.equal(nextConferenceNumber(used({ queues: ["750", "751", "752"] })), "700");
});

test("a full 70x band widens to 7000", () => {
  const band = Array.from({ length: 10 }, (_, i) => `70${i}`);
  assert.equal(nextConferenceNumber(used(), band), "7000");
});

test("exhaustion returns null rather than reaching outside the series", () => {
  const all = [...candidateConferenceNumbers(3)];
  assert.equal(nextConferenceNumber(used(), all, 3), null);
});
