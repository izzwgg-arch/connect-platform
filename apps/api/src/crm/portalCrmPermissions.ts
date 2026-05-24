import { db } from "@connect/db";
import {
  crmLegacyPermissionKeysForAccess,
  expandLegacyPortalPermissions,
  isCrmPortalPermissionKey,
  type PortalPermissionKey,
} from "@connect/shared";
import { getEffectivePortalPermissionSetForJwtRole } from "../platformRolePermissions";

/**
 * Role buckets may include CRM keys (e.g. tenant admin → can_manage_crm).
 * CRM nav and portal CRM routes require tenant CRM enabled and CrmUserAccess.enabled.
 */
export async function resolvePortalPermissionsWithCrmUserAccess(
  jwtRole: string | undefined,
  userId: string,
  tenantId: string | null | undefined,
): Promise<PortalPermissionKey[] | null> {
  let portalPermissionSet = await getEffectivePortalPermissionSetForJwtRole(jwtRole);
  if (!portalPermissionSet) return null;

  let crmTenantEnabled = false;
  let crmUserAccessEnabled = false;
  let crmAccessRole: string | null = null;

  if (tenantId && userId) {
    const [crmSettings, crmAccess] = await Promise.all([
      db.crmTenantSettings
        .findUnique({ where: { tenantId }, select: { enabled: true } })
        .catch(() => null),
      db.crmUserAccess
        .findUnique({
          where: { tenantId_userId: { tenantId, userId } },
          select: { enabled: true, role: true },
        })
        .catch(() => null),
    ]);
    crmTenantEnabled = Boolean(crmSettings?.enabled);
    crmUserAccessEnabled = Boolean(crmAccess?.enabled);
    crmAccessRole = crmAccess?.role ? String(crmAccess.role) : null;
  }

  portalPermissionSet = portalPermissionSet.filter((p) => !isCrmPortalPermissionKey(p));
  if (crmTenantEnabled && crmUserAccessEnabled) {
    const crmPerms = expandLegacyPortalPermissions(crmLegacyPermissionKeysForAccess(crmAccessRole));
    portalPermissionSet = [...new Set([...portalPermissionSet, ...crmPerms])] as PortalPermissionKey[];
  }

  return portalPermissionSet;
}
