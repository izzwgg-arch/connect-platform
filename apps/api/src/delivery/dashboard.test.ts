import { test } from "node:test";
import assert from "node:assert/strict";
import { dashboardTiles, rankAttention, needsIntervention, type DashboardCounts, type AttentionItem } from "./dashboard";

const base: DashboardCounts = {
  activeDeliveries: 7,
  awaitingAssignment: 3,
  readyForPickup: 2,
  driversOnline: 3,
  driversOffline: 1,
  activeRuns: 3,
  delayed: 2,
  staleGps: 1,
  deliveredToday: 34,
  failedToday: 1,
  notificationFailures: 1,
};

test("headline tiles are ordered summary-first with escalating tone", () => {
  const t = dashboardTiles(base);
  assert.deepEqual(t.map((x) => x.key), ["activeDeliveries", "delayed", "staleGps", "deliveredToday"]);
  assert.equal(t.find((x) => x.key === "delayed")!.tone, "warn");
  assert.equal(t.find((x) => x.key === "staleGps")!.tone, "danger");
  assert.equal(t.find((x) => x.key === "deliveredToday")!.tone, "positive");
});

test("tiles calm down when nothing is wrong", () => {
  const t = dashboardTiles({ ...base, delayed: 0, staleGps: 0 });
  assert.equal(t.find((x) => x.key === "delayed")!.tone, "neutral");
  assert.equal(t.find((x) => x.key === "staleGps")!.tone, "neutral");
});

test("attention queue ranks stale GPS above exceptions above delays above notify-failures", () => {
  const items: AttentionItem[] = [
    { kind: "notification_failed", ref: "8793", detail: "invalid #" },
    { kind: "delayed", ref: "8811", detail: "+18m" },
    { kind: "stale_gps", ref: "R-2044", detail: "6m" },
    { kind: "exception", ref: "8829", detail: "address" },
  ];
  assert.deepEqual(rankAttention(items).map((x) => x.kind), ["stale_gps", "exception", "delayed", "notification_failed"]);
});

test("needsIntervention reflects danger/warn counts", () => {
  assert.equal(needsIntervention(base), true);
  assert.equal(needsIntervention({ ...base, delayed: 0, staleGps: 0, notificationFailures: 0 }), false);
});
