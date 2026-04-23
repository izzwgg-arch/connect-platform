/**
 * Tenant scope model:
 * - For SUPER_ADMIN, the switcher lists all enabled VitalPBX tenants from /admin/pbx/tenants.
 * - Each row uses ID "vpbx:{slug}" where slug is VitalPBX `name` (may be numeric); fallback "vpbx:{tenant_id}".
 * - apiClient sends x-tenant-context: vpbx:a_plus_center — backend detects this prefix and
 *   scopes PBX API calls directly to that VitalPBX tenant (bypassing tenantPbxLink lookup).
 * - Falls back to platform tenant list when VitalPBX is unreachable.
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

/** PBX slug values that look like system / lab tenants. They're only hidden
 *  when the description is *also* empty or matches one of these — otherwise a
 *  real customer whose slug happens to be "test" (e.g. Landau Home on
 *  VitalPBX uses slug="test", description="Landau Home") would be hidden. */
const SYSTEM_LIKE_SLUGS = new Set(["smoke", "billing", "test", "default", "helper", "demo", "trial", "local", "bg"]);

function isSystemLikeSlug(slug: string): boolean {
  const s = (slug || "").toLowerCase().trim();
  if (!s) return false;
  if (SYSTEM_LIKE_SLUGS.has(s)) return true;
  if (s.includes("switch smoke") || s.includes("bc switch")) return true;
  return false;
}

/** Drop a row only when BOTH the slug and the human description look like
 *  a system/lab tenant. Empty-slug rows are always hidden. */
function isExcludedPbxTenant(slug: string, description: string | undefined): boolean {
  const s = (slug || "").trim();
  if (!s) return true;
  if (!isSystemLikeSlug(s)) return false;
  // Slug is suspicious → require a non-empty, non-suspicious description to
  // keep the row. Landau Home passes this because desc="Landau Home".
  const d = (description || "").trim();
  if (!d) return true;
  if (isSystemLikeSlug(d)) return true;
  return false;
}

/** Label for the tenant picker — never drop a tenant just because VitalPBX used a numeric slug. */
function resolveDisplayName(t: VitalTenantRaw): string {
  const description = String(t.description || "").trim();
  const name = String(t.name || "").trim();
  const tid = String(t.tenant_id ?? t.id ?? "").trim();
  if (description && !/^\d+$/.test(description)) return description;
  if (name && !/^\d+$/.test(name)) {
    return name.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (name) return name;
  if (tid) return `Tenant ${tid}`;
  return "Unnamed tenant";
}

export async function loadTenantOptions(): Promise<Tenant[]> {
  try {
    // Try VitalPBX tenants first — real PBX customers.
    const pbxResult = await apiGet<{ instanceId: string; tenants: VitalTenantRaw[] }>(
      "/admin/pbx/tenants"
    ).catch(() => null);

    if (pbxResult?.tenants && Array.isArray(pbxResult.tenants) && pbxResult.tenants.length > 0) {
      const tenants: Tenant[] = [];
      for (const t of pbxResult.tenants) {
        if (t.enabled === false || t.enabled === "no") continue;

        const slug = String(t.name || "").trim();
        const tid = String(t.tenant_id ?? t.id ?? "").trim();
        const description = String(t.description || "").trim();
        if (isExcludedPbxTenant(slug, description)) continue;

        const displayName = resolveDisplayName(t);
        const id = slug ? `vpbx:${slug}` : tid ? `vpbx:${tid}` : "";
        if (!id) continue;

        tenants.push({
          id,
          name: displayName,
          plan: "Business" as const,
          status: "ACTIVE" as "ACTIVE" | "SUSPENDED",
        });
      }
      if (tenants.length > 0) {
        // Sort alphabetically by display name
        return tenants.sort((a, b) => a.name.localeCompare(b.name));
      }
    }

    // Fallback: platform tenants (when VitalPBX API is unavailable)
    const platformRows = await apiGet<PlatformTenantRow[]>("/admin/tenants").catch(() => null);
    if (!Array.isArray(platformRows)) return [];
    return platformRows
      .filter((row) => row.name)
      .map((row) => ({
        id: String(row.id || ""),
        name: row.name || "Tenant",
        plan: "Business" as const,
        status: (row.isApproved === false ? "SUSPENDED" : "ACTIVE") as "ACTIVE" | "SUSPENDED",
      }))
      .filter((t) => t.id)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
