import { childLogger } from "../../logging/logger";
import { normalizeInboundDidDigits } from "../pbx/inboundDidDigits";

const log = childLogger("PbxTenantMapCache");

export interface PbxTenantMapCacheStats {
  /** ISO timestamp of last successful refresh, or null if never refreshed. */
  lastRefreshedAt: string | null;
  /** Number of successful refresh cycles completed. */
  refreshCount: number;
  /** Number of PBX tenant directory entries (not counting DID or extension entries). */
  entryCount: number;
  /** Number of active inbound DID → tenant mappings. */
  didCount: number;
  /** Number of unambiguous extension → tenant mappings. */
  extensionMapSize: number;
  /** Number of slug → Connect UUID mappings resolved. */
  slugMapSize: number;
  /** Last error message, if any. Cleared on next successful refresh. */
  lastError: string | null;
  /** Configured poll interval in ms. */
  pollMs: number;
}

export type PbxTenantMapEntry = {
  vitalTenantId: string;
  tenantCode: string;
  tenantSlug: string;
  connectTenantId: string | null;
};

export type PbxDidMapEntry = {
  e164: string;
  vitalTenantId: string;
  tenantCode: string;
  connectTenantId: string | null;
  tenantName: string | null;
};

export type PbxExtensionMapEntry = {
  extNumber: string;
  connectTenantId: string;
  tenantName: string | null;
};

/**
 * Fetches /internal/telephony/pbx-tenant-map from the API (same secret as CDR ingest).
 *
 * Polling interval is controlled by `pollMs` (from env `TELEPHONY_PBX_MAP_POLL_MS`, default 60 s).
 * Call `forceRefreshWithCooldown()` to schedule an out-of-band refresh after a cache miss;
 * the cooldown prevents repeated PBX/DB hammering.
 */
export class PbxTenantMapCache {
  private entries: PbxTenantMapEntry[] = [];
  private didByE164 = new Map<string, PbxDidMapEntry>();
  /** Reverse map: Connect tenant UUID → sorted list of inbound DID e164 strings for that tenant. */
  private didsByConnectId = new Map<string, string[]>();
  /** Slug → Connect tenant UUID (e.g. "gesheft" → "cmnlgnumu0001p9g6xyl1pbdd"). */
  private slugToConnectId = new Map<string, string>();
  /** Connect tenant UUID → slug for safe UI labels/fallbacks. */
  private connectIdToSlug = new Map<string, string>();
  /** Extension number → { connectTenantId, tenantName }. Unambiguous extensions only
   *  (numbers that appear under more than one tenant are intentionally omitted to
   *  prevent cross-tenant leaks). */
  private extToTenant = new Map<string, { connectTenantId: string; tenantName: string | null }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  // ── Observability fields ──────────────────────────────────────────────────
  private lastRefreshedAt: Date | null = null;
  private refreshCount = 0;
  private lastError: string | null = null;
  /** Timestamp of last `forceRefreshWithCooldown` call (to enforce cooldown). */
  private lastForcedRefreshAt = 0;

  constructor(
    private readonly mapUrl: string | undefined,
    private readonly secret: string | undefined,
    private readonly pollMs: number,
  ) {}

  getEntries(): PbxTenantMapEntry[] {
    return this.entries;
  }

