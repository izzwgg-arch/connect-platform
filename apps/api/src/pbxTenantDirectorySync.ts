import type { PrismaClient } from "@connect/db";
import type { VitalPbxClient } from "@connect/integrations";

/** VitalPBX `name` may already be "T8"; otherwise derive T{n} from numeric tenant id. */
export function deriveTenantCode(vitalTenantId: string, tenantSlug: string): string {
  const slug = tenantSlug.trim();
  if (/^T\d+$/i.test(slug)) return slug.toUpperCase();
  const id = vitalTenantId.trim();
  return id ? `T${id}` : slug.toUpperCase();
}

export interface PbxTenantDirectorySyncResult {
  /** Total rows processed (skipped rows with missing id/slug are excluded). */
  upserted: number;
  /** Rows that did not exist before this sync (new PBX tenants). */
  created: number;
  /** Rows that already existed and were updated. */
  updated: number;
  /** Local directory rows removed because VitalPBX no longer returns them. */
  deleted: number;
}

export async function syncPbxTenantDirectoryFromRows(
  db: PrismaClient,
  pbxInstanceId: string,
  tenants: unknown[],
): Promise<PbxTenantDirectorySyncResult> {
  let upserted = 0;
  let created = 0;
  let updated = 0;
  const seenVitalTenantIds = new Set<string>();
  for (const t of tenants) {
    const vitalTenantId = String((t as { tenant_id?: unknown }).tenant_id ?? (t as { id?: unknown }).id ?? "").trim();
    const tenantSlug = String((t as { name?: unknown }).name ?? "").trim();
    if (!vitalTenantId || !tenantSlug) continue;
    seenVitalTenantIds.add(vitalTenantId);
    const tenantCode = deriveTenantCode(vitalTenantId, tenantSlug);
    const desc = String((t as { description?: unknown }).description ?? "").trim();
    const displayName = desc || null;
    const existing = await db.pbxTenantDirectory.findUnique({
      where: { pbxInstanceId_vitalTenantId: { pbxInstanceId, vitalTenantId } },
      select: { id: true, tenantSlug: true, tenantCode: true, displayName: true },
    });
    await db.pbxTenantDirectory.upsert({
      where: {
        pbxInstanceId_vitalTenantId: { pbxInstanceId, vitalTenantId },
      },
      create: {
        pbxInstanceId,
        vitalTenantId,
        tenantSlug,
        tenantCode,
        displayName,
      },
      update: {
        tenantSlug,
        tenantCode,
        displayName,
        syncedAt: new Date(),
      },
    });
    upserted++;
    if (existing) {
      if (
        existing.tenantSlug !== tenantSlug ||
        existing.tenantCode !== tenantCode ||
        (existing.displayName ?? null) !== displayName
      ) {
        updated++;
      }
    } else {
      created++;
    }
  }

  // Mirror VitalPBX exactly for this instance: if a tenant disappeared from PBX,
  // remove it from the local directory so switchers, routing hints, and diagnostics
  // do not keep showing a stale PBX tenant. Guard against malformed/empty payloads
  // so a bad PBX response cannot wipe the whole directory.
  let deleted = 0;
  if (seenVitalTenantIds.size > 0) {
    const result = await db.pbxTenantDirectory.deleteMany({
      where: {
        pbxInstanceId,
        vitalTenantId: { notIn: Array.from(seenVitalTenantIds) },
      },
    });
    deleted = result.count;
  }

  return { upserted, created, updated, deleted };
}

export async function syncPbxTenantDirectory(
  db: PrismaClient,
  pbxInstanceId: string,
  client: VitalPbxClient,
): Promise<PbxTenantDirectorySyncResult> {
  const tenants = await client.listTenants();
  return syncPbxTenantDirectoryFromRows(db, pbxInstanceId, tenants);
}
