/**
 * Linked-SIP cross-tenant call visibility (per-tenant switch:
 * Tenant.linkedSipCallVisibilityEnabled).
 *
 * A UserSipAccount row can attach an extension from ANOTHER tenant to one of
 * this tenant's users (one physical phone registering lines from two
 * companies). When the home tenant's switch is ON, its tenant-wide call
 * viewers also see call history — and may play recordings — for exactly those
 * foreign extensions, inside the foreign tenant, and nothing else there.
 *
 * This module holds the pure logic (grouping + row matching) so it can be
 * unit-tested without a database; server.ts owns the DB loading.
 */

export type LinkedSipCallScope = {
  /** tenantId forms CDR rows of the FOREIGN tenant may be stored under (cuid and/or "vpbx:{slug}"). */
  tenantKeys: string[];
  /** Extension numbers inside that foreign tenant that are visible to the home tenant. */
  extensions: string[];
};

export type LinkedSipAccountRowLite = {
  /** Tenant the linked extension belongs to (UserSipAccount.tenantId). */
  tenantId: string | null | undefined;
  extNumber: string | null | undefined;
  extStatus?: string | null;
};

/**
 * Group raw UserSipAccount rows into foreignTenantId -> extension numbers.
 * Rows pointing back at the home tenant, inactive extensions, and blank
 * extension numbers are dropped — only genuine cross-tenant, live lines count.
 */
export function groupLinkedSipAccountRows(
  homeTenantId: string,
  rows: LinkedSipAccountRowLite[],
): Map<string, string[]> {
  const byTenant = new Map<string, Set<string>>();
  for (const row of rows) {
    const foreignTenantId = String(row.tenantId || "").trim();
    if (!foreignTenantId || foreignTenantId === homeTenantId) continue;
    if (row.extStatus != null && row.extStatus !== "ACTIVE") continue;
    const ext = String(row.extNumber || "").replace(/\D/g, "").trim();
    if (!ext) continue;
    let set = byTenant.get(foreignTenantId);
    if (!set) { set = new Set(); byTenant.set(foreignTenantId, set); }
    set.add(ext);
  }
  const out = new Map<string, string[]>();
  for (const [tenantId, exts] of byTenant) out.set(tenantId, [...exts].sort());
  return out;
}

export type CdrRowLite = {
  tenantId?: string | null;
  fromNumber?: string | null;
  toNumber?: string | null;
  channelsSeen?: unknown;
  dcontextsSeen?: unknown;
  dcontext?: string | null;
};

/**
 * Same matching semantics as server.ts's cdrRowMatchesExtensions: exact
 * digits match on from/to, else a digit-boundary regex over the channel and
 * dialplan-context evidence (queue/ring-group calls carry the extension only
 * in channelsSeen, e.g. "PJSIP/T11_102_1-...").
 */
export function cdrRowMatchesExtensionNumbers(row: CdrRowLite, extensionNumbers: string[]): boolean {
  const exts = [...new Set(extensionNumbers.map((ext) => String(ext || "").replace(/\D/g, "").trim()).filter(Boolean))];
  if (exts.length === 0) return false;
  const fromDigits = String(row.fromNumber || "").replace(/\D/g, "");
  const toDigits = String(row.toNumber || "").replace(/\D/g, "");
  if (exts.includes(fromDigits) || exts.includes(toDigits)) return true;
  const channels = Array.isArray(row.channelsSeen) ? row.channelsSeen.map(String) : [];
  const dcontexts = Array.isArray(row.dcontextsSeen) ? row.dcontextsSeen.map(String) : [];
  const haystack = [...channels, ...dcontexts, String(row.dcontext || "")].join(" ");
  return exts.some((ext) => new RegExp(`(^|[^0-9])${ext}([^0-9]|$)`).test(haystack));
}

/**
 * Is this CDR row visible through one of the linked scopes? The row must sit
 * under a scope's foreign tenant AND involve one of that scope's extensions —
 * membership in the foreign tenant alone is never enough.
 */
export function cdrRowInLinkedSipScopes(row: CdrRowLite, scopes: LinkedSipCallScope[]): boolean {
  const rowTenant = String(row.tenantId || "").trim();
  if (!rowTenant) return false;
  for (const scope of scopes) {
    if (!scope.tenantKeys.includes(rowTenant)) continue;
    if (cdrRowMatchesExtensionNumbers(row, scope.extensions)) return true;
  }
  return false;
}
