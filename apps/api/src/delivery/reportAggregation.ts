// Reporting aggregation — PURE. Turns raw counts/durations into report metrics, and is explicit
// about which metrics are approximate vs. operational (Gate 3 §29). No DB here.

export function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

/** delivered / (delivered + failed). */
export function successRate(delivered: number, failed: number): number {
  return ratio(delivered, delivered + failed);
}

/** first-attempt deliveries / total deliveries. */
export function firstAttemptRate(firstAttempt: number, delivered: number): number {
  return ratio(firstAttempt, delivered);
}

export function meanSeconds(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function meanMinutes(secs: number[]): number {
  return Math.round(meanSeconds(secs) / 60);
}

export interface EtaSample {
  from: number; // predicted min minutes
  to: number; // predicted max minutes
  actual: number; // actual minutes
}

/** % of deliveries whose actual time fell within the predicted range. APPROXIMATE. */
export function etaAccuracyPct(samples: EtaSample[]): number {
  if (!samples.length) return 0;
  const hit = samples.filter((s) => s.actual >= Math.min(s.from, s.to) && s.actual <= Math.max(s.from, s.to)).length;
  return Math.round(ratio(hit, samples.length) * 100);
}

export interface ReasonCount { reason: string; count: number; pct: number }

export function reasonBreakdown(counts: Record<string, number>): ReasonCount[] {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.entries(counts)
    .map(([reason, count]) => ({ reason, count, pct: Math.round(ratio(count, total) * 100) }))
    .sort((a, b) => b.count - a.count);
}

export interface RawReport {
  ordersReceived: number;
  delivered: number;
  failed: number;
  firstAttemptDelivered: number;
  deliveryDurationsSec: number[]; // pickup → delivered
  etaSamples: EtaSample[];
  failedReasonCounts: Record<string, number>;
}

export interface ReportSummary {
  ordersReceived: number;
  delivered: number;
  failed: number;
  successRatePct: number;
  firstAttemptPct: number;
  avgDeliveryMinutes: number;
  etaAccuracyPct: number;
  topFailedReasons: ReasonCount[];
  /** Metrics that depend on external/estimated data — surfaced honestly. */
  approximateMetrics: string[];
}

export function buildReportSummary(raw: RawReport): ReportSummary {
  return {
    ordersReceived: raw.ordersReceived,
    delivered: raw.delivered,
    failed: raw.failed,
    successRatePct: Math.round(successRate(raw.delivered, raw.failed) * 100),
    firstAttemptPct: Math.round(firstAttemptRate(raw.firstAttemptDelivered, raw.delivered) * 100),
    avgDeliveryMinutes: meanMinutes(raw.deliveryDurationsSec),
    etaAccuracyPct: etaAccuracyPct(raw.etaSamples),
    topFailedReasons: reasonBreakdown(raw.failedReasonCounts).slice(0, 6),
    approximateMetrics: ["etaAccuracyPct", "avgDeliveryMinutes"],
  };
}
