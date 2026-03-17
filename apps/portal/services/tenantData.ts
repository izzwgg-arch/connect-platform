/**
 * Tenant scope model:
 * - For SUPER_ADMIN, the switcher shows real VitalPBX tenants (loaded once from /admin/pbx/tenants).
 * - Each VitalPBX tenant gets an ID of "vpbx:{name}" (slug), e.g. "vpbx:a_plus_center".
 * - apiClient sends x-tenant-context: vpbx:a_plus_center — backend detects the prefix and
 *   scopes PBX API calls directly to that VitalPBX tenant (bypassing the broken tenantPbxLink lookup).
 * - If VitalPBX is unreachable, falls back to platform tenant list.
 * - Non-admin users are always scoped to their own JWT tenantId.
 */
import type { Tenant } from "../types/app";
import { apiGet } from "./apiClient";

type PlatformTenantRow = {
  id: string;
  name: string;
  pbxTenantId: string | null;
  pbxInstanceId: string | null;
  isApproved: boolean | null;
};

type VitalTenantRaw = {
  tenant_id?: number | string;
  id?: number | string;
  name?: string;
  description?: string;
  enabled?: boolean | string;
  [key: string]: unknown;
};

export async function loadTenantOptions(): Promise<Tenant[]> {
  try {
    // Try VitalPBX tenants first — these are the real PBX customers with proper names.
    const pbxResult = await apiGet<{ instanceId: string; tenants: VitalTenantRaw[] }>(
      "/admin/pbx/tenants"
    ).catch(() => null);

    if (pbxResult?.tenants && Array.isArray(pbxResult.tenants) && pbxResult.tenants.length > 0) {
      // ID format: "vpbx:{slug}" — backend detects this prefix and bypasses the broken
      // tenantPbxLink lookup, using the slug directly as the VitalPBX tenant filter.
      return pbxResult.tenants
        .filter((t) => t.enabled !== false && t.enabled !== "no")
        .map((t) => {
          const slug = String(t.name || "").trim();
          const displayName = String(t.description || t.name || "Tenant").trim();
          const id = slug ? `vpbx:${slug}` : String(t.tenant_id ?? t.id ?? "").trim();
          return {
            id,
            name: displayName || slug || id,
            plan: "Business" as const,
            status: "ACTIVE" as "ACTIVE" | "SUSPENDED",
          };
        })
        .filter((t) => t.id);
    }

    // Fallback: platform tenants (used when VitalPBX API is unavailable)
    const platformRows = await apiGet<PlatformTenantRow[]>("/admin/tenants").catch(() => null);
    if (!Array.isArray(platformRows)) return [];
    return platformRows
      .map((row) => ({
        id: String(row.id || ""),
        name: row.name || "Tenant",
        plan: "Business" as const,
        status: (row.isApproved === false ? "SUSPENDED" : "ACTIVE") as "ACTIVE" | "SUSPENDED",
      }))
      .filter((t) => t.id);
  } catch {
    return [];
  }
}
