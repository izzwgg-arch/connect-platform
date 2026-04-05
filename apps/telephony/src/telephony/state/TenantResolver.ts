// TenantResolver: maps call/channel metadata to a platform tenantId (Connect UUID or vpbx:slug).
//
// Priority (highest first):
//   1. PbxTenantMapCache — Vital id / T8 / dialplan index → Connect tenant when linked
//   2. Explicit channel-variable override (future)
//   3. PJSIP endpoint @domain format
//   4. Context-based configured prefix map
//   5. VitalPBX context slug → vpbx:{slug}
//   6. AccountCode → vpbx:{code}
//   7. Extension prefix map

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
  }): TenantResolution {
    const hints = mergePbxTenantHints(
      params.context ? extractPbxTenantHintsFromContext(params.context) : {},
      params.dcontext ? extractPbxTenantHintsFromContext(params.dcontext) : {},
      params.channel ? extractPbxTenantHintsFromChannel(params.channel) : {},
    );

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
        };
      }
    }

    if (params.channelVar) {
      return { tenantId: params.channelVar, pbxVitalTenantId: null, pbxTenantCode: null };
    }

    if (params.channel) {
      const match = /PJSIP\/[^@]+@([^-]+)/.exec(params.channel);
      if (match) {
        return { tenantId: match[1] ?? null, pbxVitalTenantId: null, pbxTenantCode: null };
      }
    }

    if (params.context) {
      const ctx = params.context.toLowerCase();
      for (const [prefix, tenantId] of this.contextMap) {
        if (ctx.startsWith(prefix.toLowerCase())) {
          return { tenantId, pbxVitalTenantId: null, pbxTenantCode: null };
        }
      }
    }

    const contextToCheck = params.dcontext || params.context || "";
    if (contextToCheck) {
      const ctx = contextToCheck.toLowerCase();
      const VPBX_CTX_PREFIXES = [
        "ext-local-",
        "from-pstn-",
        "from-internal-",
        "from-trunk-",
        "outbound-",
        "from-external-",
      ];
      for (const pfx of VPBX_CTX_PREFIXES) {
        if (ctx.startsWith(pfx)) {
          const slug = contextToCheck.slice(pfx.length).trim();
          if (slug && !/^\d+$/.test(slug)) {
            return {
              tenantId: `vpbx:${slug}`,
              pbxVitalTenantId: hints.vitalTenantId ?? hints.dialplanT ?? null,
              pbxTenantCode: hints.tenantCode ?? null,
            };
          }
        }
      }
    }

    if (params.accountCode) {
      const code = params.accountCode.trim();
      if (code && !/^\d+$/.test(code)) {
        return {
          tenantId: `vpbx:${code}`,
          pbxVitalTenantId: null,
          pbxTenantCode: null,
        };
      }
    }

    const ext = params.exten ?? params.callerIdNum ?? "";
    if (ext) {
      for (const [prefix, tenantId] of this.prefixMap) {
        if (ext.startsWith(prefix)) {
          return { tenantId, pbxVitalTenantId: null, pbxTenantCode: null };
        }
      }
    }

    if (hints.tenantCode || hints.vitalTenantId || hints.dialplanT) {
      const code = hints.tenantCode ?? (hints.dialplanT ? `T${hints.dialplanT}` : null);
      return {
        tenantId: null,
        pbxVitalTenantId: hints.vitalTenantId ?? hints.dialplanT ?? null,
        pbxTenantCode: code,
      };
    }

    return { tenantId: null, pbxVitalTenantId: null, pbxTenantCode: null };
  }

  resolve(params: Parameters<TenantResolver["resolveDetails"]>[0]): string | null {
    return this.resolveDetails(params).tenantId;
  }

  setContextMap(map: Record<string, string>): void {
    this.contextMap = new Map(Object.entries(map));
  }

  setPrefixMap(map: Record<string, string>): void {
    this.prefixMap = new Map(Object.entries(map));
  }
}
