// Delivery run service — grouped-delivery runs (Phase 2 foundation).
// Manual dispatcher control is primary; route optimization is a later phase.

import { db } from "@connect/db";
import { transitionOrder, driverNameMap } from "./orderService";
import { writeDeliveryAudit } from "./audit";
import type { DeliveryOrderStatus } from "./status";

export async function createRun(
  tenantId: string,
  storeId: string,
  opts: { driverId?: string; windowStart?: Date | null; windowEnd?: Date | null } = {},
) {
  const run = await db.deliveryRun.create({
    data: {
      tenantId,
      storeId,
      driverId: opts.driverId ?? null,
      status: "DRAFT",
      windowStart: opts.windowStart ?? null,
      windowEnd: opts.windowEnd ?? null,
    },
    select: { id: true },
  });
  writeDeliveryAudit({ tenantId, action: "delivery.run.created", entityType: "DeliveryRun", entityId: run.id });
  return run;
}

/** Add an order as the next stop on a run (idempotent per (runId, orderId)). */
export async function addStop(tenantId: string, runId: string, orderId: string) {
  const run = await db.deliveryRun.findFirst({ where: { id: runId, tenantId }, select: { id: true } });
  const order = await db.deliveryOrder.findFirst({ where: { id: orderId, tenantId }, select: { id: true } });
  if (!run || !order) return { ok: false, code: "not_found" as const };

  const last = await db.deliveryRunStop.findFirst({
    where: { runId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const sequence = (last?.sequence ?? 0) + 1;

  try {
    await db.deliveryRunStop.create({ data: { tenantId, runId, orderId, sequence, status: "PENDING" } });
  } catch (e: any) {
    if (e?.code === "P2002") return { ok: true, code: "already_on_run" as const };
    throw e;
  }
  // Link the assignment to this run when one exists.
  await db.deliveryAssignment.updateMany({ where: { orderId, tenantId }, data: { runId } });
  return { ok: true as const, sequence };
}

/** Start a run: mark active and move its orders to OUT_FOR_DELIVERY. */
export async function startRun(tenantId: string, runId: string, actorUserId: string) {
  const run = await db.deliveryRun.findFirst({
    where: { id: runId, tenantId },
    select: { id: true, status: true, stops: { select: { orderId: true } } },
  });
  if (!run) return { ok: false, code: "not_found" as const };
  if (run.status === "ACTIVE") return { ok: true as const, alreadyActive: true };

  await db.deliveryRun.update({ where: { id: run.id }, data: { status: "ACTIVE", startedAt: new Date() } });

  const results: { orderId: string; ok: boolean; code?: string }[] = [];
  for (const stop of run.stops) {
    const order = await db.deliveryOrder.findFirst({ where: { id: stop.orderId, tenantId }, select: { status: true } });
    const status = order?.status as DeliveryOrderStatus | undefined;
    // Only assigned/loaded orders go out for delivery.
    if (status === "ASSIGNED" || status === "LOADED") {
      const r = await transitionOrder({
        tenantId,
        orderId: stop.orderId,
        to: "OUT_FOR_DELIVERY",
        actor: "driver",
        actorUserId,
      });
      results.push({ orderId: stop.orderId, ok: r.ok, code: r.ok ? undefined : (r as any).code });
    }
  }

  writeDeliveryAudit({
    tenantId,
    action: "delivery.run.started",
    entityType: "DeliveryRun",
    entityId: run.id,
    actorUserId,
    metadata: { stops: run.stops.length, dispatched: results.filter((r) => r.ok).length },
  });
  return { ok: true as const, dispatched: results };
}

/** Dispatcher run board: active/draft runs with driver name + stop progress. */
export async function listRuns(tenantId: string, opts: { storeId?: string } = {}) {
  const runs = await db.deliveryRun.findMany({
    where: { tenantId, status: { in: ["DRAFT", "ACTIVE", "PAUSED"] }, ...(opts.storeId ? { storeId: opts.storeId } : {}) },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 100,
    select: {
      id: true, storeId: true, driverId: true, status: true, windowStart: true, windowEnd: true, startedAt: true,
      stops: { select: { status: true } },
    },
  });
  const names = await driverNameMap(tenantId, runs.map((r) => r.driverId));
  return runs.map((r) => {
    const total = r.stops.length;
    const done = r.stops.filter((s) => s.status === "DONE" || s.status === "FAILED" || s.status === "SKIPPED").length;
    return {
      id: r.id, storeId: r.storeId, status: r.status,
      driverId: r.driverId, driverName: r.driverId ? names.get(r.driverId) ?? null : null,
      windowStart: r.windowStart, windowEnd: r.windowEnd, startedAt: r.startedAt,
      stopsTotal: total, stopsDone: done,
    };
  });
}

/** READY orders not yet on any run — the unassigned pool for the run board. */
export async function listUnassignedOrders(tenantId: string, storeId?: string) {
  return db.deliveryOrder.findMany({
    where: { tenantId, status: "READY", runStop: { is: null }, ...(storeId ? { storeId } : {}) },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true, sourceId: true, storeId: true, addrLine1: true, addrUnit: true, customerName: true, priority: true },
  });
}

/** Full run detail for the dispatcher run-detail / route-editor page. */
export async function getRun(tenantId: string, runId: string) {
  const run = await db.deliveryRun.findFirst({
    where: { id: runId, tenantId },
    select: {
      id: true, storeId: true, driverId: true, status: true, windowStart: true, windowEnd: true, startedAt: true, endedAt: true,
      stops: {
        orderBy: { sequence: "asc" },
        select: {
          id: true, sequence: true, status: true, orderId: true,
          order: { select: { sourceId: true, addrLine1: true, addrUnit: true, customerName: true, status: true, lat: true, lng: true } },
        },
      },
    },
  });
  if (!run) return null;
  const names = await driverNameMap(tenantId, [run.driverId]);
  const done = run.stops.filter((s) => s.status === "DONE" || s.status === "FAILED" || s.status === "SKIPPED").length;
  return {
    ...run,
    driverName: run.driverId ? names.get(run.driverId) ?? null : null,
    stopsTotal: run.stops.length,
    stopsDone: done,
  };
}

/** Manually reorder a run's stops (route editor). orderedStopIds = DeliveryRunStop ids in new order. */
export async function reorderRunStops(tenantId: string, runId: string, orderedStopIds: string[], actorUserId: string) {
  const run = await db.deliveryRun.findFirst({ where: { id: runId, tenantId }, select: { id: true, stops: { select: { id: true } } } });
  if (!run) return { ok: false as const, code: "not_found" };
  const valid = new Set(run.stops.map((s) => s.id));
  const seq = orderedStopIds.filter((id) => valid.has(id));
  if (seq.length !== run.stops.length) return { ok: false as const, code: "incomplete_order" };
  // Two-phase to avoid unique (runId, sequence) clashes: offset, then set final.
  await db.$transaction([
    ...seq.map((id, i) => db.deliveryRunStop.update({ where: { id }, data: { sequence: 1000 + i } })),
    ...seq.map((id, i) => db.deliveryRunStop.update({ where: { id }, data: { sequence: i + 1 } })),
  ]);
  writeDeliveryAudit({ tenantId, action: "delivery.run.reordered", entityType: "DeliveryRun", entityId: runId, actorUserId, metadata: { stops: seq.length } });
  return { ok: true as const };
}

export async function listRunsForDriver(tenantId: string, driverId: string) {
  return db.deliveryRun.findMany({
    where: { tenantId, driverId, status: { in: ["DRAFT", "ACTIVE"] } },
    orderBy: { createdAt: "asc" },
    include: {
      stops: {
        orderBy: { sequence: "asc" },
        include: {
          order: {
            // The driver app's in-app map needs coordinates; the stop card needs the
            // person + the voicemail/text note. All read-only, all this driver's own run.
            select: {
              id: true,
              status: true,
              addrLine1: true,
              addrUnit: true,
              addrCity: true,
              customerName: true,
              instructions: true,
              lat: true,
              lng: true,
            },
          },
        },
      },
    },
  });
}
