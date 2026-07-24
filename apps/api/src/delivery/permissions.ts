// Delivery RBAC — permission keys + pure resolution helpers.
//
// Phase 2 keeps these keys local to the delivery module and resolves them from a
// small role→keys map so the backend can enforce them immediately. Phase 3 promotes
// these keys into packages/shared/src/portalPermissions.ts so they appear in the
// Connect custom-role editor and flow through hasEffectivePortalPermission().
// (No change to the shared permission registry is required for Phase 2.)

export const DELIVERY_PERMISSIONS = {
  VIEW: "view_delivery",
  DISPATCH: "dispatch_delivery",
  MANAGE_DRIVERS: "manage_drivers",
  ACCESS_PROOF: "access_delivery_proof",
  MANAGE_CONFIG: "manage_delivery_config",
  VIEW_REPORTS: "view_delivery_reports",
} as const;

export type DeliveryPermissionKey =
  (typeof DELIVERY_PERMISSIONS)[keyof typeof DELIVERY_PERMISSIONS];

/** Built-in delivery roles for Phase 2. Tenants may later refine via custom roles. */
export type DeliveryRole =
  | "TENANT_ADMIN"
  | "STORE_MANAGER"
  | "DISPATCHER"
  | "DRIVER"
  | "CUSTOMER_SERVICE"
  | "REPORTING";

const ROLE_KEYS: Record<DeliveryRole, DeliveryPermissionKey[]> = {
  TENANT_ADMIN: [
    DELIVERY_PERMISSIONS.VIEW,
    DELIVERY_PERMISSIONS.DISPATCH,
    DELIVERY_PERMISSIONS.MANAGE_DRIVERS,
    DELIVERY_PERMISSIONS.ACCESS_PROOF,
    DELIVERY_PERMISSIONS.MANAGE_CONFIG,
    DELIVERY_PERMISSIONS.VIEW_REPORTS,
  ],
  STORE_MANAGER: [
    DELIVERY_PERMISSIONS.VIEW,
    DELIVERY_PERMISSIONS.DISPATCH,
    DELIVERY_PERMISSIONS.MANAGE_DRIVERS,
    DELIVERY_PERMISSIONS.ACCESS_PROOF,
    DELIVERY_PERMISSIONS.VIEW_REPORTS,
  ],
  DISPATCHER: [
    DELIVERY_PERMISSIONS.VIEW,
    DELIVERY_PERMISSIONS.DISPATCH,
    DELIVERY_PERMISSIONS.ACCESS_PROOF, // audited (see AGENTS/audit)
    DELIVERY_PERMISSIONS.VIEW_REPORTS,
  ],
  DRIVER: [DELIVERY_PERMISSIONS.VIEW],
  CUSTOMER_SERVICE: [DELIVERY_PERMISSIONS.VIEW],
  REPORTING: [DELIVERY_PERMISSIONS.VIEW, DELIVERY_PERMISSIONS.VIEW_REPORTS],
};

/** Platform admin JWT roles that receive the full delivery key set. */
const PLATFORM_ADMIN_ROLES = new Set(["SUPER_ADMIN", "TENANT_ADMIN", "ADMIN"]);

export function isPlatformAdminRole(role: string | undefined): boolean {
  return PLATFORM_ADMIN_ROLES.has(String(role || "").toUpperCase());
}

/** Resolve the effective delivery permission set for a (jwtRole, deliveryRole). Pure. */
export function resolveDeliveryPermissions(
  jwtRole: string | undefined,
  deliveryRole: DeliveryRole | null | undefined,
): Set<DeliveryPermissionKey> {
  if (isPlatformAdminRole(jwtRole)) {
    return new Set(Object.values(DELIVERY_PERMISSIONS));
  }
  if (deliveryRole && ROLE_KEYS[deliveryRole]) {
    return new Set(ROLE_KEYS[deliveryRole]);
  }
  return new Set<DeliveryPermissionKey>();
}

/** Pure check used by route guards. */
export function hasDeliveryPermission(
  jwtRole: string | undefined,
  deliveryRole: DeliveryRole | null | undefined,
  key: DeliveryPermissionKey,
): boolean {
  return resolveDeliveryPermissions(jwtRole, deliveryRole).has(key);
}
