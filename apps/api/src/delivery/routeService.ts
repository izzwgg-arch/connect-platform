// Route service — optimize a run's stop order (the "best route") and build per-stop Waze/Google
// navigation links. Uses source-provided coordinates when present; ungeocoded stops are kept in
// their existing order after the optimized ones (geocode them via a MapsProvider to include them).

import { db } from "@connect/db";
import { optimizeRoute, type RouteStop } from "./routeOptimizer";
import { navUrlFor, type NavApp } from "./navLinks";
import { writeDeliveryAudit } from "./audit";

const DONE_STOP = new Set(["DONE", "ARRIVED", "FAILED", "SKIPPED"]);

export async function optimizeRun(tenantId: string, runId: string, actorUserId?: string) {
  const run = await db.deliveryRun.findFirst({ where: { id: runId, tenantId }, select: { id: true, storeId: true } });
  if (!run) return { ok: false as const, code: "not_found" };

  const store = await db.deliveryStore.findFirst({ where: { id: run.storeId, tenantId }, select: { lat: true, lng: true } });
  const stops = await db.deliveryRunStop.findMany({
    where: { runId, tenantId },
    orderBy: { sequence: "asc" },
    select: { id: true, orderId: true, sequence: true, status: true, order: { select: { lat: true, lng: true, priority: true, status: true } } },
  });

  const geocoded = stops.filter((s) => s.order.lat != null && s.order.lng != null);
  const ungeocoded = stops.filter((s) => s.order.lat == null || s.order.lng == null);
  if (geocoded.length < 2) {
    return { ok: true as const, optimized: 0, skipped: "not_enough_geocoded_stops", ungeocoded: ungeocoded.length };
  }

  const start = store?.lat != null && store?.lng != null
    ? { lat: store.lat, lng: store.lng }
    : { lat: geocoded[0].order.lat!, lng: geocoded[0].order.lng! };

  const routeStops: RouteStop[] = geocoded.map((s) => ({
    id: s.orderId,
    lat: s.order.lat!,
    lng: s.order.lng!,
    locked: DONE_STOP.has(s.status) || DONE_STOP.has(s.order.status),
    priority: s.order.priority === "HIGH",
  }));

  const result = optimizeRoute(start, routeStops);

  // Reassign sequence: optimized geocoded stops first (in new order), ungeocoded appended.
  const orderIndex = new Map(result.order.map((orderId, i) => [orderId, i + 1]));
  const updates = [
    ...geocoded.map((s) => db.deliveryRunStop.update({ where: { id: s.id }, data: { sequence: orderIndex.get(s.orderId)! } })),
    ...ungeocoded.map((s, i) => db.deliveryRunStop.update({ where: { id: s.id }, data: { sequence: result.order.length + 1 + i } })),
  ];
  await db.$transaction(updates);

  writeDeliveryAudit({
    tenantId, action: "delivery.run.optimized", entityType: "DeliveryRun", entityId: runId, actorUserId: actorUserId ?? null,
    metadata: { optimized: geocoded.length, totalMeters: Math.round(result.totalMeters), ungeocoded: ungeocoded.length },
  });

  return { ok: true as const, optimized: geocoded.length, ungeocoded: ungeocoded.length, order: result.order, totalMeters: Math.round(result.totalMeters) };
}

/** Build a navigation deep link (Waze default) for an order's stop. */
export async function stopNavUrl(tenantId: string, orderId: string, app: NavApp = "waze") {
  const order = await db.deliveryOrder.findFirst({ where: { id: orderId, tenantId }, select: { lat: true, lng: true } });
  if (!order || order.lat == null || order.lng == null) return { ok: false as const, code: "no_coords" };
  return { ok: true as const, app, url: navUrlFor(app, { lat: order.lat, lng: order.lng }) };
}
