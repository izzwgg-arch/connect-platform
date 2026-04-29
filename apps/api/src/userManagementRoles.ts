/**
 * User-management role bucketing.
 *
 * The portal Permissions page works in THREE portal buckets:
 *   END_USER | TENANT_ADMIN | SUPER_ADMIN
 * The DB `UserRole` enum has richer values (USER, EXTENSION_USER, ADMIN, BILLING, ...).
 *
 * To keep Admin → Users and Admin → Permissions aligned, both surfaces speak in
 * portal buckets. This module is the single source of truth for the mapping:
 *
 *   - portalBucketFromJwtRole()   — DB/JWT role  -> portal bucket   (read)
 *   - dbRoleFromPortalBucket()    — portal bucket -> DB role        (write)
 *
 * Downstream DB rows and JWTs still carry the richer DB role, so the billing
 * admin experience etc. is unchanged; the Users UI just doesn't fragment the
 * dropdown into nine values that overlap with only three permission columns.
 */

export const PORTAL_ROLE_BUCKETS = ["END_USER", "TENANT_ADMIN", "SUPER_ADMIN"] as const;
export type PortalRoleBucket = typeof PORTAL_ROLE_BUCKETS[number];

const PORTAL_ROLE_LABELS: Record<PortalRoleBucket, string> = {
  END_USER: "End User",
  TENANT_ADMIN: "Tenant Admin",
  SUPER_ADMIN: "Platform Admin",
};

export function portalBucketLabel(bucket: PortalRoleBucket): string {
  return PORTAL_ROLE_LABELS[bucket];
}

export function portalBucketFromJwtRole(jwtRole: string | undefined | null): PortalRoleBucket {
  const r = String(jwtRole || "").toUpperCase();
  if (r === "SUPER_ADMIN") return "SUPER_ADMIN";
  if (r === "TENANT_ADMIN") return "TENANT_ADMIN";
  if (["ADMIN", "BILLING", "BILLING_ADMIN", "MESSAGING", "SUPPORT", "MANAGER"].includes(r)) {
    return "TENANT_ADMIN";
  }
  return "END_USER";
}

/**
 * Map a portal bucket chosen in the Users UI back to a DB UserRole enum value.
 *
 * END_USER     → USER          (plain tenant user, owns their extension)
 * TENANT_ADMIN → TENANT_ADMIN  (explicit; manages their own tenant)
 * SUPER_ADMIN  → SUPER_ADMIN   (platform operator; gated in canAssignPortalBucket)
 */
export function dbRoleFromPortalBucket(bucket: PortalRoleBucket): string {
  switch (bucket) {
    case "SUPER_ADMIN":
      return "SUPER_ADMIN";
    case "TENANT_ADMIN":
      return "TENANT_ADMIN";
    case "END_USER":
    default:
      return "USER";
  }
}

/**
 * Permission check: can an actor assign a target portal bucket on create/edit?
 * - SUPER_ADMIN can assign any bucket
 * - Everyone else (including TENANT_ADMIN) cannot create SUPER_ADMINs
 */
export function canAssignPortalBucket(actorRole: string | undefined, target: PortalRoleBucket): boolean {
  const actorBucket = portalBucketFromJwtRole(actorRole);
  if (actorBucket === "SUPER_ADMIN") return true;
  return target !== "SUPER_ADMIN";
}
