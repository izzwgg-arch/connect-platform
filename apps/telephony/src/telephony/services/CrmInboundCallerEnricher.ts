import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { CrmInboundCallFields, NormalizedCall } from "../types";
import type { WsClient } from "../websocket/TelephonySocketServer";

const log = childLogger("CrmInboundCallerEnricher");

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 2_000;

type CacheEntry = { at: number; match: CrmInboundCallFields | null };

function deriveMatchUrl(cdrIngestUrl: string): string | undefined {
  try {
    const u = new URL(cdrIngestUrl);
    if (/\/cdr-ingest\/?$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/cdr-ingest\/?$/i, "/telephony/inbound-crm-match");
      return u.toString();
    }
    u.pathname = "/internal/telephony/inbound-crm-match";
    return u.toString();
  } catch {
    return undefined;
  }
}

function looksInternalExtension(num: string): boolean {
  const d = num.replace(/\D/g, "");
  return d.length >= 2 && d.length <= 6;
}

function inboundCallerPhone(call: NormalizedCall): string | null {
  if (call.direction !== "inbound") return null;
  const from = call.from?.trim();
  if (!from || looksInternalExtension(from)) return null;
  return from;
}

function effectiveTenantId(call: NormalizedCall, client: WsClient): string | null {
  return call.tenantId ?? client.tenantId;
}

export class CrmInboundCallerEnricher {
  private readonly url: string | undefined;
  private readonly secret: string | undefined;
  private readonly cache = new Map<string, CacheEntry>();

  constructor() {
    this.url = env.CDR_INGEST_URL ? deriveMatchUrl(env.CDR_INGEST_URL) : undefined;
    this.secret = env.CDR_INGEST_SECRET;
    if (!this.url) {
      log.info("CDR_INGEST_URL not set — inbound CRM caller enrichment disabled");
    }
  }

  enabled(): boolean {
    return !!this.url && !!this.secret;
  }

  /**
   * Returns a shallow copy of `call` with optional CRM fields for this viewer.
   * Never throws; failures leave the call unchanged.
   */
  async enrichForClient(call: NormalizedCall, client: WsClient): Promise<NormalizedCall> {
    if (!this.enabled()) return call;
    const phone = inboundCallerPhone(call);
    const tenantId = effectiveTenantId(call, client);
    if (!phone || !tenantId || !client.userId) return call;

    const cacheKey = `${tenantId}|${client.userId}|${phone}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.match ? { ...call, ...cached.match } : call;
    }

    let match: CrmInboundCallFields | null = null;
    try {
      const res = await fetch(this.url!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cdr-secret": this.secret!,
        },
        body: JSON.stringify({
          tenantId,
          phone,
          viewer: { userId: client.userId, role: client.role || undefined },
        }),
        signal: AbortSignal.timeout(2_500),
      });
      if (res.ok) {
        const body = (await res.json()) as { match?: CrmInboundCallFields | null };
        if (body.match?.crmContactId && body.match.crmContactName && body.match.crmProfileUrl) {
          match = body.match;
        }
      }
    } catch (err) {
      log.debug(
        { err: err instanceof Error ? err.message : String(err), tenantId, callId: call.id },
        "inbound CRM match fetch failed",
      );
    }

    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(cacheKey, { at: Date.now(), match });

    return match ? { ...call, ...match } : call;
  }

  async enrichCallsForClient(calls: NormalizedCall[], client: WsClient): Promise<NormalizedCall[]> {
    if (!this.enabled()) return calls;
    return Promise.all(calls.map((c) => this.enrichForClient(c, client)));
  }
}
