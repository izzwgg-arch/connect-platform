// Delivery route guards — Phase 3 (adds per-user delivery RBAC via DeliveryUserAccess).
// REPLACES the Phase 2 guard.ts. Mirrors apps/api/src/crm/guard.ts conventions.

import { db } from "@connect/db";
import { hasDeliveryPermission, isPlatformAdminRole, type DeliveryPermissionKey, DELIVERY_PERMISSIONS } from "./permissions";
import { loadDeliveryRole } from "./access";

export type DeliveryAuthUser = { sub: string; tenantId: string; role?: string };

export function resolveEffectiveDeliveryTenantId(req: any, user: DeliveryAuthUser): string {
  if (user.role !== "SUPER_ADMIN") return user.tenantId;
  const headerTenant = String(req.headers?.["x-tenant-context"] || "").trim();
  if (headerTenant && !headerTenant.startsWith("vpbx:") && headerTenant !== "local") return headerTenant;
  return user.tenantId;
}

function withEffectiveTenant(req: any, user: DeliveryAuthUser): DeliveryAuthUser {
  const tenantId = resolveEffectiveDeliveryTenantId(req, user);
  return tenantId === user.tenantId ? user : { ...user, tenantId };
}

/** Tenant must have the delivery feature enabled. */
export async function requireDeliveryEnabled(req: any, reply: any): Promise<DeliveryAuthUser | null> {
  const raw = req.user as DeliveryAuthUser | undefined;
  if (!raw?.sub) {
    reply.status(401).send({ error: "unauthorized" });
    return null;
  }
  const user = withEffectiveTenant(req, raw);
  if (!user.tenantId) {
    reply.status(400).send({ error: "no_tenant" });
    return null;
  }
  const settings = await db.deliveryTenantSettings.findUnique({
    where: { tenantId: user.tenantId },
    select: { enabled: true },
  });
  if (!settings?.enabled) {
    reply.status(403).send({ error: "delivery_not_enabled", detail: "Delivery is not enabled for this tenant" });
    return null;
  }
  return user;
}

/** Generic permission gate: platform admin OR the user's delivery role holds `key`. */
export async function requireDeliveryPermission(
  req: any,
  reply: any,
  key: DeliveryPermissionKey,
): Promise<DeliveryAuthUser | null> {
  const user = await requireDeliveryEnabled(req, reply);
  if (!user) return null;
  if (isPlatformAdminRole(user.role)) return user;
  const deliveryRole = await loadDeliveryRole(user.tenantId, user.sub);
  if (hasDeliveryPermission(user.role, deliveryRole, key)) return user;
  reply.status(403).send({ error: "delivery_permission_denied", detail: `missing ${key}` });
  return null;
}

/** Dispatch/management surface. */
export function requireDeliveryDispatch(req: any, reply: any) {
  return requireDeliveryPermission(req, reply, DELIVERY_PERMISSIONS.DISPATCH);
}

/** Config write surface (tenant admins). */
export function requireDeliveryConfig(req: any, reply: any) {
  return requireDeliveryPermission(req, reply, DELIVERY_PERMISSIONS.MANAGE_CONFIG);
}

/** Driver management surface. */
export function requireDeliveryDriverAdmin(req: any, reply: any) {
  return requireDeliveryPermission(req, reply, DELIVERY_PERMISSIONS.MANAGE_DRIVERS);
}

export interface DriverContext {
  user: DeliveryAuthUser;
  driver: { id: string; status: string; storeIds: string[] };
}

/** Driver-app routes: requires an active DriverProfile. */
export async function requireDriver(req: any, reply: any): Promise<DriverContext | null> {
  const user = await requireDeliveryEnabled(req, reply);
  if (!user) return null;
  const profile = await db.driverProfile.findUnique({
    where: { tenantId_userId: { tenantId: user.tenantId, userId: user.sub } },
    select: { id: true, status: true, active: true, stores: { select: { storeId: true } } },
  });
  if (!profile || !profile.active) {
    reply.status(403).send({ error: "not_a_driver", detail: "No active driver profile for this user" });
    return null;
  }
  return { user, driver: { id: profile.id, status: profile.status, storeIds: profile.stores.map((s) => s.storeId) } };
}

/** Internal Order-source shared secret (mock adapter ingest + real webhook later). */
export function verifyOrderSourceSecret(req: any): boolean {
  const expected = String(process.env.DELIVERY_ORDER_SOURCE_SECRET || "");
  if (!expected) return false;
  const got = String(req.headers?.["x-delivery-source-secret"] || "");
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
