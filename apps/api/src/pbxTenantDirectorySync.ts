import type { PrismaClient } from "@connect/db";
import type { VitalPbxClient } from "@connect/integrations";

/** VitalPBX `name` may already be "T8"; otherwise derive T{n} from numeric tenant id. */
export function deriveTenantCode(vitalTenantId: string, tenantSlug: string): string {
  const slug = tenantSlug.trim();
  if (/^T\d+$/i.test(slug)) return slug.toUpperCase();
  const id = vitalTenantId.trim();
  return id ? `T${id}` : slug.toUpperCase();
}

export async function syncPbxTenantDirectory(
  db: PrismaClient,
  pbxInstanceId: string,
  client: VitalPbxClient,
): Promise<{ upserted: number }> {
  const tenants = await client.listTenants();
  let upserted = 0;
  for (const t of tenants) {
    const vitalTenantId = String((t as { tenant_id?: unknown }).tenant_id ?? (t as { id?: unknown }).id ?? "").trim();
    const tenantSlug = String((t as { name?: unknown }).name ?? "").trim();
    if (!vitalTenantId || !tenantSlug) continue;
    const tenantCode = deriveTenantCode(vitalTenantId, tenantSlug);
    const desc = String((t as { description?: unknown }).description ?? "").trim();
    const displayName = desc || null;
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
  }
  return { upserted };
}
