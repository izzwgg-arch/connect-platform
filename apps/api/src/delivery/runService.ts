// Delivery run service — grouped-delivery runs (Phase 2 foundation).
// Manual dispatcher control is primary; route optimization is a later phase.

import { db } from "@connect/db";
import { transitionOrder } from "./orderService";
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

export async function listRunsForDriver(tenantId: string, driverId: string) {
  return db.deliveryRun.findMany({
    where: { tenantId, driverId, status: { in: ["DRAFT", "ACTIVE"] } },
    orderBy: { createdAt: "asc" },
    include: { stops: { orderBy: { sequence: "asc" }, include: { order: { select: { id: true, status: true, addrLine1: true, addrUnit: true } } } } },
  });
}
