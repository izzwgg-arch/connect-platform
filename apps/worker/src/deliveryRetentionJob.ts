// Delivery retention sweep (Phase 11). Prunes high-volume location samples + old ETA snapshots
// per each tenant's configured retention window. Register in the worker main loop, e.g.:
//   setInterval(() => { runDeliveryRetentionCycle().catch(() => {}); }, 6 * 3_600_000); // every 6h
//
// Not runtime-verified in the authoring env (needs DB). Retention math mirrors
// apps/api/src/delivery/retentionPolicy.ts (promote to packages/shared on cleanup).

import { db } from "@connect/db";

const MIN_DAYS = 1, MAX_DAYS = 365;
const clampDays = (d: number | null | undefined) =>
  Math.max(MIN_DAYS, Math.min(MAX_DAYS, typeof d === "number" && Number.isFinite(d) ? Math.floor(d) : 30));

export async function runDeliveryRetentionCycle(): Promise<{ tenants: number; locationsDeleted: number; etaDeleted: number }> {
  const settings = await db.deliveryTenantSettings.findMany({ where: { enabled: true }, select: { tenantId: true, retentionDays: true } });
  const now = Date.now();
  let locationsDeleted = 0, etaDeleted = 0;

  for (const s of settings) {
    const days = clampDays(s.retentionDays);
    const locationCutoff = new Date(now - days * 86_400_000);
    const etaDays = Math.min(days, Math.max(7, Math.floor(days / 2)));
    const etaCutoff = new Date(now - etaDays * 86_400_000);

    const loc = await db.driverLocationSample.deleteMany({ where: { tenantId: s.tenantId, serverTs: { lt: locationCutoff } } });
    const eta = await db.etaSnapshot.deleteMany({ where: { tenantId: s.tenantId, calcAt: { lt: etaCutoff } } });
    locationsDeleted += loc.count;
    etaDeleted += eta.count;
  }

  return { tenants: settings.length, locationsDeleted, etaDeleted };
}
