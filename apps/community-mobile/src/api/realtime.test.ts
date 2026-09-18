import assert from "node:assert/strict";
import { test } from "node:test";
import { backoffSchedule } from "./backoff";

// Deliberately imports only ./backoff, not ./realtime — the latter pulls in
// react-native's AppState, which plain `node --import tsx --test` cannot
// resolve outside of Metro. See src/api/realtime.ts's module doc comment for
// why the ACTUAL runtime path is polling, not this reconnect backoff.

test("attempt 0 is the base delay", () => {
  assert.equal(backoffSchedule(0), 1000);
});

test("doubles each attempt", () => {
  assert.equal(backoffSchedule(1), 2000);
  assert.equal(backoffSchedule(2), 4000);
  assert.equal(backoffSchedule(3), 8000);
  assert.equal(backoffSchedule(4), 16000);
});

test("caps at 30s", () => {
  assert.equal(backoffSchedule(5), 30000);
  assert.equal(backoffSchedule(10), 30000);
  assert.equal(backoffSchedule(100), 30000);
});

test("a negative attempt (defensive) returns the base delay", () => {
  assert.equal(backoffSchedule(-1), 1000);
});

test("custom base and cap are respected", () => {
  assert.equal(backoffSchedule(0, 500, 4000), 500);
  assert.equal(backoffSchedule(3, 500, 4000), 4000);
});
