// TenantResolver: maps call metadata to a platform tenantId (Connect UUID or vpbx:slug).
//
// Priority (highest first):
//   1. Inbound DID lookup via PbxTenantInboundDid cache (toNumber, then fromNumber)
//   2. VitalPBX tenant ID / T-code from dialplan channel (reliable structured data)
//   3. Explicit admin-configured context prefix map
//   4. Explicit admin-configured extension prefix map
//
// REMOVED (caused mislabeling):
//   - slug parsing from channel name (e.g. "gesheft" from PJSIP/344022_gesheft-XXXX)
//   - PJSIP @domain channel parsing
//   - vpbx:slug context extraction
//   - accountCode heuristics
//   - prefix matching from trunk name

import {
  extractPbxTenantHintsFromChannel,
  extractPbxTenantHintsFromContext,
  mergePbxTenantHints,
} from "../pbx/pbxTenantHints";
import type { PbxTenantMapCache } from "./PbxTenantMapCache";

export interface TenantResolverConfig {
  contextMap?: Record<string, string>;
  extensionPrefixMap?: Record<string, string>;
  pbxTenantMapCache?: PbxTenantMapCache | null;
}

export type TenantResolution = {
  tenantId: string | null;
  pbxVitalTenantId: string | null;
  pbxTenantCode: string | null;
  /** Human-readable Connect tenant name; populated only when resolved via DID cache. */
  tenantName: string | null;
};

export class TenantResolver {
  private contextMap: Map<string, string>;
  private prefixMap: Map<string, string>;
  private readonly mapCache: PbxTenantMapCache | null | undefined;

  constructor(cfg: TenantResolverConfig = {}) {
    this.contextMap = new Map(Object.entries(cfg.contextMap ?? {}));
    this.prefixMap = new Map(Object.entries(cfg.extensionPrefixMap ?? {}));
    this.mapCache = cfg.pbxTenantMapCache;
  }

  resolveDetails(params: {
    channel?: string;
    context?: string;
    callerIdNum?: string;
    exten?: string;
    channelVar?: string;
    dcontext?: string;
    accountCode?: string;
    /** Dialed party (e.g. callee) — matched against Ombutel inbound DID map first. */
    toNumber?: string;
    /** Caller party — second-chance DID match. */
    fromNumber?: string;
  }): TenantResolution {
    // Extract VitalPBX tenant hints from dialplan data only (not slug from channel name).
    const hints = mergePbxTenantHints(
      params.context ? extractPbxTenantHintsFromContext(params.context) : {},
      params.dcontext ? extractPbxTenantHintsFromContext(params.dcontext) : {},
      params.channel ? extractPbxTenantHintsFromChannel(params.channel) : {},
    );

    // 1. DID lookup — the only reliable way to map an inbound call to a Connect tenant.
    if (this.mapCache) {
      const byTo = this.mapCache.resolveInboundDidTenant(params.toNumber);
      if (byTo && (byTo.tenantId || byTo.pbxVitalTenantId)) return { ...byTo, tenantName: byTo.tenantName ?? null };
      const byFrom = this.mapCache.resolveInboundDidTenant(params.fromNumber);
      if (byFrom && (byFrom.tenantId || byFrom.pbxVitalTenantId)) return { ...byFrom, tenantName: byFrom.tenantName ?? null };
    }

    // 2. VitalPBX T-number lookup — structured data from dialplan (e.g. T2 → PBX tenant 2).
    //    Only resolves to a Connect UUID when PbxTenantLink exists for the tenant.
    if (this.mapCache) {
      const connectId = this.mapCache.resolveConnectTenant({
        vitalTenantId: hints.vitalTenantId,
        tenantCode: hints.tenantCode,
        dialplanT: hints.dialplanT,
      });
      if (connectId) {
        return {
          tenantId: connectId,
          pbxVitalTenantId: hints.vitalTenantId ?? hints.dialplanT ?? null,
          pbxTenantCode: hints.tenantCode ?? (hints.dialplanT ? `T${hints.dialplanT}` : null),
          tenantName: this.mapCache.getTenantName(connectId),
        };
      }

      // 2b. Slug-based fallback — resolves outbound/internal calls whose channel name
      //     contains a tenant slug (e.g. PJSIP/344022_gesheft-XXX → "gesheft") but whose
      //     DID map and T-number don't match. This covers cases where PbxTenantLink entries
      //     have null connectTenantId but DID entries carry the slug↔UUID mapping.
      if (hints.slug) {
        const slugId = this.mapCache.resolveBySlug(hints.slug);
        if (slugId) {
          return {
            tenantId: slugId,
            pbxVitalTenantId: hints.vitalTenantId ?? null,
            pbxTenantCode: hints.tenantCode ?? null,
            tenantName: this.mapCache.getTenantName(slugId),
          };
        }
      }
    }

    // 3. Explicit admin-configured context map.
    if (params.context) {
      const ctx = params.context.toLowerCase();
      for (const [prefix, tenantId] of this.contextMap) {
        if (ctx.startsWith(prefix.toLowerCase())) {
          return { tenantId, pbxVitalTenantId: null, pbxTenantCode: null, tenantName: null };
        }
      }
    }

    // 4. Explicit admin-configured extension prefix map.
    const ext = params.exten ?? params.callerIdNum ?? "";
    if (ext) {
      for (const [prefix, tenantId] of this.prefixMap) {
        if (ext.startsWith(prefix)) {
          return { tenantId, pbxVitalTenantId: null, pbxTenantCode: null, tenantName: null };
        }
      }
    }

    // Return PBX tenant metadata even when Connect UUID is unknown — useful for CDR.
    if (hints.tenantCode || hints.vitalTenantId || hints.dialplanT) {
      const code = hints.tenantCode ?? (hints.dialplanT ? `T${hints.dialplanT}` : null);
      return {
        tenantId: null,
        pbxVitalTenantId: hints.vitalTenantId ?? hints.dialplanT ?? null,
        pbxTenantCode: code,
        tenantName: null,
      };
    }

    return { tenantId: null, pbxVitalTenantId: null, pbxTenantCode: null, tenantName: null };
  }

  resolve(params: Parameters<TenantResolver["resolveDetails"]>[0]): string | null {
    return this.resolveDetails(params).tenantId;
  }

  /**
   * Returns the first inbound DID registered for the given Connect tenant UUID.
   */
  getInboundDid(tenantId: string | null | undefined): string | null {
    if (!tenantId || !this.mapCache) return null;
    return this.mapCache.getFirstDidForTenant(tenantId) ?? null;
  }

  setContextMap(map: Record<string, string>): void {
    this.contextMap = new Map(Object.entries(map));
  }

  setPrefixMap(map: Record<string, string>): void {
    this.prefixMap = new Map(Object.entries(map));
  }
}
