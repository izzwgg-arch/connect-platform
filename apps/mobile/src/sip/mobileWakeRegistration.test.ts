import test from "node:test";
import assert from "node:assert/strict";
import { shouldForceRestartOnWake } from "./mobileWakeRegistration.js";

test("healthy PSTN wake does not forceRestart", () => {
  assert.equal(
    shouldForceRestartOnWake({ sipConnected: true, sipRegistered: true }),
    false,
  );
});

test("unhealthy wake still forceRestarts when not connected", () => {
  assert.equal(
    shouldForceRestartOnWake({ sipConnected: false, sipRegistered: true }),
    true,
  );
});

test("unhealthy wake still forceRestarts when not registered", () => {
  assert.equal(
    shouldForceRestartOnWake({ sipConnected: true, sipRegistered: false }),
    true,
  );
});

test("fully unhealthy wake forceRestarts", () => {
  assert.equal(
    shouldForceRestartOnWake({ sipConnected: false, sipRegistered: false }),
    true,
  );
});
