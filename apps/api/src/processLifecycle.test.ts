import assert from "node:assert";
import test from "node:test";
import {
  clearRegisteredShutdownTimers,
  isReadyToServeTraffic,
  markListeningComplete,
  markNotAcceptingTraffic,
  registerShutdownTimer,
  shutdownRegisteredTimerCount,
} from "./processLifecycle";

test("readiness gates traffic after listen and drain", () => {
  clearRegisteredShutdownTimers();
  markListeningComplete();
  assert.equal(isReadyToServeTraffic(), true);
  markNotAcceptingTraffic();
  assert.equal(isReadyToServeTraffic(), false);
});

test("registerShutdownTimer collects handles", () => {
  clearRegisteredShutdownTimers();
  registerShutdownTimer(setInterval(() => undefined, 60_000));
  assert.ok(shutdownRegisteredTimerCount() >= 1);
  clearRegisteredShutdownTimers();
  assert.equal(shutdownRegisteredTimerCount(), 0);
});
