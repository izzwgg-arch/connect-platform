export type VitalPbxConfig = {
  baseUrl?: string;
  apiToken?: string;
  apiSecret?: string;
  timeoutMs?: number;
  simulate?: boolean;
};

export type VitalPbxErrorCode =
  | "NOT_CONFIGURED"
  | "NOT_SUPPORTED"
  | "PBX_AUTH_FAILED"
  | "PBX_UNAVAILABLE"
  | "PBX_VALIDATION_FAILED"
  | "PBX_RATE_LIMIT"
  | "PBX_UNKNOWN_ERROR";

export type VitalPbxApiError = Error & {
  code: VitalPbxErrorCode;
  httpStatus?: number;
  retryable?: boolean;
};

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function normalizeError(status: number): { code: VitalPbxErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: "PBX_AUTH_FAILED", retryable: false };
  if (status === 400 || status === 404 || status === 422) return { code: "PBX_VALIDATION_FAILED", retryable: false };
  if (status === 429) return { code: "PBX_RATE_LIMIT", retryable: true };
  if (status >= 500 || status === 0) return { code: "PBX_UNAVAILABLE", retryable: true };
  return { code: "PBX_UNKNOWN_ERROR", retryable: false };
}

function makeErr(message: string, code: VitalPbxErrorCode, httpStatus?: number, retryable = false): VitalPbxApiError {
  const err = new Error(message) as VitalPbxApiError;
  err.code = code;
  err.httpStatus = httpStatus;
  err.retryable = retryable;
  return err;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class VitalPbxClient {
  private cfg: VitalPbxConfig;
  constructor(cfg: VitalPbxConfig) {
    this.cfg = cfg;
  }

  private base(path: string): string {
    return `${String(this.cfg.baseUrl || "").replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private async request<T = any>(method: string, path: string, body?: Record<string, unknown>, attempt = 0): Promise<T> {
    if (this.cfg.simulate) {
      return { ok: true, simulated: true, path, method, body } as T;
    }
    if (!this.cfg.baseUrl || !this.cfg.apiToken) throw makeErr("PBX connector not configured", "NOT_CONFIGURED", 503, false);

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

  async listTenants(): Promise<any[]> { if (this.cfg.simulate) return []; const out = await this.request<any>("GET", "/tenants"); return Array.isArray(out?.data) ? out.data : []; }
  async createTenant(input: Record<string, unknown>): Promise<any> { if (this.cfg.simulate) return { id: `sim_tenant_${Date.now()}` }; return this.request("POST", "/tenants", input); }
  async updateTenant(id: string, input: Record<string, unknown>): Promise<any> { if (this.cfg.simulate) return { ok: true }; return this.request("PATCH", `/tenants/${encodeURIComponent(id)}`, input); }
  async deleteTenant(id: string): Promise<{ ok: true }> { if (this.cfg.simulate) return { ok: true }; await this.request("DELETE", `/tenants/${encodeURIComponent(id)}`); return { ok: true }; }
  async suspendTenant(id: string): Promise<{ ok: true }> { if (this.cfg.simulate) return { ok: true }; await this.request("POST", `/tenants/${encodeURIComponent(id)}/suspend`); return { ok: true }; }
  async unsuspendTenant(id: string): Promise<{ ok: true }> { if (this.cfg.simulate) return { ok: true }; await this.request("POST", `/tenants/${encodeURIComponent(id)}/unsuspend`); return { ok: true }; }
  async syncTenant(id: string): Promise<any> { if (this.cfg.simulate) return { ok: true, tenantId: id }; return this.request("POST", `/tenants/${encodeURIComponent(id)}/sync`); }

  async listExtensions(tenantId?: string): Promise<any[]> { const q = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ""; if (this.cfg.simulate) return []; const out = await this.request<any>("GET", `/extensions${q}`); return Array.isArray(out?.data) ? out.data : []; }
  async createExtension(input: Record<string, unknown>): Promise<any> { if (this.cfg.simulate) return { id: `sim_ext_${Date.now()}` }; return this.request("POST", "/extensions", input); }
  async updateExtension(id: string, input: Record<string, unknown>): Promise<any> { if (this.cfg.simulate) return { ok: true }; return this.request("PATCH", `/extensions/${encodeURIComponent(id)}`, input); }
  async deleteExtension(id: string): Promise<{ ok: true }> { if (this.cfg.simulate) return { ok: true }; await this.request("DELETE", `/extensions/${encodeURIComponent(id)}`); return { ok: true }; }
  async resetExtensionPassword(id: string): Promise<any> { if (this.cfg.simulate) return { sipPassword: `sim-${id}` }; return this.request("POST", `/extensions/${encodeURIComponent(id)}/reset-password`); }
  async provisionDevice(id: string, input: Record<string, unknown>): Promise<any> { if (this.cfg.simulate) return { deviceId: `sim_dev_${id}` }; return this.request("POST", `/extensions/${encodeURIComponent(id)}/devices`, input); }

  async listTrunks(tenantId?: string): Promise<any[]> { const q = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ""; if (this.cfg.simulate) return []; const out = await this.request<any>("GET", `/trunks${q}`); return Array.isArray(out?.data) ? out.data : []; }
  async createTrunk(input: Record<string, unknown>): Promise<any> { if (this.cfg.simulate) return { id: `sim_trunk_${Date.now()}` }; return this.request("POST", "/trunks", input); }
  async updateTrunk(id: string, input: Record<string, unknown>): Promise<any> { if (this.cfg.simulate) return { ok: true }; return this.request("PATCH", `/trunks/${encodeURIComponent(id)}`, input); }
  async deleteTrunk(id: string): Promise<{ ok: true }> { if (this.cfg.simulate) return { ok: true }; await this.request("DELETE", `/trunks/${encodeURIComponent(id)}`); return { ok: true }; }

  async listRingGroups(tenantId?: string): Promise<any[]> { const q = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ""; if (this.cfg.simulate) return []; const out = await this.request<any>("GET", `/ring-groups${q}`); return Array.isArray(out?.data) ? out.data : []; }
  async createRingGroup(input: Record<string, unknown>): Promise<any> { if (this.cfg.simulate) return { id: `sim_rg_${Date.now()}` }; return this.request("POST", "/ring-groups", input); }
  async updateRingGroup(id: string, input: Record<string, unknown>): Promise<any> { if (this.cfg.simulate) return { ok: true }; return this.request("PATCH", `/ring-groups/${encodeURIComponent(id)}`, input); }
  async deleteRingGroup(id: string): Promise<{ ok: true }> { if (this.cfg.simulate) return { ok: true }; await this.request("DELETE", `/ring-groups/${encodeURIComponent(id)}`); return { ok: true }; }

  async listQueues(tenantId?: string): Promise<any[]> { const q = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ""; if (this.cfg.simulate) return []; const out = await this.request<any>("GET", `/queues${q}`); return Array.isArray(out?.data) ? out.data : []; }
  async createQueue(input: Record<string, unknown>): Promise<any> { if (this.cfg.simulate) return { id: `sim_queue_${Date.now()}` }; return this.request("POST", "/queues", input); }
  async updateQueue(id: string, input: Record<string, unknown>): Promise<any> { if (this.cfg.simulate) return { ok: true }; return this.request("PATCH", `/queues/${encodeURIComponent(id)}`, input); }
  async deleteQueue(id: string): Promise<{ ok: true }> { if (this.cfg.simulate) return { ok: true }; await this.request("DELETE", `/queues/${encodeURIComponent(id)}`); return { ok: true }; }

  async listIvr(tenantId?: string): Promise<any[]> { const q = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ""; if (this.cfg.simulate) return []; const out = await this.request<any>("GET", `/ivr${q}`); return Array.isArray(out?.data) ? out.data : []; }
  async createIvr(input: Record<string, unknown>): Promise<any> { if (this.cfg.simulate) return { id: `sim_ivr_${Date.now()}` }; return this.request("POST", "/ivr", input); }
  async updateIvr(id: string, input: Record<string, unknown>): Promise<any> { if (this.cfg.simulate) return { ok: true }; return this.request("PATCH", `/ivr/${encodeURIComponent(id)}`, input); }
  async deleteIvr(id: string): Promise<{ ok: true }> { if (this.cfg.simulate) return { ok: true }; await this.request("DELETE", `/ivr/${encodeURIComponent(id)}`); return { ok: true }; }

  async listRoutes(tenantId?: string): Promise<any[]> { const q = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ""; if (this.cfg.simulate) return []; const out = await this.request<any>("GET", `/routes${q}`); return Array.isArray(out?.data) ? out.data : []; }
  async createRoute(input: Record<string, unknown>): Promise<any> { if (this.cfg.simulate) return { id: `sim_route_${Date.now()}` }; return this.request("POST", "/routes", input); }
  async updateRoute(id: string, input: Record<string, unknown>): Promise<any> { if (this.cfg.simulate) return { ok: true }; return this.request("PATCH", `/routes/${encodeURIComponent(id)}`, input); }
  async deleteRoute(id: string): Promise<{ ok: true }> { if (this.cfg.simulate) return { ok: true }; await this.request("DELETE", `/routes/${encodeURIComponent(id)}`); return { ok: true }; }

  async listRecordings(tenantId?: string): Promise<any[]> { const q = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ""; if (this.cfg.simulate) return []; const out = await this.request<any>("GET", `/recordings${q}`); return Array.isArray(out?.data) ? out.data : []; }
  async listCallRecordings(input: { tenantId?: string; extension?: string; dateFrom?: string; dateTo?: string; q?: string }): Promise<any[]> {
    const params = new URLSearchParams();
    if (input.tenantId) params.set("tenantId", input.tenantId);
    if (input.extension) params.set("extension", input.extension);
    if (input.dateFrom) params.set("dateFrom", input.dateFrom);
    if (input.dateTo) params.set("dateTo", input.dateTo);
    if (input.q) params.set("q", input.q);
    if (this.cfg.simulate) return [];
    const out = await this.request<any>("GET", `/call-recordings?${params.toString()}`);
    return Array.isArray(out?.data) ? out.data : [];
  }

  async getCallReports(input: { tenantId?: string; dateFrom?: string; dateTo?: string }): Promise<any> {
    const params = new URLSearchParams();
    if (input.tenantId) params.set("tenantId", input.tenantId);
    if (input.dateFrom) params.set("dateFrom", input.dateFrom);
    if (input.dateTo) params.set("dateTo", input.dateTo);
    if (this.cfg.simulate) return { answered: 0, missed: 0, avgDurationSec: 0, inbound: 0, outbound: 0, byExtension: [], byQueue: [], peakByHour: [] };
    return this.request("GET", `/reports/calls?${params.toString()}`);
  }

  async fetchCdrs(input: { tenantId?: string; lastSeenCdrId?: string; lastSeenTimestamp?: string; limit?: number }): Promise<any> {
    const params = new URLSearchParams();
    if (input.tenantId) params.set("tenantId", input.tenantId);
    if (input.lastSeenCdrId) params.set("afterId", input.lastSeenCdrId);
    if (input.lastSeenTimestamp) params.set("afterTs", input.lastSeenTimestamp);
    params.set("limit", String(input.limit || 200));
    if (this.cfg.simulate) return { records: [], nextCursor: undefined };
    return this.request("GET", `/cdrs?${params.toString()}`);
  }
}
