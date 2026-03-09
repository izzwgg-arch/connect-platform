import type { Tenant } from "../types/app";
import { apiGet } from "./apiClient";

function normalizeTenantLabel(input: unknown): string {
  const raw = String(input || "").trim();
  if (!raw) return "Tenant";
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : ""))
    .join(" ");
}

export async function loadTenantOptions(): Promise<Tenant[]> {
  try {
    const payload = await apiGet<{ instanceId?: string; tenants?: Array<Record<string, unknown>> }>("/admin/pbx/tenants");
    const rows = Array.isArray(payload?.tenants) ? payload.tenants : [];
    return rows.map((row, idx) => ({
      id: String(row.id || row.tenant_id || row.uuid || `pbx-tenant-${idx}`),
      name: normalizeTenantLabel(row.name || row.description || row.domain || `Tenant ${idx + 1}`),
      plan: "Business",
      status: String(row.status || "").toLowerCase().includes("suspend") ? "SUSPENDED" : "ACTIVE"
    }));
  } catch {
    return [];
  }
}
