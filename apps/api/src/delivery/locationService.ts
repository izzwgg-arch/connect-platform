// Location ingestion + tracking-session lifecycle + dispatcher map data.
// Uses the pure geo/staleness cores. Server-side plausibility guards flag mock/glitch fixes.

import { db } from "@connect/db";
import { isPlausibleCoord, isImplausibleJump, type LatLng } from "./geo";
import { computeMovement } from "./staleness";
import { writeDeliveryAudit } from "./audit";

export interface IncomingSample {
  lat: number;
  lng: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  batteryPct?: number | null;
  deviceTs: number; // ms epoch
}

/** Start a tracking session for a run (ends any dangling open session for the driver). */
export async function startSession(tenantId: string, runId: string, driverId: string) {
  await db.driverTrackingSession.updateMany({
    where: { tenantId, driverId, endedAt: null },
    data: { endedAt: new Date(), endReason: "SUPERSEDED" },
  });
  const s = await db.driverTrackingSession.create({
    data: { tenantId, runId, driverId },
    select: { id: true },
  });
  await db.driverProfile.update({ where: { id: driverId }, data: { status: "ON_RUN", activeRunId: runId } });
  writeDeliveryAudit({ tenantId, action: "delivery.tracking.started", entityType: "DriverTrackingSession", entityId: s.id, metadata: { runId, driverId } });
  return { sessionId: s.id };
}

export async function endSession(tenantId: string, sessionId: string, reason = "COMPLETED") {
  const s = await db.driverTrackingSession.findFirst({ where: { id: sessionId, tenantId }, select: { id: true, driverId: true, endedAt: true } });
  if (!s) return { ok: false as const, code: "not_found" };
  if (!s.endedAt) {
    await db.driverTrackingSession.update({ where: { id: s.id }, data: { endedAt: new Date(), endReason: reason } });
    await db.driverProfile.update({ where: { id: s.driverId }, data: { status: "AVAILABLE", activeRunId: null } });
  }
  writeDeliveryAudit({ tenantId, action: "delivery.tracking.ended", entityType: "DriverTrackingSession", entityId: s.id, metadata: { reason } });
  return { ok: true as const };
}

/** Ingest a batch. Rejects implausible coords; flags implausible jumps as mockSuspected. */
export async function ingestSamples(tenantId: string, sessionId: string, samples: IncomingSample[]) {
  const session = await db.driverTrackingSession.findFirst({
    where: { id: sessionId, tenantId, endedAt: null },
    select: { id: true },
  });
  if (!session) return { ok: false as const, code: "no_active_session" };

  const last = await db.driverLocationSample.findFirst({
    where: { sessionId },
    orderBy: { serverTs: "desc" },
    select: { lat: true, lng: true, deviceTs: true },
  });

  let prev: { p: LatLng; ts: number } | null = last ? { p: { lat: last.lat, lng: last.lng }, ts: last.deviceTs.getTime() } : null;
  const rows: any[] = [];
  let rejected = 0;

  for (const s of [...samples].sort((a, b) => a.deviceTs - b.deviceTs)) {
    if (!isPlausibleCoord(s)) {
      rejected++;
      continue;
    }
    let mockSuspected = false;
    if (prev) {
      const elapsed = (s.deviceTs - prev.ts) / 1000;
      mockSuspected = isImplausibleJump(prev.p, { lat: s.lat, lng: s.lng }, elapsed);
    }
    rows.push({
      tenantId,
      sessionId,
      lat: s.lat,
      lng: s.lng,
      accuracy: s.accuracy ?? null,
      speed: s.speed ?? null,
      heading: s.heading ?? null,
      batteryPct: s.batteryPct ?? null,
      mockSuspected,
      deviceTs: new Date(s.deviceTs),
    });
    prev = { p: { lat: s.lat, lng: s.lng }, ts: s.deviceTs };
  }

  if (rows.length) await db.driverLocationSample.createMany({ data: rows });
  return { ok: true as const, accepted: rows.length, rejected };
}

/** Latest fix for a run (via its active session). */
export async function latestForRun(tenantId: string, runId: string) {
  const session = await db.driverTrackingSession.findFirst({
    where: { tenantId, runId },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (!session) return null;
  return db.driverLocationSample.findFirst({
    where: { sessionId: session.id },
    orderBy: { serverTs: "desc" },
    select: { lat: true, lng: true, speed: true, heading: true, serverTs: true },
  });
}

/** Dispatcher live-map payload: active runs + driver + latest position + movement status. */
export async function getDispatchMap(tenantId: string, storeId?: string) {
  const runs = await db.deliveryRun.findMany({
    where: { tenantId, status: "ACTIVE", ...(storeId ? { storeId } : {}) },
    select: { id: true, driverId: true, storeId: true },
  });
  const now = Date.now();
  const out = [];
  for (const run of runs) {
    const fix = await latestForRun(tenantId, run.id);
    const movement = computeMovement({
      lastSampleAtMs: fix ? fix.serverTs.getTime() : null,
      nowMs: now,
      speedMps: fix?.speed ?? null,
    });
    out.push({
      runId: run.id,
      driverId: run.driverId,
      storeId: run.storeId,
      position: movement.isLive && fix ? { lat: fix.lat, lng: fix.lng, heading: fix.heading } : null,
      movement: movement.status,
      lastUpdateSec: movement.ageSec,
    });
  }
  return out;
}
