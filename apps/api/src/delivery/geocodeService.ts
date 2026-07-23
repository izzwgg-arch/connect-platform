// Geocode service — fills lat/lng for address-only orders using the configured provider
// (noop by default → no external calls). Called fire-and-forget on ingest + via a backfill batch.

import { db } from "@connect/db";
import { geocoderFromEnv, type GeocodingProvider } from "./geocoding";

export async function geocodeOrder(tenantId: string, orderId: string, provider: GeocodingProvider = geocoderFromEnv()): Promise<boolean> {
  if (provider.name === "noop") return false;
  const order = await db.deliveryOrder.findFirst({
    where: { id: orderId, tenantId, lat: null },
    select: { id: true, addrLine1: true, addrCity: true, addrRegion: true, addrPostal: true },
  });
  if (!order) return false;
  const coords = await provider.geocode({ line1: order.addrLine1, city: order.addrCity, region: order.addrRegion, postal: order.addrPostal });
  if (!coords) return false;
  await db.deliveryOrder.update({ where: { id: order.id }, data: { lat: coords.lat, lng: coords.lng, geocodedAt: new Date() } });
  return true;
}

/** Backfill: geocode active orders that still lack coordinates (bounded). */
export async function geocodePendingOrders(tenantId: string, limit = 25, provider: GeocodingProvider = geocoderFromEnv()) {
  if (provider.name === "noop") return { processed: 0, geocoded: 0, skipped: "no_geocoder" as const };
  const orders = await db.deliveryOrder.findMany({
    where: { tenantId, lat: null, status: { notIn: ["DELIVERED", "CANCELED"] } },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 100),
    select: { id: true },
  });
  let geocoded = 0;
  for (const o of orders) {
    if (await geocodeOrder(tenantId, o.id, provider)) geocoded++;
  }
  return { processed: orders.length, geocoded };
}
