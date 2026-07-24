// ETA engine — PURE. Honest estimates: ranges (not false precision), confidence tied to
// freshness + distance, and widening when data is stale (Gate 3 §10).

export type EtaConfidence = "high" | "medium" | "low";

export interface EtaInput {
  /** Travel seconds for each leg, index 0 = origin→next-stop, then stop→stop. */
  legTravelSeconds: number[];
  /** Expected service time at each intermediate stop before the target. */
  serviceSecondsPerStop: number;
  /** 0 = customer is the next stop; N = N stops ahead of them. */
  stopsAway: number;
  /** Age of the latest location fix, seconds. */
  ageSec: number;
  /** Whether the latest fix is live. */
  isLive: boolean;
  /** Round the range edges to this granularity (seconds). Default 300 (5 min). */
  roundToSec?: number;
}

export interface EtaResult {
  etaSecondsMin: number;
  etaSecondsMax: number;
  confidence: EtaConfidence;
  stopsAway: number;
  /** Center estimate before spreading, for diagnostics. */
  centerSeconds: number;
}

function roundTo(sec: number, step: number): number {
  return Math.max(0, Math.round(sec / step) * step);
}

export function computeEta(input: EtaInput): EtaResult {
  const step = input.roundToSec ?? 300;
  const stopsAway = Math.max(0, input.stopsAway);

  // Travel to the target = legs 0..stopsAway (inclusive of the leg into the target stop).
  let travel = 0;
  for (let i = 0; i <= stopsAway && i < input.legTravelSeconds.length; i++) travel += input.legTravelSeconds[i];
  const serviceBetween = input.serviceSecondsPerStop * stopsAway;
  const center = travel + serviceBetween;

  // Spread grows with distance and staleness — honesty over precision.
  let spread = 0.15 + 0.05 * stopsAway;
  if (!input.isLive) spread += 0.25;
  if (input.ageSec > 120) spread += 0.1;
  spread = Math.min(spread, 0.6);

  const min = roundTo(center * (1 - spread), step);
  const max = roundTo(center * (1 + spread), step);

  let confidence: EtaConfidence;
  if (input.isLive && stopsAway <= 1) confidence = "high";
  else if (input.isLive && stopsAway <= 3) confidence = "medium";
  else confidence = "low";

  return {
    etaSecondsMin: min,
    etaSecondsMax: Math.max(max, min + step),
    confidence,
    stopsAway,
    centerSeconds: center,
  };
}

/** Format an ETA range as a customer-friendly clock string given a base time. */
export function formatEtaRange(nowMs: number, eta: EtaResult): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${fmt(nowMs + eta.etaSecondsMin * 1000)} – ${fmt(nowMs + eta.etaSecondsMax * 1000)}`;
}
