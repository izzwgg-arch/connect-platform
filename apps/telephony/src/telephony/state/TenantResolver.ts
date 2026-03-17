// TenantResolver: maps call/channel metadata to a platform tenantId.
//
// Strategy priority (highest first):
//   1. Explicit channel-variable override  (future: VarSet AMI event)
//   2. PJSIP endpoint @domain format:      PJSIP/1001@tenant-00000001
//   3. Context-based lookup                (configurable prefix map)
//   4. Extension prefix / numbering-plan   (configurable range map)
//   5. Null fallback                       (admin tenant sees everything)
//
// TODO: Add a strategy that queries the VitalPBX /api/v2/tenants list and
//       builds a cached context→tenantId map on startup + periodic refresh.

export interface TenantResolverConfig {
  // Map of AMI context prefix → tenantId
  // e.g. { "from-internal-tenant-a": "tenant-a", "ext-local-b": "tenant-b" }
  contextMap?: Record<string, string>;

  // Extension number prefix → tenantId
  // e.g. { "1": "tenant-a", "2": "tenant-b" }
  extensionPrefixMap?: Record<string, string>;
}

export class TenantResolver {
  private contextMap: Map<string, string>;
  private prefixMap: Map<string, string>;

  constructor(cfg: TenantResolverConfig = {}) {
    this.contextMap = new Map(Object.entries(cfg.contextMap ?? {}));
    this.prefixMap = new Map(Object.entries(cfg.extensionPrefixMap ?? {}));
  }

  resolve(params: {
    channel?: string;
    context?: string;
    callerIdNum?: string;
    exten?: string;
    channelVar?: string;
  }): string | null {
    // 1. Explicit override via channel variable (e.g. CC_TENANT_ID)
    if (params.channelVar) return params.channelVar;

    // 2. PJSIP channel @domain extraction: PJSIP/ext@domain-uniqueid
    if (params.channel) {
      const match = /PJSIP\/[^@]+@([^-]+)/.exec(params.channel);
      if (match) return match[1] ?? null;
    }

    // 3. Context-based lookup
    if (params.context) {
      const ctx = params.context.toLowerCase();
      for (const [prefix, tenantId] of this.contextMap) {
        if (ctx.startsWith(prefix.toLowerCase())) return tenantId;
      }
    }

    // 4. Extension prefix
    const ext = params.exten ?? params.callerIdNum ?? "";
    if (ext) {
      for (const [prefix, tenantId] of this.prefixMap) {
        if (ext.startsWith(prefix)) return tenantId;
      }
    }

    // 5. No match — caller sees a null tenantId (admin-scoped)
    return null;
  }

  // Update maps at runtime without restarting (for future API-driven refresh)
  setContextMap(map: Record<string, string>): void {
    this.contextMap = new Map(Object.entries(map));
  }

  setPrefixMap(map: Record<string, string>): void {
    this.prefixMap = new Map(Object.entries(map));
  }
}
