// Location freshness / movement classification — PURE.
// The customer-facing side must NEVER present a stale fix as live (Gate 3 §9.5).

export type MovementStatus = "moving" | "stopped" | "stale" | "offline" | "unknown";

export interface StalenessInput {
  lastSampleAtMs: number | null;
  nowMs: number;
  speedMps?: number | null;
  /** After this age, a fix is "stale" (no longer live). */
  staleAfterSec?: number;
  /** After this age, the driver is treated as "offline". */
  offlineAfterSec?: number;
  /** Speed at/above which the driver counts as moving. */
  movingSpeedMps?: number;
}

export interface StalenessResult {
  status: MovementStatus;
  ageSec: number | null;
  /** True only when the fix is fresh enough to show as the driver's real position. */
  isLive: boolean;
}

export function computeMovement(input: StalenessInput): StalenessResult {
  const staleAfter = input.staleAfterSec ?? 90;
  const offlineAfter = input.offlineAfterSec ?? 300;
  const movingSpeed = input.movingSpeedMps ?? 1;

  if (input.lastSampleAtMs == null) return { status: "unknown", ageSec: null, isLive: false };
  const ageSec = Math.max(0, (input.nowMs - input.lastSampleAtMs) / 1000);

  if (ageSec > offlineAfter) return { status: "offline", ageSec, isLive: false };
  if (ageSec > staleAfter) return { status: "stale", ageSec, isLive: false };

  const speed = input.speedMps ?? 0;
  return { status: speed >= movingSpeed ? "moving" : "stopped", ageSec, isLive: true };
}

/** Customer-safe phrasing for the current movement status. */
export function movementLabel(status: MovementStatus): string {
  switch (status) {
    case "moving":
      return "Your driver is on the way";
    case "stopped":
      return "Your driver is currently stopped";
    case "stale":
    case "offline":
      return "Location has not updated recently";
    default:
      return "Your order is on the way";
  }
}
