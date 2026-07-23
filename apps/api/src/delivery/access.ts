// Per-user delivery access (Phase 3 RBAC) — mirrors CrmUserAccess.
// Absence of a row = no delivery role for that user (platform admins still bypass).

import { db } from "@connect/db";
import type { DeliveryRole } from "./permissions";

const VALID_ROLES = new Set<DeliveryRole>([
  "TENANT_ADMIN",
  "STORE_MANAGER",
  "DISPATCHER",
  "DRIVER",
  "CUSTOMER_SERVICE",
  "REPORTING",
]);

/** Load the enabled delivery role for a user, or null. */
export async function loadDeliveryRole(tenantId: string, userId: string): Promise<DeliveryRole | null> {
  const row = await db.deliveryUserAccess.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { enabled: true, role: true },
  });
  if (!row?.enabled) return null;
  const r = String(row.role) as DeliveryRole;
  return VALID_ROLES.has(r) ? r : null;
}
