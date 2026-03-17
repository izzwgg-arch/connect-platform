/**
 * Tenant scope model:
 * - For SUPER_ADMIN, the switcher shows real VitalPBX tenants (loaded from /admin/pbx/tenants).
 * - Each VitalPBX tenant gets an ID of "vpbx:{name}" (slug), e.g. "vpbx:a_plus_center".
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

/** Words that mark a name as an internal/test/helper PBX tenant — not a real customer. */
const JUNK_WORDS = ["smoke", "test", "default", "helper", "billing", "system", "demo", "trial", "internal", "local", "switch smoke", "bc switch", "bg ", "staging", "sandbox"];
/** Names that are exactly a junk token. */
const JUNK_NAME_EXACT = new Set(["admin", "smoke", "test", "default", "helper", "billing", "system", "demo", "trial", "internal", "local", "bg"]);

function isJunkTenantName(name: string): boolean {
  const lower = name.toLowerCase().trim();
  if (JUNK_NAME_EXACT.has(lower)) return true;
  // Purely numeric IDs (e.g., "1773006287") — VitalPBX internal domain IDs, not real names
  if (/^\d{6,}$/.test(lower)) return true;
  // Name contains a junk keyword (e.g., "BC Switch Smoke 1772387612")
  for (const word of JUNK_WORDS) {
    if (lower.includes(word)) return true;
  }
  // Name ends with a long numeric suffix (e.g., "SomeName 1772387612") — PBX-auto-generated
  if (/\s\d{7,}$/.test(lower)) return true;
  return false;
}

function resolveDisplayName(t: VitalTenantRaw): string | null {
  const description = String(t.description || "").trim();
  const name = String(t.name || "").trim();
  // Use description if it exists and isn't purely numeric
  if (description && !/^\d+$/.test(description)) return description;
  // Use name if it looks like a real human-readable name (not purely numeric)
  if (name && !/^\d+$/.test(name)) {
    // Convert underscores/dashes to spaces for display
    return name.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return null;
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
        // Skip disabled
        if (t.enabled === false || t.enabled === "no") continue;

        const slug = String(t.name || "").trim();
        const displayName = resolveDisplayName(t);

        // Skip if we can't resolve a real human-readable name
        if (!displayName) continue;
        // Skip internal/helper/smoke entries
        if (isJunkTenantName(displayName)) continue;
        if (slug && isJunkTenantName(slug)) continue;

        const id = slug ? `vpbx:${slug}` : String(t.tenant_id ?? t.id ?? "").trim();
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
      .filter((row) => row.name && !isJunkTenantName(row.name))
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
