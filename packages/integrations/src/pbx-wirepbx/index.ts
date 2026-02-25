export type WirePbxConfig = {
  baseUrl?: string;
  apiToken?: string;
  apiSecret?: string;
  timeoutMs?: number;
  simulate?: boolean;
};

export type WirePbxErrorCode =
  | "NOT_CONFIGURED"
  | "PBX_AUTH_FAILED"
  | "PBX_UNAVAILABLE"
  | "PBX_VALIDATION_FAILED"
  | "PBX_RATE_LIMIT"
  | "PBX_UNKNOWN_ERROR";

export type WirePbxApiError = Error & {
  code: WirePbxErrorCode;
  httpStatus?: number;
  retryable?: boolean;
};

export type WirePbxCdrRecord = {
  id: string;
  direction: string;
  from: string;
  to: string;
  startedAt: string;
  durationSec: number;
  disposition?: string;
  raw?: Record<string, unknown>;
};

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function notConfigured(cfg: WirePbxConfig): boolean {
  return !cfg.baseUrl || !cfg.apiToken;
}

function normalizeError(status: number): { code: WirePbxErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: "PBX_AUTH_FAILED", retryable: false };
  if (status === 400 || status === 404 || status === 422) return { code: "PBX_VALIDATION_FAILED", retryable: false };
  if (status === 429) return { code: "PBX_RATE_LIMIT", retryable: true };
  if (status >= 500 || status === 0) return { code: "PBX_UNAVAILABLE", retryable: true };
  return { code: "PBX_UNKNOWN_ERROR", retryable: false };
}

