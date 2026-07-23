// Adaptive location reporting interval — PURE. Balances accuracy vs. battery/server load
// (Gate 3 §9.3). Frequent while moving/approaching; sparse while stationary; backs off on
// low battery. No RN dependency so it's unit-testable.

export interface IntervalInput {
  moving: boolean;
  approaching: boolean; // driver is within ~1 stop of a delivery
  batteryPct?: number | null; // 0..100
  lowPowerMode?: boolean;
}

export interface IntervalConfig {
  movingSec: number;
  stationarySec: number;
  approachingSec: number;
  lowBatteryPct: number;
  lowBatteryMultiplier: number;
  maxSec: number;
}

export const DEFAULT_INTERVALS: IntervalConfig = {
  movingSec: 12,
  stationarySec: 60,
  approachingSec: 6,
  lowBatteryPct: 15,
  lowBatteryMultiplier: 2.5,
  maxSec: 180,
};

/** Returns the next reporting interval in seconds. */
export function reportingIntervalSec(input: IntervalInput, cfg: IntervalConfig = DEFAULT_INTERVALS): number {
  let sec: number;
  if (input.approaching) sec = cfg.approachingSec;
  else if (input.moving) sec = cfg.movingSec;
  else sec = cfg.stationarySec;

  const lowBattery = (input.batteryPct != null && input.batteryPct <= cfg.lowBatteryPct) || Boolean(input.lowPowerMode);
  if (lowBattery) sec = Math.round(sec * cfg.lowBatteryMultiplier);

  return Math.min(Math.max(1, sec), cfg.maxSec);
}
