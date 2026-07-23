import { test } from "node:test";
import assert from "node:assert/strict";
import { reportingIntervalSec, DEFAULT_INTERVALS } from "./adaptiveInterval";

test("approaching is most frequent, moving next, stationary sparse", () => {
  const approach = reportingIntervalSec({ moving: true, approaching: true });
  const moving = reportingIntervalSec({ moving: true, approaching: false });
  const still = reportingIntervalSec({ moving: false, approaching: false });
  assert.ok(approach < moving, "approaching < moving");
  assert.ok(moving < still, "moving < stationary");
  assert.equal(approach, DEFAULT_INTERVALS.approachingSec);
  assert.equal(still, DEFAULT_INTERVALS.stationarySec);
});

test("low battery backs off the interval", () => {
  const normal = reportingIntervalSec({ moving: true, approaching: false, batteryPct: 80 });
  const low = reportingIntervalSec({ moving: true, approaching: false, batteryPct: 10 });
  assert.ok(low > normal, "low battery should report less often");
});

test("low-power mode also backs off", () => {
  const normal = reportingIntervalSec({ moving: true, approaching: false });
  const lpm = reportingIntervalSec({ moving: true, approaching: false, lowPowerMode: true });
  assert.ok(lpm > normal);
});

test("interval is clamped to the configured maximum", () => {
  const sec = reportingIntervalSec(
    { moving: false, approaching: false, batteryPct: 5 },
    { ...DEFAULT_INTERVALS, stationarySec: 120, lowBatteryMultiplier: 5, maxSec: 180 },
  );
  assert.ok(sec <= 180);
});
