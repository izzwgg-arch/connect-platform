import { childLogger } from "../../logging/logger";
import { normalizeInboundDidDigits } from "../pbx/inboundDidDigits";

const log = childLogger("PbxTenantMapCache");

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
 */
export class PbxTenantMapCache {
  private entries: PbxTenantMapEntry[] = [];
  private didByE164 = new Map<string, PbxDidMapEntry>();
  /** Reverse map: Connect tenant UUID → sorted list of inbound DID e164 strings for that tenant. */
  private didsByConnectId = new Map<string, string[]>();
  /** Slug → Connect tenant UUID (e.g. "gesheft" → "cmnlgnumu0001p9g6xyl1pbdd"). */
  private slugToConnectId = new Map<string, string>();
  /** Extension number → { connectTenantId, tenantName }. Unambiguous extensions only
   *  (numbers that appear under more than one tenant are intentionally omitted to
   *  prevent cross-tenant leaks). */
  private extToTenant = new Map<string, { connectTenantId: string; tenantName: string | null }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

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
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.secret) headers["x-cdr-secret"] = this.secret;
      const res = await fetch(this.mapUrl, { headers });
      if (!res.ok) {
        log.warn({ status: res.status }, "pbx-tenant-map fetch failed");
        return;
      }
      const body = (await res.json()) as {
        entries?: PbxTenantMapEntry[];
        didEntries?: PbxDidMapEntry[];
        extensionEntries?: PbxExtensionMapEntry[];
      };
      if (Array.isArray(body.entries)) {
        this.entries = body.entries;
        log.debug({ count: this.entries.length }, "pbx-tenant-map refreshed");
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
        log.debug({ didCount: nextDid.size }, "pbx-tenant-map DID entries refreshed");

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
        log.debug({ slugCount: slugMap.size }, "pbx-tenant-map slug index built");
      } else {
        this.didByE164 = new Map();
      }
      if (Array.isArray(body.extensionEntries)) {
        const next = new Map<string, { connectTenantId: string; tenantName: string | null }>();
        for (const e of body.extensionEntries) {
          const n = (e.extNumber || "").trim();
          if (!n || !e.connectTenantId) continue;
          next.set(n, { connectTenantId: e.connectTenantId, tenantName: e.tenantName ?? null });
        }
        this.extToTenant = next;
        log.debug({ extCount: next.size }, "pbx-tenant-map extension entries refreshed");
      } else {
        this.extToTenant = new Map();
      }
    } catch (err: any) {
      log.warn({ err: err?.message }, "pbx-tenant-map refresh error");
    }
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
