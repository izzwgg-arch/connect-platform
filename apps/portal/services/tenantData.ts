/**
 * Tenant scope model:
 * - tenantId in the JWT is always the platform tenant ID (db.Tenant).
 * - All backend PBX routes scope data by JWT tenantId via tenantPbxLink.
 * - SUPER_ADMIN in GLOBAL scope calls /admin/pbx/live/* to aggregate all tenants.
 * - SUPER_ADMIN in TENANT scope calls /pbx/live/* scoped to their JWT tenantId.
 * - Non-admin users are always TENANT scoped to their own tenantId.
 * - The tenant switcher populates from platform tenants (/admin/tenants),
 *   not from VitalPBX tenants, so IDs match what the backend expects.
 */
import type { Tenant } from "../types/app";
import { apiGet } from "./apiClient";

export async function loadTenantOptions(): Promise<Tenant[]> {
  try {
    const rows = await apiGet<Array<Record<string, unknown>>>("/admin/tenants");
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
      id: String(row.id || ""),
      name: String(row.name || "Tenant"),
      plan: "Business" as const,
      status: row.isApproved === false ? "SUSPENDED" : "ACTIVE"
    })).filter((t) => t.id);
  } catch {
    return [];
  }
}
