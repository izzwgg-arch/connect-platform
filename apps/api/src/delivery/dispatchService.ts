// Dispatcher service — dashboard counts, driver management, config, exceptions, audit.
// Phase 3. Counts that depend on later phases (delayed/staleGps/notificationFailures)
// return 0 for now and light up in Phases 5/7 — clearly stubbed, never fabricated.

import { db } from "@connect/db";
import type { DashboardCounts } from "./dashboard";
import { DELIVERY_SETTINGS_DEFAULTS } from "./settingsService";
import { EXCEPTION_STATUSES } from "./status";
import { writeDeliveryAudit } from "./audit";
import { exceptionRule, type ExceptionReason } from "./exceptionRules";
import { driverNameMap } from "./orderService";

const EXCEPTION_LABELS: Record<string, string> = {
  customer_unavailable: "Customer unavailable", no_answer: "No answer", incorrect_address: "Incorrect address",
  cannot_access: "Cannot access", reschedule_requested: "Reschedule requested", refused: "Refused",
  unsafe_location: "Unsafe location", vehicle_issue: "Vehicle issue", driver_issue: "Driver issue",
  damaged: "Damaged", missing_package: "Missing package", store_error: "Store error", payment_issue: "Payment issue",
  age_verification_failed: "Age verification failed", weather: "Weather delay", traffic: "Traffic delay",
  app_gps_issue: "App / GPS issue", other: "Other issue",
};

const ACTIVE_STATUSES = ["OUT_FOR_DELIVERY", "EN_ROUTE", "APPROACHING", "ARRIVED"];

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function getDashboardCounts(tenantId: string, storeId?: string): Promise<DashboardCounts> {
  const orderWhere = { tenantId, ...(storeId ? { storeId } : {}) };
  const since = startOfToday();

  const [activeDeliveries, readyForPickup, activeRuns, driversOnline, driversOffline, deliveredToday, failedToday] =
    await Promise.all([
      db.deliveryOrder.count({ where: { ...orderWhere, status: { in: ACTIVE_STATUSES } } }),
      db.deliveryOrder.count({ where: { ...orderWhere, status: "READY" } }),
      db.deliveryRun.count({ where: { tenantId, status: "ACTIVE", ...(storeId ? { storeId } : {}) } }),
      db.driverProfile.count({ where: { tenantId, active: true, status: { not: "OFFLINE" } } }),
      db.driverProfile.count({ where: { tenantId, active: true, status: "OFFLINE" } }),
      db.deliveryStatusEvent.count({ where: { tenantId, toStatus: "DELIVERED", createdAt: { gte: since } } }),
      db.deliveryStatusEvent.count({ where: { tenantId, toStatus: "DELIVERY_FAILED", createdAt: { gte: since } } }),
    ]);

  // awaitingAssignment = READY orders with no assignment row.
  const awaitingAssignment = await db.deliveryOrder.count({
    where: { ...orderWhere, status: "READY", assignment: { is: null } },
  });

  return {
    activeDeliveries,
    awaitingAssignment,
    readyForPickup,
    driversOnline,
    driversOffline,
    activeRuns,
    delayed: 0, // Phase 5 (ETA engine)
    staleGps: 0, // Phase 5 (location ingestion)
    deliveredToday,
    failedToday,
    notificationFailures: 0, // Phase 7 (notifications)
  };
}

/** Orders currently in an exception state, for the exception queue. */
export async function listExceptions(tenantId: string, storeId?: string) {
  return db.deliveryOrder.findMany({
    where: { tenantId, ...(storeId ? { storeId } : {}), status: { in: [...EXCEPTION_STATUSES] } },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: { id: true, sourceId: true, status: true, addrLine1: true, updatedAt: true, storeId: true },
  });
}

/** Actionable exception queue — real DeliveryException rows joined to their order. */
export async function listExceptionQueue(tenantId: string, storeId?: string) {
  const rows = await db.deliveryException.findMany({
    where: { tenantId, approvedAt: null },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, orderId: true, reasonCode: true, note: true, photoStorageKey: true, needsApproval: true, createdByDriverId: true, createdAt: true },
  });
  if (rows.length === 0) return [];
  const orderIds = [...new Set(rows.map((r) => r.orderId))];
  const orders = await db.deliveryOrder.findMany({
    where: { tenantId, id: { in: orderIds }, ...(storeId ? { storeId } : {}) },
    select: { id: true, sourceId: true, status: true, addrLine1: true, addrUnit: true, customerName: true, storeId: true },
  });
  const byId = new Map(orders.map((o) => [o.id, o]));
  return rows
    .filter((r) => byId.has(r.orderId))
    .map((r) => {
      const o = byId.get(r.orderId)!;
      const rule = exceptionRule(r.reasonCode as ExceptionReason);
      const severity: "high" | "medium" = rule.requiresApproval || rule.returnsToStore ? "high" : "medium";
      return {
        id: r.id,
        orderId: r.orderId,
        sourceId: o.sourceId,
        status: o.status,
        address: `${o.addrLine1}${o.addrUnit ? ` ${o.addrUnit}` : ""}`,
        customerName: o.customerName ?? null,
        reasonCode: r.reasonCode,
        reasonLabel: EXCEPTION_LABELS[r.reasonCode] ?? r.reasonCode,
        severity,
        needsApproval: r.needsApproval,
        hasPhoto: !!r.photoStorageKey,
        note: r.note ?? null,
        driverId: r.createdByDriverId ?? null,
        occurredAt: r.createdAt,
      };
    });
}

