import { test } from "node:test";
import assert from "node:assert/strict";
import { successRate, firstAttemptRate, meanMinutes, etaAccuracyPct, reasonBreakdown, buildReportSummary, ratio } from "./reportAggregation";
import { clampRetentionDays, retentionCutoff, retentionPlan, shouldPrune, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS } from "./retentionPolicy";

// ── reporting ────────────────────────────────────────────────────────────────
test("ratios guard divide-by-zero", () => {
  assert.equal(ratio(5, 0), 0);
  assert.equal(successRate(0, 0), 0);
  assert.equal(firstAttemptRate(3, 0), 0);
});

test("success + first-attempt rates", () => {
  assert.equal(Math.round(successRate(90, 10) * 100), 90);
  assert.equal(Math.round(firstAttemptRate(80, 100) * 100), 80);
});

test("mean minutes from seconds", () => {
  assert.equal(meanMinutes([600, 1200, 1800]), 20); // mean 1200s = 20m
  assert.equal(meanMinutes([]), 0);
});

test("ETA accuracy = % of actuals within predicted range", () => {
  const samples = [
    { from: 10, to: 20, actual: 15 }, // hit
    { from: 10, to: 20, actual: 25 }, // miss
    { from: 30, to: 40, actual: 30 }, // hit (boundary)
    { from: 20, to: 10, actual: 15 }, // hit (reversed range tolerated)
  ];
  assert.equal(etaAccuracyPct(samples), 75);
  assert.equal(etaAccuracyPct([]), 0);
});

test("reason breakdown sorts desc with percentages", () => {
  const b = reasonBreakdown({ customer_unavailable: 41, incorrect_address: 28, cannot_access: 19, damaged: 12 });
  assert.equal(b[0].reason, "customer_unavailable");
  assert.equal(b[0].pct, 41);
  assert.ok(b[0].count >= b[1].count);
});

test("report summary flags approximate metrics honestly", () => {
  const s = buildReportSummary({
    ordersReceived: 100, delivered: 90, failed: 10, firstAttemptDelivered: 82,
    deliveryDurationsSec: [1500, 1800, 2100], etaSamples: [{ from: 10, to: 20, actual: 15 }],
    failedReasonCounts: { customer_unavailable: 6, damaged: 4 },
  });
  assert.equal(s.successRatePct, 90);
  assert.equal(s.firstAttemptPct, 91);
  assert.ok(s.approximateMetrics.includes("etaAccuracyPct"));
  assert.ok(s.topFailedReasons.length === 2);
});

// ── retention ────────────────────────────────────────────────────────────────
test("retention days clamp to platform bounds", () => {
  assert.equal(clampRetentionDays(0), MIN_RETENTION_DAYS);
  assert.equal(clampRetentionDays(9999), MAX_RETENTION_DAYS);
  assert.equal(clampRetentionDays(undefined), 30);
  assert.equal(clampRetentionDays(45), 45);
});

test("cutoff + prune decision", () => {
  const now = 10_000 * 86_400_000; // day 10000
  const cutoff = retentionCutoff(now, 30);
  assert.equal(cutoff.getTime(), now - 30 * 86_400_000);
  assert.equal(shouldPrune(now - 31 * 86_400_000, cutoff.getTime()), true);
  assert.equal(shouldPrune(now - 29 * 86_400_000, cutoff.getTime()), false);
});

test("retention plan: eta window <= location window", () => {
  const now = 10_000 * 86_400_000;
  const plan = retentionPlan(now, 30);
  assert.ok(plan.etaCutoff.getTime() >= plan.locationCutoff.getTime()); // eta pruned sooner (more recent cutoff)
  assert.ok(plan.locationCutoff.getTime() === now - 30 * 86_400_000);
});
