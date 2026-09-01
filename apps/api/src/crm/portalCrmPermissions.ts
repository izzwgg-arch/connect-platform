import { db } from "@connect/db";
import {
  backfillLegacyPageVisibility,
  crmLegacyPermissionKeysForAccess,
  customRoleGrantsAccountOwner,
  expandLegacyPortalPermissions,
  isCrmPortalPermissionKey,
  type PortalPermissionKey,
} from "@connect/shared";
import {
  getEffectivePortalPermissionSetForJwtRole,
  getEffectiveCustomRolePermissions,
  jwtRoleToPortalPermissionBucket,
} from "../platformRolePermissions";
import { portalPermissionCacheKey, withCachedPortalPermissions } from "../permissionCache";

/**
 * Pure authoritative-custom-role decision (no DB) — unit-testable.
 *
 * Returns the authoritative permission set when a non-SUPER_ADMIN user has at
 * least one active custom-role permission: their effective set becomes EXACTLY
 * the union of those permissions (the built-in bucket grants nothing extra), so
 * a toggle OFF in the role is genuinely hidden. Returns `null` when the caller
 * should fall back to the normal bucket + CRM-gating behaviour (i.e. SUPER_ADMIN,
 * or a user with no custom roles). SUPER_ADMIN is never weakened.
 */
export function computeAuthoritativePortalPermissions(
  bucket: "END_USER" | "TENANT_ADMIN" | "SUPER_ADMIN",
  customPerms: readonly PortalPermissionKey[],
): PortalPermissionKey[] | null {
  if (bucket !== "SUPER_ADMIN" && customPerms.length > 0) {
    // Literal union of the granted keys (no legacy expansion — a sibling toggled
    // OFF must stay off), PLUS re-derived hidden page-visibility keys so a page
    // gated on a legacy key (e.g. can_view_calls) still loads when the admin
    // granted only the granular nav item (e.g. can_view_workspace_call_history).
    // This never widens capability/data access (those use granular keys at the
    // API layer); it only keeps page shells consistent with nav visibility.
    return backfillLegacyPageVisibility([...new Set(customPerms)]);
  }
  return null;
}

/**
 * Role buckets may include CRM keys (e.g. tenant admin → can_manage_crm).
 * CRM nav and portal CRM routes require tenant CRM enabled and CrmUserAccess.enabled.
 */
export async function resolvePortalPermissionsWithCrmUserAccess(
  jwtRole: string | undefined,
  userId: string,
  tenantId: string | null | undefined,
): Promise<PortalPermissionKey[] | null> {
  return withCachedPortalPermissions(
    portalPermissionCacheKey(jwtRole, userId, tenantId),
    () => resolvePortalPermissionsUncached(jwtRole, userId, tenantId),
  );
}

async function resolvePortalPermissionsUncached(
  jwtRole: string | undefined,
  userId: string,
  tenantId: string | null | undefined,
): Promise<PortalPermissionKey[] | null> {
  let portalPermissionSet = await getEffectivePortalPermissionSetForJwtRole(jwtRole);
  if (!portalPermissionSet) return null;

  const bucket = jwtRoleToPortalPermissionBucket(jwtRole);

  // Custom-role assignments were fetched TWICE per resolve (once for the
  // authoritative check below, once for the union near the end) — the same query
  // both times, because getEffectiveCustomRolePermissions ignores tenantId by
  // design. Fetch at most once and reuse.
  let customPermsMemo: PortalPermissionKey[] | null = null;
  const loadCustomPerms = async (): Promise<PortalPermissionKey[]> => {
    if (customPermsMemo === null) {
      customPermsMemo = await getEffectiveCustomRolePermissions(userId, tenantId);
    }
    return customPermsMemo;
  };

  // ── Authoritative custom roles ──────────────────────────────────────────────
  // If a non-SUPER_ADMIN user has one or more ACTIVE custom roles assigned, those
  // roles become the AUTHORITATIVE definition of what the user can see/do: their
  // effective permission set is EXACTLY the union of the assigned roles'
  // permissions. The built-in role bucket no longer grants anything on its own,
  // so a permission toggled OFF in the role is genuinely hidden (ON = visible,
  // OFF = hidden — deterministic).
  //
  // The role's `permissions` array already holds the explicit granular keys the
  // admin toggled (sections + items + action keys), so we use it LITERALLY with
  // no legacy expansion — expansion would silently re-enable sibling permissions
  // the admin deliberately left off.
  //
  // SUPER_ADMIN is exempt and always retains its full set (it can never be
  // weakened by a custom role), so platform owners can never lock themselves out.
  if (bucket !== "SUPER_ADMIN" && userId) {
    const customPerms = await loadCustomPerms();
    // ── Account owner ────────────────────────────────────────────────
    // A role carrying the owner key does NOT become authoritative-literal — it
    // widens instead: the holder's base set becomes the LIVE TENANT_ADMIN
    // bucket (so pages added to that bucket in the future reach owners with no
    // re-save), then falls through to the ordinary CRM gating and the tail
    // union of the role's explicit keys. ⛔ Never satisfy this from the
    // holder's own bucket — a USER-jwt owner must still resolve TENANT_ADMIN.
    if (customRoleGrantsAccountOwner(customPerms)) {
      const ownerSet = await getEffectivePortalPermissionSetForJwtRole("TENANT_ADMIN");
      if (ownerSet) {
        portalPermissionSet = [...new Set([...portalPermissionSet, ...ownerSet])] as PortalPermissionKey[];
      }
    } else {
      const authoritative = computeAuthoritativePortalPermissions(bucket, customPerms);
      if (authoritative) return authoritative;
    }
  }

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

  if (userId && tenantId) {
    const customPerms = await loadCustomPerms();
    if (customPerms.length > 0) {
      portalPermissionSet = [...new Set([...portalPermissionSet, ...customPerms])] as PortalPermissionKey[];
    }
  }

  return portalPermissionSet;
}
