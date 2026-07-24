// Dispatcher dashboard aggregation — PURE (shaping only; the service supplies counts).
// Keeps the "summary before detail" ordering and severity ranking unit-testable.

export interface DashboardCounts {
  activeDeliveries: number;
  awaitingAssignment: number;
  readyForPickup: number;
  driversOnline: number;
  driversOffline: number;
  activeRuns: number;
  delayed: number;
  staleGps: number;
  deliveredToday: number;
  failedToday: number;
  notificationFailures: number;
}

export interface DashboardTile {
  key: string;
  label: string;
  value: number;
  tone: "neutral" | "positive" | "warn" | "danger";
}

/** Headline tiles, in display order. Tone escalates when a value needs attention. */
export function dashboardTiles(c: DashboardCounts): DashboardTile[] {
  return [
    { key: "activeDeliveries", label: "Active deliveries", value: c.activeDeliveries, tone: "neutral" },
    { key: "delayed", label: "Delayed", value: c.delayed, tone: c.delayed > 0 ? "warn" : "neutral" },
    { key: "staleGps", label: "Stale GPS", value: c.staleGps, tone: c.staleGps > 0 ? "danger" : "neutral" },
    { key: "deliveredToday", label: "Delivered today", value: c.deliveredToday, tone: "positive" },
  ];
}

export type AttentionKind = "stale_gps" | "delayed" | "exception" | "notification_failed";

export interface AttentionItem {
  kind: AttentionKind;
  ref: string; // order/run id or number
  detail: string;
}

const SEVERITY: Record<AttentionKind, number> = {
  stale_gps: 0, // most urgent
  exception: 1,
  delayed: 2,
  notification_failed: 3,
};

/** Order the attention queue by severity, then stable by ref. Pure. */
export function rankAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const s = SEVERITY[a.kind] - SEVERITY[b.kind];
    return s !== 0 ? s : a.ref.localeCompare(b.ref);
  });
}

/** True when the board has anything a dispatcher must act on. */
export function needsIntervention(c: DashboardCounts): boolean {
  return c.staleGps > 0 || c.delayed > 0 || c.notificationFailures > 0;
}
