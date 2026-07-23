import type { PrismaClient } from "@connect/db";
import { deriveTenantCode } from "./pbxTenantDirectorySync";

/**
 * Resolve the real VitalPBX device-name prefix (e.g. "T8") for a Connect
 * tenant, for use in admin-facing messages and live PBX lookups.
 *
 * Previously `apps/api/src/userExtensionProvisioning.ts` hardcoded the
 * literal example prefix "T7_" in its "no WebRTC device" message regardless
 * of which tenant the admin was actually looking at — every tenant except
 * VitalPBX tenant 7 saw a wrong, confusing example. This resolves the actual
 * prefix from the tenant's PBX link, falling back through the same layers
 * `pbxTenantResolve.ts` already uses for CDR tenant attribution.
 */
export async function resolveTenantPbxPrefix(db: PrismaClient, tenantId: string): Promise<string | null> {
  const link = await db.tenantPbxLink.findUnique({ where: { tenantId } });
  if (!link) return null;

  const code = (link.pbxTenantCode || "").trim();
  if (code) return code.toUpperCase();

  const vitalTenantId = (link.pbxTenantId || "").trim();
  if (!vitalTenantId) return null;

  const dir = await db.pbxTenantDirectory.findUnique({
    where: { pbxInstanceId_vitalTenantId: { pbxInstanceId: link.pbxInstanceId, vitalTenantId } },
    select: { tenantCode: true, tenantSlug: true },
  });
  if (dir?.tenantCode) return dir.tenantCode.trim().toUpperCase();

  return deriveTenantCode(vitalTenantId, dir?.tenantSlug ?? "").toUpperCase();
}
