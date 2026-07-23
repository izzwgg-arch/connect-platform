// Progressive location-reveal policy (decision 1) — PURE.
// Governs exactly what the customer tracking map may show. Enforced server-side so a
// client can never coax out the exact pin early.

export type MapReveal = "PROGRESSIVE" | "FULL" | "NONE";

export interface RevealInput {
  mapReveal: MapReveal;
  /** 0 = the driver is heading to this customer next. */
  stopsAway: number | null;
  /** Whether the current fix is live (not stale). */
  isLive: boolean;
  /** Reveal the exact pin when stopsAway <= this (PROGRESSIVE only). */
  exactPinStopsAway: number;
}

export interface RevealDecision {
  showMap: boolean;
  showExactPin: boolean;
  showApproximateArea: boolean;
  showStopsAway: boolean;
  reason: string;
}

export function decideReveal(input: RevealInput): RevealDecision {
  if (input.mapReveal === "NONE") {
    return { showMap: false, showExactPin: false, showApproximateArea: false, showStopsAway: true, reason: "map_disabled" };
  }

  // Never present a stale fix as a live exact position.
  if (!input.isLive) {
    return { showMap: true, showExactPin: false, showApproximateArea: false, showStopsAway: true, reason: "not_live" };
  }

  if (input.mapReveal === "FULL") {
    return { showMap: true, showExactPin: true, showApproximateArea: false, showStopsAway: true, reason: "full" };
  }

  // PROGRESSIVE
  const near = input.stopsAway != null && input.stopsAway <= input.exactPinStopsAway;
  if (near) {
    return { showMap: true, showExactPin: true, showApproximateArea: false, showStopsAway: true, reason: "near" };
  }
  return { showMap: true, showExactPin: false, showApproximateArea: true, showStopsAway: true, reason: "far_approx" };
}
