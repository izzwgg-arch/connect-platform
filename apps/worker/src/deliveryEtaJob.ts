// Delivery ETA recompute cycle (Phase 6). Periodically recomputes ETAs for active runs and
// writes EtaSnapshot rows (audit + confidence tracking). Register from the worker main loop:
//   setInterval(() => { runDeliveryEtaCycle().catch(() => {}); }, 30_000);
//
// NOTE: the ETA heuristic mirrors apps/api/src/delivery/eta.ts. When the ETA cores are
// promoted to packages/shared (cleanup), import them here instead of the inline copy below.
// Not runtime-verified in the authoring env (needs DB + BullMQ).

import { db } from "@connect/db";

const AVG_STOP_TRAVEL_SEC = 480; // 8 min/stop heuristic until real routing is wired
const AVG_SERVICE_SEC = 120;

function computeEtaSeconds(stopsAway: number, isLive: boolean, ageSec: number) {
  const travel = AVG_STOP_TRAVEL_SEC * (stopsAway + 1);
  const service = AVG_SERVICE_SEC * stopsAway;
  const center = travel + service;
  let spread = 0.15 + 0.05 * stopsAway;
  if (!isLive) spread += 0.25;
  if (ageSec > 120) spread += 0.1;
  spread = Math.min(spread, 0.6);
  const step = 300;
  const round = (s: number) => Math.max(0, Math.round(s / step) * step);
  const min = round(center * (1 - spread));
  const max = Math.max(round(center * (1 + spread)), min + step);
  let confidence: "high" | "medium" | "low";
  if (isLive && stopsAway <= 1) confidence = "high";
  else if (isLive && stopsAway <= 3) confidence = "medium";
  else confidence = "low";
  return { min, max, confidence };
}

/** Recompute ETA snapshots for every active run's remaining stops. Idempotent-ish (append). */
export async function runDeliveryEtaCycle(): Promise<{ runs: number; snapshots: number }> {
  const runs = await db.deliveryRun.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, tenantId: true },
    take: 500,
  });
  let snapshots = 0;
  const now = Date.now();

  for (const run of runs) {
    // latest fix freshness for this run
    const session = await db.driverTrackingSession.findFirst({
      where: { tenantId: run.tenantId, runId: run.id },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    const fix = session
      ? await db.driverLocationSample.findFirst({ where: { sessionId: session.id }, orderBy: { serverTs: "desc" }, select: { serverTs: true } })
      : null;
    const ageSec = fix ? (now - fix.serverTs.getTime()) / 1000 : Number.POSITIVE_INFINITY;
    const isLive = ageSec <= 90;

    const stops = await db.deliveryRunStop.findMany({
      where: { runId: run.id, status: { notIn: ["DONE", "FAILED", "SKIPPED"] } },
      orderBy: { sequence: "asc" },
      select: { orderId: true, sequence: true },
    });

    for (let i = 0; i < stops.length; i++) {
      const { min, max, confidence } = computeEtaSeconds(i, isLive, isLive ? ageSec : 999);
      await db.etaSnapshot.create({
        data: { tenantId: run.tenantId, runId: run.id, orderId: stops[i].orderId, stopsAway: i, etaMinSec: min, etaMaxSec: max, confidence },
      });
      snapshots++;
    }
  }
  return { runs: runs.length, snapshots };
}
