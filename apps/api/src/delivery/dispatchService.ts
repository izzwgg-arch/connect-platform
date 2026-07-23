// Dispatcher service — dashboard counts, driver management, config, exceptions, audit.
// Phase 3. Counts that depend on later phases (delayed/staleGps/notificationFailures)
// return 0 for now and light up in Phases 5/7 — clearly stubbed, never fabricated.

import { db } from "@connect/db";
import type { DashboardCounts } from "./dashboard";
import { DELIVERY_SETTINGS_DEFAULTS } from "./settingsService";
import { EXCEPTION_STATUSES } from "./status";
import { writeDeliveryAudit } from "./audit";

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
  return db.driverProfile.findMany({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
    select: { id: true, userId: true, status: true, active: true, activeRunId: true, stores: { select: { storeId: true } } },
  });
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