  start(): void {
    if (!this.mapUrl) {
      log.info("PBX tenant map URL not configured — live tenant resolution uses AMI hints only");
      return;
    }
    this.stopped = false;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.pollMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async refresh(): Promise<void> {
    if (this.stopped || !this.mapUrl) return;
    const startedAt = Date.now();
    log.debug({ event: "pbx_tenant_map_refresh_start" }, "pbx_tenant_map_refresh_start");
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.secret) headers["x-cdr-secret"] = this.secret;
      const res = await fetch(this.mapUrl, { headers });
      if (!res.ok) {
        const msg = `HTTP ${res.status}`;
        this.lastError = msg;
        log.warn(
          { event: "pbx_tenant_map_refresh_failed", status: res.status, durationMs: Date.now() - startedAt },
          "pbx_tenant_map_refresh_failed",
        );
        return;
      }
      const body = (await res.json()) as {
        entries?: PbxTenantMapEntry[];
        didEntries?: PbxDidMapEntry[];
        extensionEntries?: PbxExtensionMapEntry[];
      };
      if (Array.isArray(body.entries)) {
        this.entries = body.entries;
      }
      const nextDid = new Map<string, PbxDidMapEntry>();
      if (Array.isArray(body.didEntries)) {
        for (const d of body.didEntries) {
          const k = (d.e164 || "").trim();
          if (k) nextDid.set(k, { ...d, tenantName: d.tenantName ?? null });
        }
        this.didByE164 = nextDid;
        // Build reverse index: connectTenantId → e164[]
        const rev = new Map<string, string[]>();
        for (const [e164, entry] of nextDid) {
          if (!entry.connectTenantId) continue;
          const list = rev.get(entry.connectTenantId) ?? [];
          list.push(e164);
          rev.set(entry.connectTenantId, list);
        }
        this.didsByConnectId = rev;

        // Build slug → UUID map from directory entries (using DID fallback for UUID lookup).
        const slugMap = new Map<string, string>();
        for (const e of this.entries) {
          if (!e.tenantSlug) continue;
          let uuid = e.connectTenantId ?? null;
          if (!uuid) {
            const code = e.tenantCode?.trim().toUpperCase();
            const vid = e.vitalTenantId;
            for (const [, did] of nextDid) {
              if (!did.connectTenantId) continue;
              if (code && did.tenantCode?.trim().toUpperCase() === code) { uuid = did.connectTenantId; break; }
              if (vid && did.vitalTenantId === vid) { uuid = did.connectTenantId; break; }
            }
          }
          if (uuid) slugMap.set(e.tenantSlug.toLowerCase(), uuid);
        }
        this.slugToConnectId = slugMap;
        const reverseSlugMap = new Map<string, string>();
        for (const [slug, connectId] of slugMap) {
          if (!reverseSlugMap.has(connectId)) reverseSlugMap.set(connectId, slug);
        }
        this.connectIdToSlug = reverseSlugMap;
      } else {
        this.didByE164 = new Map();
      }
      if (Array.isArray(body.extensionEntries)) {
        const tenantsByExt = new Map<string, Map<string, string | null>>();
        for (const e of body.extensionEntries) {
          const n = (e.extNumber || "").trim();
          if (!n || !e.connectTenantId) continue;
          const tenants = tenantsByExt.get(n) ?? new Map<string, string | null>();
          tenants.set(e.connectTenantId, e.tenantName ?? null);
          tenantsByExt.set(n, tenants);
        }
        const next = new Map<string, { connectTenantId: string; tenantName: string | null }>();
        for (const [ext, tenants] of tenantsByExt) {
          if (tenants.size !== 1) continue;
          const only = [...tenants.entries()][0];
          if (!only) continue;
          const [connectTenantId, tenantName] = only;
          if (connectTenantId) next.set(ext, { connectTenantId, tenantName: tenantName ?? null });
        }
        this.extToTenant = next;
      } else {
        this.extToTenant = new Map();
      }

      this.lastRefreshedAt = new Date();
      this.refreshCount++;
      this.lastError = null;
      log.info(
        {
          event: "pbx_tenant_map_refresh_success",
          entryCount: this.entries.length,
          didCount: nextDid.size,
          extensionMapSize: this.extToTenant.size,
          slugMapSize: this.slugToConnectId.size,
          durationMs: Date.now() - startedAt,
          refreshCount: this.refreshCount,
        },
        "pbx_tenant_map_refresh_success",
      );
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? "unknown");
      this.lastError = msg;
      log.warn(
        { event: "pbx_tenant_map_refresh_failed", err: msg, durationMs: Date.now() - startedAt },
        "pbx_tenant_map_refresh_failed",
      );
    }
  }

  /**
   * Returns a snapshot of cache statistics for diagnostics.
   * Safe to call at any time; never triggers a PBX or DB request.
   */
  getStats(): PbxTenantMapCacheStats {
    return {
      lastRefreshedAt: this.lastRefreshedAt?.toISOString() ?? null,
      refreshCount: this.refreshCount,
      entryCount: this.entries.length,
      didCount: this.didByE164.size,
      extensionMapSize: this.extToTenant.size,
      slugMapSize: this.slugToConnectId.size,
      lastError: this.lastError,
      pollMs: this.pollMs,
    };
  }

  /**
   * Schedule a one-shot immediate refresh if the last forced refresh was more than
   * `cooldownMs` ago. Designed for cache-miss handling — when telephony encounters an
   * unknown PBX tenant on a live call, call this to schedule a DB re-read without
   * hammering the API on every unresolved call.
   *
   * Safe to call from hot paths (AMI event handlers). Does not block.
   */
  forceRefreshWithCooldown(cooldownMs = 30_000): void {
    if (this.stopped || !this.mapUrl) return;
    const now = Date.now();
    if (now - this.lastForcedRefreshAt < cooldownMs) {
      log.debug(
        { event: "pbx_tenant_map_cooldown_skip", cooldownMs, msAgo: now - this.lastForcedRefreshAt },
        "pbx_tenant_map_cooldown_skip",
      );
      return;
    }
    this.lastForcedRefreshAt = now;
    log.info(
      { event: "pbx_tenant_map_force_refresh", cooldownMs },
      "pbx_tenant_map_force_refresh",
    );
    void this.refresh();
  }

  /** Prefer Connect tenant UUID when directory + link provide it. */
  resolveConnectTenant(hints: {
    vitalTenantId?: string;
    tenantCode?: string;
    dialplanT?: string;
  }): string | null {
    const code = hints.tenantCode?.trim().toUpperCase();
    const vid = hints.vitalTenantId?.trim() || hints.dialplanT?.trim();
    // Primary: directory entries (may have null connectTenantId when TenantPbxLink is missing)
    for (const e of this.entries) {
      if (code && e.tenantCode.toUpperCase() === code && e.connectTenantId) return e.connectTenantId;
      if (vid && e.vitalTenantId === vid && e.connectTenantId) return e.connectTenantId;
    }
    // Fallback: DID entries always carry connectTenantId + vitalTenantId + tenantCode.
    // This covers the common case where TenantPbxLink rows are missing but DIDs are linked.
    if (code || vid) {
      for (const [, entry] of this.didByE164) {
        if (!entry.connectTenantId) continue;
        if (code && entry.tenantCode?.trim().toUpperCase() === code) return entry.connectTenantId;
        if (vid && entry.vitalTenantId === vid) return entry.connectTenantId;
      }
    }
    return null;
  }

  /** Returns the first inbound DID e164 for the given Connect tenant UUID, or null if not found. */
  getFirstDidForTenant(connectTenantId: string): string | null {
    const dids = this.didsByConnectId.get(connectTenantId);
    return dids?.[0] ?? null;
  }

  /** Resolve Connect UUID by tenant slug (e.g. "gesheft" → UUID).
   * Tries exact match first, then normalized match (strip non-alpha, lowercase),
   * then prefix match to handle truncated SIP peer names (e.g. "comfortcont" → "comfort_control").
   */
  resolveBySlug(slug: string): string | null {
    if (!slug) return null;
    // 1. Exact lowercase match.
    const exact = this.slugToConnectId.get(slug.toLowerCase());
    if (exact) return exact;
    // 2. Normalized: strip non-alphanumeric, lowercase.
    const norm = slug.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!norm) return null;
    for (const [mapSlug, uuid] of this.slugToConnectId) {
      const mapNorm = mapSlug.toLowerCase().replace(/[^a-z0-9]/g, "");
      // Exact normalized match, or the channel slug is a prefix of the directory slug (truncated names).
      if (mapNorm === norm || mapNorm.startsWith(norm)) return uuid;
    }
    return null;
  }

  /** Returns the tenant name for a given Connect tenant UUID (sourced from didEntries). */
  getTenantName(connectTenantId: string): string | null {
    const dids = this.didsByConnectId.get(connectTenantId);
    if (!dids) return null;
    const first = this.didByE164.get(dids[0]!);
    return first?.tenantName ?? null;
  }

  /** Returns the canonical tenant slug for a Connect tenant UUID when known. */
  getTenantSlug(connectTenantId: string): string | null {
    return this.connectIdToSlug.get(connectTenantId) ?? null;
  }

  /** Extension number → Connect tenant lookup. Returns null when the extension
   *  is unknown OR ambiguous (same number registered under multiple tenants). */
  resolveExtensionTenant(extNumber: string | null | undefined): {
    tenantId: string;
    tenantName: string | null;
  } | null {
    if (!extNumber) return null;
    const hit = this.extToTenant.get(String(extNumber).trim());
    if (!hit) return null;
    return { tenantId: hit.connectTenantId, tenantName: hit.tenantName };
  }

  /** Count of unambiguous extension mappings (diagnostics). */
  getExtensionMapSize(): number {
    return this.extToTenant.size;
  }

  /** Convert any supported tenant identifier (Connect CUID, `vpbx:<slug>`, or
   *  bare slug) into the canonical Connect CUID when we have the mapping.
   *  Returns `null` when no mapping exists so callers can decide whether to
   *  fall back to the raw identifier.
   */
  normalizeToConnectId(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const v = String(raw).trim();
    if (!v) return null;
    // Already a Connect CUID if it matches any known mapping UUID.
    for (const uuid of this.slugToConnectId.values()) {
      if (uuid === v) return uuid;
    }
    for (const [, entry] of this.didByE164) {
      if (entry.connectTenantId && entry.connectTenantId === v) return v;
    }
    const slug = v.startsWith("vpbx:") ? v.slice(5) : v;
    return this.resolveBySlug(slug);
  }

  /** True when two tenant identifiers (Connect CUID, `vpbx:<slug>`, or slug)
   *  reference the same tenant. Used to filter tenant-scoped snapshots /
   *  broadcasts so a JWT carrying a Connect CUID still matches live calls
   *  ingested from CDR as `vpbx:<slug>` (and vice-versa).
   */
  tenantAliasesEqual(
    a: string | null | undefined,
    b: string | null | undefined,
  ): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    const na = this.normalizeToConnectId(a);
    const nb = this.normalizeToConnectId(b);
    if (na && nb && na === nb) return true;
    return false;
  }

  /** Ombutel-synced inbound DID → tenant (higher priority than context/trunk hints in TenantResolver). */
  resolveInboundDidTenant(rawPhone: string | null | undefined): {
    tenantId: string | null;
    pbxVitalTenantId: string | null;
    pbxTenantCode: string | null;
    tenantName: string | null;
  } | null {
    const e164 = normalizeInboundDidDigits(rawPhone);
    if (!e164) return null;
    const row = this.didByE164.get(e164);
    if (!row) return null;
    return {
      tenantId: row.connectTenantId,
      pbxVitalTenantId: row.vitalTenantId,
      pbxTenantCode: row.tenantCode?.trim().toUpperCase() || null,
      tenantName: row.tenantName ?? null,
    };
  }
}

export function derivePbxTenantMapUrl(cdrIngestUrl: string): string {
  const u = new URL(cdrIngestUrl);
  if (/\/cdr-ingest\/?$/i.test(u.pathname)) {
    u.pathname = u.pathname.replace(/\/cdr-ingest\/?$/i, "/telephony/pbx-tenant-map");
    return u.toString();
  }
  u.pathname = "/internal/telephony/pbx-tenant-map";
  return u.toString();
}
