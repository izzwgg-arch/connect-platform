import test from "node:test";
import assert from "node:assert/strict";
import { resolveAriBridgedPollMs } from "./resolveAriBridgedPollMs";

test("resolveAriBridgedPollMs default 5000 clamps to 3000 minimum when not debug", () => {
  assert.equal(resolveAriBridgedPollMs({ pollMs: undefined, debug: false }), 5000);
  assert.equal(resolveAriBridgedPollMs({ pollMs: 1000, debug: false }), 3000);
  assert.equal(resolveAriBridgedPollMs({ pollMs: 2500, debug: false }), 3000);
});

test("resolveAriBridgedPollMs debug allows 1000ms", () => {
  assert.equal(resolveAriBridgedPollMs({ pollMs: 1000, debug: true }), 1000);
  assert.equal(resolveAriBridgedPollMs({ pollMs: 500, debug: true }), 1000);
});

test("resolveAriBridgedPollMs caps at 120s", () => {
  assert.equal(resolveAriBridgedPollMs({ pollMs: 999_000, debug: false }), 120_000);
});
