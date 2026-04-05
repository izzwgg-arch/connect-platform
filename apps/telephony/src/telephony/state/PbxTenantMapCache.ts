import { childLogger } from "../../logging/logger";

const log = childLogger("PbxTenantMapCache");

export type PbxTenantMapEntry = {
  vitalTenantId: string;
  tenantCode: string;
  tenantSlug: string;
  connectTenantId: string | null;
};

/**
 * Fetches /internal/telephony/pbx-tenant-map from the API (same secret as CDR ingest).
 */
export class PbxTenantMapCache {
  private entries: PbxTenantMapEntry[] = [];
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
      const body = (await res.json()) as { entries?: PbxTenantMapEntry[] };
      if (Array.isArray(body.entries)) {
        this.entries = body.entries;
        log.debug({ count: this.entries.length }, "pbx-tenant-map refreshed");
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
    for (const e of this.entries) {
      if (code && e.tenantCode.toUpperCase() === code && e.connectTenantId) return e.connectTenantId;
      if (vid && e.vitalTenantId === vid && e.connectTenantId) return e.connectTenantId;
    }
    return null;
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