function makeErr(message: string, code: WirePbxErrorCode, httpStatus?: number, retryable = false): WirePbxApiError {
  const err = new Error(message) as WirePbxApiError;
  err.code = code;
  err.httpStatus = httpStatus;
  err.retryable = retryable;
  return err;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class WirePbxClient {
  private cfg: WirePbxConfig;

  constructor(cfg: WirePbxConfig) {
    this.cfg = cfg;
  }

  private base(path: string): string {
    return `${String(this.cfg.baseUrl || "").replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private async request<T = any>(method: string, path: string, body?: Record<string, unknown>, attempt = 0): Promise<T> {
    if (this.cfg.simulate) {
      return { ok: true, simulated: true, path, method, body } as T;
    }

    if (notConfigured(this.cfg)) throw makeErr("PBX connector not configured", "NOT_CONFIGURED", 503, false);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${String(this.cfg.apiToken)}`
    };
    if (this.cfg.apiSecret) headers["x-api-secret"] = String(this.cfg.apiSecret);

    let res: Response;
    try {
      res = await fetch(this.base(path), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: timeoutSignal(this.cfg.timeoutMs || 10000)
      });
    } catch {
      if (attempt < 3) {
        await sleep(200 * 2 ** attempt);
        return this.request(method, path, body, attempt + 1);
      }
      throw makeErr("PBX unavailable", "PBX_UNAVAILABLE", 503, true);
    }

    const payload = (await res.json().catch(() => ({}))) as T;
    if (res.ok) return payload;

    const normalized = normalizeError(res.status);
    if (normalized.retryable && attempt < 3) {
      await sleep(200 * 2 ** attempt);
      return this.request(method, path, body, attempt + 1);
    }
    throw makeErr("PBX request failed", normalized.code, res.status, normalized.retryable);
  }

  async healthCheck(): Promise<{ ok: boolean }> {
    if (this.cfg.simulate) return { ok: true };
    await this.request("GET", "/health");
    return { ok: true };
  }

  async listTenants(): Promise<Array<{ id: string; name?: string }>> {
    if (this.cfg.simulate) return [{ id: "sim-tenant-1", name: "Sim Tenant" }];
    const out = await this.request<any>("GET", "/tenants");
    return Array.isArray(out?.data) ? out.data : [];
  }

  async getTenant(id: string): Promise<Record<string, unknown>> {
    if (this.cfg.simulate) return { id, name: "Sim Tenant" };
    return this.request("GET", `/tenants/${encodeURIComponent(id)}`);
  }

  async createTenant(input: { name: string; externalId?: string }): Promise<{ id: string }> {
    if (this.cfg.simulate) return { id: `sim_tenant_${input.externalId || Date.now()}` };
    const out = await this.request<any>("POST", "/tenants", input);
    return { id: String(out?.id || out?.tenantId || "") };
  }

  async listExtensions(pbxTenantId?: string): Promise<any[]> {
    if (this.cfg.simulate) return [];
    const q = pbxTenantId ? `?tenantId=${encodeURIComponent(pbxTenantId)}` : "";
    const out = await this.request<any>("GET", `/extensions${q}`);
    return Array.isArray(out?.data) ? out.data : [];
  }

  async createExtension(input: { pbxTenantId?: string; extensionNumber: string; displayName: string }): Promise<{ pbxExtensionId: string; sipUsername: string }> {
    if (this.cfg.simulate) {
      return { pbxExtensionId: `sim_ext_${input.extensionNumber}`, sipUsername: `sip_${input.extensionNumber}` };
    }
    const out = await this.request<any>("POST", "/extensions", input);
    return { pbxExtensionId: String(out?.id || out?.extensionId || ""), sipUsername: String(out?.sipUsername || input.extensionNumber) };
  }

  async updateExtension(pbxExtensionId: string, input: { displayName?: string }): Promise<{ ok: true }> {
    if (this.cfg.simulate) return { ok: true };
    await this.request("PATCH", `/extensions/${encodeURIComponent(pbxExtensionId)}`, input);
    return { ok: true };
  }

  async suspendExtension(pbxExtensionId: string, suspended: boolean): Promise<{ ok: true }> {
    if (this.cfg.simulate) return { ok: true };
    await this.request("POST", `/extensions/${encodeURIComponent(pbxExtensionId)}/${suspended ? "suspend" : "unsuspend"}`);
    return { ok: true };
  }

  async deleteExtension(pbxExtensionId: string): Promise<{ ok: true }> {
    if (this.cfg.simulate) return { ok: true };
    await this.request("DELETE", `/extensions/${encodeURIComponent(pbxExtensionId)}`);
    return { ok: true };
  }

  async createSipDevice(input: { pbxExtensionId: string; enableWebrtc?: boolean; enableMobile?: boolean }): Promise<{ pbxDeviceId: string; sipUsername: string; sipPassword: string }> {
    if (this.cfg.simulate) {
      return { pbxDeviceId: `sim_dev_${input.pbxExtensionId}`, sipUsername: `sip_${input.pbxExtensionId}`, sipPassword: `simPass-${input.pbxExtensionId}` };
    }
    const out = await this.request<any>("POST", `/extensions/${encodeURIComponent(input.pbxExtensionId)}/devices`, input);
    return {
      pbxDeviceId: String(out?.deviceId || out?.id || ""),
      sipUsername: String(out?.sipUsername || ""),
      sipPassword: String(out?.sipPassword || "")
    };
  }

  async resetPassword(pbxExtensionId: string): Promise<{ sipPassword: string }> {
    if (this.cfg.simulate) return { sipPassword: `simReset-${pbxExtensionId}` };
    const out = await this.request<any>("POST", `/extensions/${encodeURIComponent(pbxExtensionId)}/reset-password`);
    return { sipPassword: String(out?.sipPassword || "") };
  }

  async listDids(pbxTenantId?: string): Promise<any[]> {
    if (this.cfg.simulate) return [];
    const q = pbxTenantId ? `?tenantId=${encodeURIComponent(pbxTenantId)}` : "";
    const out = await this.request<any>("GET", `/dids${q}`);
    return Array.isArray(out?.data) ? out.data : [];
  }

  async createDidRoute(input: { pbxTenantId?: string; did: string; routeType: string; routeTarget: string }): Promise<{ pbxDidId: string }> {
    if (this.cfg.simulate) return { pbxDidId: `sim_did_${input.did.replace(/\D/g, "")}` };
    const out = await this.request<any>("POST", "/dids/routes", input);
    return { pbxDidId: String(out?.didId || out?.id || "") };
  }

  async updateDidRoute(pbxDidId: string, input: { routeType: string; routeTarget: string }): Promise<{ ok: true }> {
    if (this.cfg.simulate) return { ok: true };
    await this.request("PATCH", `/dids/routes/${encodeURIComponent(pbxDidId)}`, input);
    return { ok: true };
  }

  async fetchCdrs(input: { pbxTenantId?: string; lastSeenCdrId?: string; lastSeenTimestamp?: string; limit?: number }): Promise<{ records: WirePbxCdrRecord[]; nextCursor?: { lastSeenCdrId?: string; lastSeenTimestamp?: string } }> {
    if (this.cfg.simulate) {
      const now = new Date();
      const rec: WirePbxCdrRecord = {
        id: `sim_cdr_${now.getTime()}`,
        direction: "outbound",
        from: "+13055550101",
        to: "+13055550102",
        startedAt: now.toISOString(),
        durationSec: 42,
        disposition: "ANSWERED"
      };
      return { records: [rec], nextCursor: { lastSeenCdrId: rec.id, lastSeenTimestamp: rec.startedAt } };
    }

    const params = new URLSearchParams();
    if (input.pbxTenantId) params.set("tenantId", input.pbxTenantId);
    if (input.lastSeenCdrId) params.set("afterId", input.lastSeenCdrId);
    if (input.lastSeenTimestamp) params.set("afterTs", input.lastSeenTimestamp);
    params.set("limit", String(input.limit || 200));

    const out = await this.request<any>("GET", `/cdrs?${params.toString()}`);
    const records = Array.isArray(out?.data) ? out.data : [];
    const mapped: WirePbxCdrRecord[] = records.map((x: any) => ({
      id: String(x.id || x.uniqueid || x.callId),
      direction: String(x.direction || "unknown"),
      from: String(x.from || x.src || ""),
      to: String(x.to || x.dst || ""),
      startedAt: String(x.startedAt || x.start || new Date().toISOString()),
      durationSec: Number(x.durationSec || x.duration || 0),
      disposition: x.disposition ? String(x.disposition) : undefined,
      raw: x
    }));
    const last = mapped[mapped.length - 1];
    return {
      records: mapped,
      nextCursor: last ? { lastSeenCdrId: last.id, lastSeenTimestamp: last.startedAt } : undefined
    };
  }
}
