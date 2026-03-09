import type { Tenant } from "../types/app";
import { apiGet } from "./apiClient";

export async function loadTenantOptions(): Promise<Tenant[]> {
  try {
    const payload = await apiGet<{ instanceId?: string; tenants?: Array<Record<string, unknown>> }>("/admin/pbx/tenants");
    const rows = Array.isArray(payload?.tenants) ? payload.tenants : [];
    return rows.map((row, idx) => ({
      id: String(row.id || row.tenant_id || row.uuid || `pbx-tenant-${idx}`),
      name: String(row.name || row.description || row.domain || `Tenant ${idx + 1}`),
      plan: "Business",
      status: String(row.status || "").toLowerCase().includes("suspend") ? "SUSPENDED" : "ACTIVE"
    }));
  } catch {
    return [];
  }
}
