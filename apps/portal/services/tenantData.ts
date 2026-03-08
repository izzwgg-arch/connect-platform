import type { Tenant } from "../types/app";
import { apiGet } from "./apiClient";
import { mockTenants } from "./mockData";

type AdminTenantRow = {
  id: string;
  name: string;
  isApproved?: boolean;
};

export async function loadTenantOptions(): Promise<Tenant[]> {
  try {
    const rows = await apiGet<AdminTenantRow[]>("/admin/tenants");
    if (!Array.isArray(rows) || rows.length === 0) return mockTenants;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name || "Tenant"),
      plan: "Business",
      status: row.isApproved === false ? "SUSPENDED" : "ACTIVE"
    }));
  } catch {
    return mockTenants;
  }
}
