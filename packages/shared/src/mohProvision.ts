/**
 * Pure planning helpers for AUTO-PROVISIONING a tenant's hold-music surface —
 * the piece that makes agent MOH control work for ALL tenants, present and
 * future (owner mandate 2026-07-26), without touching the PBX:
 *
 *   - visibleMohCatalogForTenant — which PbxMohClass rows a tenant may use.
 *     Mirrors the runtime-readiness gate (worker + API): the tenant's own
 *     rows, unassigned rows, and the main-tenant (pbxTenantId=1) shared
 *     library are all playable by any tenant's calls.
 *   - planMissingMohProfiles — MohProfile rows to create so every usable
 *     class has a friendly name a user can say to the agent.
 *   - pickDefaultMohClass — the class that best matches what the tenant
 *     ALREADY sounds like, so a freshly bootstrapped schedule config's
 *     "back to the regular schedule" never changes the audio underfoot.
 *
 * All pure and DB-free: callers (worker provision cycle, agent MOH door)
 * supply rows and persist the plan.
 */

import { MAIN_PBX_TENANT_ID } from "./mohCatalog";

export interface MohProvisionCatalogRow {
  tenantId: string | null;
  pbxTenantId: string | null;
  mohClassName: string;
  name: string;
  isDefault: boolean | null;
  isActive: boolean | null;
  selectable: boolean | null;
}

export interface MohProvisionExistingProfile {
  name: string;
  vitalPbxMohClassName: string;
}

export interface MohProfilePlanEntry {
  name: string;
  vitalPbxMohClassName: string;
}

/**
 * Filter + dedupe the global PbxMohClass catalog down to the rows one tenant
 * may use. Inactive and explicitly non-selectable rows are dropped. When the
 * same runtime class appears more than once (tenant row + shared row), the
 * tenant-owned row wins so its display name / isDefault flag is used.
 */
export function visibleMohCatalogForTenant(
  rows: ReadonlyArray<MohProvisionCatalogRow>,
  tenantId: string,
): MohProvisionCatalogRow[] {
  const byClass = new Map<string, MohProvisionCatalogRow>();
  for (const row of rows) {
    if (!row || typeof row.mohClassName !== "string" || row.mohClassName.trim().length === 0) continue;
    if (row.isActive === false) continue;
    if (row.selectable === false) continue;
    const visible =
      row.tenantId === tenantId ||
      row.tenantId == null ||
      String(row.pbxTenantId ?? "") === MAIN_PBX_TENANT_ID;
    if (!visible) continue;
    const cls = row.mohClassName.trim();
    const prev = byClass.get(cls);
    if (!prev || (prev.tenantId !== tenantId && row.tenantId === tenantId)) {
      byClass.set(cls, row);
    }
  }
  return [...byClass.values()];
}

/** "no music" -> "No Music"; single-word names get a capital first letter. */
function profileNameFromClassName(raw: string): string {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  return s
    .split(" ")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Plan the MohProfile rows to CREATE so every visible catalog class has a
 * profile. Strictly additive and idempotent:
 *   - classes already covered by ANY existing profile (active or not) are
 *     skipped — never fight a hand-made profile;
 *   - names are deduped case-insensitively against existing profiles and
 *     earlier plan entries; a collision falls back to "Name (class)".
 */
export function planMissingMohProfiles(
  catalog: ReadonlyArray<MohProvisionCatalogRow>,
  existing: ReadonlyArray<MohProvisionExistingProfile>,
): MohProfilePlanEntry[] {
  const coveredClasses = new Set(existing.map((p) => p.vitalPbxMohClassName.trim()));
  const takenNames = new Set(existing.map((p) => p.name.trim().toLowerCase()));
  const plan: MohProfilePlanEntry[] = [];
  for (const row of catalog) {
    const cls = row.mohClassName.trim();
    if (coveredClasses.has(cls)) continue;
    let name = profileNameFromClassName(row.name) || cls;
    if (takenNames.has(name.toLowerCase())) name = `${name} (${cls})`;
    if (takenNames.has(name.toLowerCase())) continue; // degenerate double collision — skip
    takenNames.add(name.toLowerCase());
    coveredClasses.add(cls);
    plan.push({ name, vitalPbxMohClassName: cls });
  }
  return plan;
}

/**
 * The runtime class that best matches what the tenant sounds like TODAY,
 * used as the bootstrapped schedule config's default profile:
 *   1. a class the tenant owns that is flagged default,
 *   2. any class the tenant owns (they created it on the PBX — it's in use),
 *   3. the PBX-wide default (isDefault on a shared row),
 *   4. a shared row literally named "default",
 *   5. the first visible class.
 * Returns null only for an empty catalog.
 */
export function pickDefaultMohClass(catalog: ReadonlyArray<MohProvisionCatalogRow>, tenantId: string): string | null {
  const own = catalog.filter((r) => r.tenantId === tenantId && String(r.pbxTenantId ?? "") !== MAIN_PBX_TENANT_ID);
  const ownDefault = own.find((r) => r.isDefault === true);
  if (ownDefault) return ownDefault.mohClassName.trim();
  if (own.length > 0) return own[0].mohClassName.trim();
  const sharedDefault = catalog.find((r) => r.isDefault === true);
  if (sharedDefault) return sharedDefault.mohClassName.trim();
  const namedDefault = catalog.find((r) => r.name.trim().toLowerCase() === "default");
  if (namedDefault) return namedDefault.mohClassName.trim();
  return catalog.length > 0 ? catalog[0].mohClassName.trim() : null;
}