/** Mark an exception handled (resolve/dismiss). Returns the affected orderId. */
export async function resolveExceptionRow(tenantId: string, exceptionId: string, actorUserId: string, action: "resolve" | "dismiss") {
  const ex = await db.deliveryException.findFirst({ where: { id: exceptionId, tenantId }, select: { id: true, orderId: true } });
  if (!ex) return { ok: false as const, code: "not_found" };
  await db.deliveryException.update({ where: { id: ex.id }, data: { approvedByUserId: actorUserId, approvedAt: new Date() } });
  writeDeliveryAudit({ tenantId, action: `delivery.exception.${action}`, entityType: "DeliveryException", entityId: ex.id, actorUserId, metadata: { orderId: ex.orderId } });
  return { ok: true as const, orderId: ex.orderId };
}

/** Recent delivery audit rows (tenant-scoped). */
export async function listDeliveryAudit(tenantId: string, take = 100) {
  return db.auditLog.findMany({
    where: { tenantId, provider: "delivery" },
    orderBy: { createdAt: "desc" },
    take: Math.min(take, 200),
    select: { id: true, action: true, entityType: true, entityId: true, actorUserId: true, metadata: true, createdAt: true },
  });
}

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_KEYS = [
  "enabled",
  "mapReveal",
  "exactPinStopsAway",
  "verifyTier",
  "voiceMode",
  "retentionDays",
  "notifyOutForDelivery",
  "notifyDelayed",
  "notifyDelivered",
  "notifyApproaching",
] as const;

export async function upsertConfig(tenantId: string, patch: Record<string, unknown>, actorUserId: string) {
  const data: Record<string, unknown> = {};
  for (const k of CONFIG_KEYS) {
    if (k in patch) data[k] = patch[k];
  }
  const row = await db.deliveryTenantSettings.upsert({
    where: { tenantId },
    create: { tenantId, ...DELIVERY_SETTINGS_DEFAULTS, ...data },
    update: data,
  });
  writeDeliveryAudit({
    tenantId,
    action: "delivery.config.updated",
    entityType: "DeliveryTenantSettings",
    entityId: row.id,
    actorUserId,
    metadata: { keys: Object.keys(data) },
  });
  return row;
}

// ── Drivers ─────────────────────────────────────────────────────────────────
export async function listDrivers(tenantId: string) {
  const profiles = await db.driverProfile.findMany({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
    select: { id: true, userId: true, status: true, active: true, activeRunId: true, stores: { select: { storeId: true } } },
  });
  if (profiles.length === 0) return [];
  const names = await driverNameMap(tenantId, profiles.map((p) => p.id));

  // Latest fix (last sync + battery) from each driver's OPEN tracking session — real telemetry only.
  const driverIds = profiles.map((p) => p.id);
  const sessions = await db.driverTrackingSession.findMany({
    where: { tenantId, driverId: { in: driverIds }, endedAt: null },
    select: { id: true, driverId: true },
  });
  const sessionToDriver = new Map(sessions.map((s) => [s.id, s.driverId]));
  const latestByDriver = new Map<string, { serverTs: Date; batteryPct: number | null }>();
  if (sessions.length) {
    const samples = await db.driverLocationSample.findMany({
      where: { tenantId, sessionId: { in: sessions.map((s) => s.id) } },
      orderBy: { serverTs: "desc" },
      take: 500,
      select: { sessionId: true, serverTs: true, batteryPct: true },
    });
    for (const s of samples) {
      const did = sessionToDriver.get(s.sessionId);
      if (did && !latestByDriver.has(did)) latestByDriver.set(did, { serverTs: s.serverTs, batteryPct: s.batteryPct ?? null });
    }
  }

  return profiles.map((p) => ({
    id: p.id,
    userId: p.userId,
    name: names.get(p.id) ?? p.userId.slice(0, 8),
    status: p.status,
    active: p.active,
    activeRunId: p.activeRunId,
    stores: p.stores,
    storeCount: p.stores.length,
    lastSyncAt: latestByDriver.get(p.id)?.serverTs ?? null,
    batteryPct: latestByDriver.get(p.id)?.batteryPct ?? null,
  }));
}

export async function createDriver(tenantId: string, userId: string, storeIds: string[], actorUserId: string) {
  const driver = await db.driverProfile.upsert({
    where: { tenantId_userId: { tenantId, userId } },
    create: {
      tenantId,
      userId,
      active: true,
      stores: { create: storeIds.map((storeId) => ({ tenantId, storeId })) },
    },
    update: { active: true },
    select: { id: true },
  });
  writeDeliveryAudit({
    tenantId,
    action: "delivery.driver.created",
    entityType: "DriverProfile",
    entityId: driver.id,
    actorUserId,
    metadata: { userId, storeIds },
  });
  return driver;
}

export async function deactivateDriver(tenantId: string, driverId: string, actorUserId: string) {
  const driver = await db.driverProfile.findFirst({ where: { id: driverId, tenantId }, select: { id: true } });
  if (!driver) return { ok: false as const, code: "not_found" };
  await db.driverProfile.update({ where: { id: driver.id }, data: { active: false, status: "OFFLINE" } });
  writeDeliveryAudit({
    tenantId,
    action: "delivery.driver.deactivated",
    entityType: "DriverProfile",
    entityId: driver.id,
    actorUserId,
  });
  return { ok: true as const };
}
