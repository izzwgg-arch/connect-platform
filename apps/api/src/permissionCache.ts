/**
 * Short-TTL memo for the portal permission resolver.
 *
 * WHY THIS EXISTS
 * Every `hasEffectivePortalPermission()` call re-ran the FULL resolver, and the
 * full resolver is five database round-trips: the role snapshot, the user's
 * custom-role assignments (fetched TWICE), CRM tenant settings, and CRM user
 * access. Routes ask about several permissions in a row (voicemail asks four)
 * and one dashboard load fires 26 requests, so permission checks alone were the
 * single busiest thing in the database.
 *
 * Measured on 2026-08-06 while the portal was "very, very slow": 276
 * transactions/second but 184,000 rows read/second — about 667 rows per
 * request. The per-second sequential-scan leaders were all permission tables,
 * none index-served: UserCustomRole 18.3/s, PlatformRolePermissionSnapshot
 * 11.7/s, CustomRole 9.7/s, CrmTenantSettings 8.3/s, CrmUserAccess 7.1/s.
 * The api's own logs averaged 499ms of server time per request across 5,777
 * requests. The box was 79% idle throughout — this was never a capacity
 * problem, and no amount of hardware would have fixed it.
 *
 * ⛔ THIS IS AN AUTHORIZATION CACHE. Two rules keep it honest:
 *   1. The TTL is deliberately short, so a missed invalidation self-heals.
 *   2. Every known permission WRITE path calls invalidateAllPortalPermissions().
 *
 * ⛔ The api runs blue/green (`app-api-1` + `app-api-candidate-1`), so a write
 * served by one process CANNOT clear the other process's map. The TTL — not the
 * invalidation — is what actually bounds staleness. Do not raise it without
 * accounting for that, and do not assume an invalidation call is sufficient on
 * its own.
 *
 * Escape hatch: set PORTAL_PERMISSION_CACHE_TTL_MS=0 to disable caching
 * entirely (every lookup goes straight to the database, as before).
 *
 * KNOWN GAP (deliberate, TTL-covered): crm/checklistRoutes, crm/scriptRoutes and
 * crm/quickDispositionRoutes each upsert crmTenantSettings with `enabled: true`
 * in their CREATE branch, so writing a tenant's very first script/checklist/
 * disposition can flip CRM on as a side effect without calling an invalidator.
 * That is a once-per-tenant edge and the TTL heals it, so those three were left
 * alone rather than threaded through their transactions.
 */

const DEFAULT_TTL_MS = 15_000;
const MAX_ENTRIES = 5_000;

type Entry<T> = { expiresAt: number; value: T };

function ttlMs(): number {
  const raw = process.env.PORTAL_PERMISSION_CACHE_TTL_MS;
  if (raw == null || raw === "") return DEFAULT_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TTL_MS;
  return n;
}

/**
 * Insertion-ordered bounded TTL map. Map preserves insertion order, so evicting
 * the oldest key is just taking the first one the iterator yields.
 */
class TtlCache<T> {
  private map = new Map<string, Entry<T>>();

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, ttl: number): void {
    if (ttl <= 0) return;
    // Refresh insertion order so a hot key is not evicted ahead of a cold one.
    this.map.delete(key);
    this.map.set(key, { expiresAt: Date.now() + ttl, value });
    if (this.map.size <= MAX_ENTRIES) return;

    const now = Date.now();
    for (const [k, v] of this.map) {
      if (v.expiresAt <= now) this.map.delete(k);
    }
    while (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    for (const k of this.map.keys()) {
      if (predicate(k)) this.map.delete(k);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

const resolvedPermissions = new TtlCache<unknown>();
const roleSnapshot = new TtlCache<unknown>();

/** Cache key for a resolved permission set. Every input to the resolver must appear here. */
export function portalPermissionCacheKey(
  jwtRole: string | undefined,
  userId: string,
  tenantId: string | null | undefined,
): string {
  return `${jwtRole ?? ""}|${userId}|${tenantId ?? ""}`;
}

/**
 * Memoize a resolved permission set. `loader` runs only on a miss.
 *
 * A `null`/`undefined` result is NOT cached — those mean "resolver failed, fall
 * back to defaults", and caching a transient database failure would pin a user
 * to fallback permissions for the whole TTL.
 */
export async function withCachedPortalPermissions<T>(
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const ttl = ttlMs();
  if (ttl <= 0) return loader();

  const hit = resolvedPermissions.get(key) as T | undefined;
  if (hit !== undefined) return hit;

  const value = await loader();
  if (value != null) resolvedPermissions.set(key, value, ttl);
  return value;
}

/**
 * Memoize the platform role snapshot. It is a SINGLE global row read by every
 * permission check on the platform, which is why it deserves its own entry
 * rather than riding along on the per-user one.
 */
export async function withCachedRoleSnapshot<T>(loader: () => Promise<T>): Promise<T> {
  const ttl = ttlMs();
  if (ttl <= 0) return loader();

  const hit = roleSnapshot.get("default") as T | undefined;
  if (hit !== undefined) return hit;

  const value = await loader();
  if (value != null) roleSnapshot.set("default", value, ttl);
  return value;
}

/**
 * Drop everything. Call this from every route that writes anything a permission
 * decision reads: the role snapshot, custom roles, custom-role assignments, CRM
 * tenant settings, CRM user access.
 *
 * Clearing the whole map (rather than one user's entry) is deliberate — these
 * are rare admin actions, and a global snapshot or a custom-role edit changes
 * the answer for many users at once.
 */
export function invalidateAllPortalPermissions(): void {
  resolvedPermissions.clear();
  roleSnapshot.clear();
}

/** Drop one user's entries across every role/tenant combination they may hold. */
export function invalidatePortalPermissionsForUser(userId: string): void {
  if (!userId) return;
  resolvedPermissions.deleteWhere((k) => k.split("|")[1] === userId);
}

/** Test hook — resets all state so cases cannot leak into one another. */
export function __resetPortalPermissionCaches(): void {
  invalidateAllPortalPermissions();
}

/** Introspection for tests and diagnostics. */
export function __portalPermissionCacheStats(): { resolved: number; snapshot: number; ttlMs: number } {
  return { resolved: resolvedPermissions.size, snapshot: roleSnapshot.size, ttlMs: ttlMs() };
}
