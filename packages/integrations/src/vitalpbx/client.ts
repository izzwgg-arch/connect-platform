import { getVitalPbxEndpoint, listVitalPbxEndpoints } from "./endpointRegistry";
import { makeVitalPbxError, normalizeVitalPbxError } from "./errors";
import type {
  VitalPbxApiEnvelope,
  VitalPbxCallParams,
  VitalPbxCapabilityMatrix,
  VitalPbxConfig,
  VitalPbxEndpointDefinition,
  VitalPbxHttpMethod
} from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function replacePathParams(path: string, params?: Record<string, string | number>): string {
  let out = path;
  for (const [k, v] of Object.entries(params || {})) {
    out = out.replace(`:${k}`, encodeURIComponent(String(v)));
  }
  return out;
}

function toQueryString(query?: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

function unwrapData<T = any>(payload: any): T {
  if (payload && typeof payload === "object" && "data" in payload) return payload.data as T;
  return payload as T;
}

/** Start and end of "today" in the given IANA timezone. End is min(now, end of today in zone). */
function getTodayBoundsInTimezone(tz: string): { start: Date; end: Date } {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  const parts = dateStr.split("-").map(Number);
  const y = parts[0], m = parts[1], d = parts[2];
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) {
    const utcStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    return { start: utcStart, end: now };
  }
  const noonUtc = Date.UTC(y, m - 1, d, 12, 0, 0, 0);
  const inTz = new Date(noonUtc).toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hour12: false });
  const [hourStr, minStr] = inTz.split(":").map((s) => s.trim());
  const hourInTz = Number.parseInt(hourStr ?? "0", 10);
  const minInTz = Number.parseInt(minStr ?? "0", 10);
  const offsetMs = (hourInTz * 60 + minInTz) * 60 * 1000;
  const startUtc = noonUtc - offsetMs;
  const start = new Date(startUtc);
  const endOfDayUtc = startUtc + 24 * 60 * 60 * 1000 - 1;
  const end = new Date(Math.min(now.getTime(), endOfDayUtc));
  return { start, end };
}

function isIdempotentRead(method: VitalPbxHttpMethod): boolean {
  return method === "GET";
}

function hasPathParameter(path: string, token: string): boolean {
  return path.includes(`:${token}`);
}

export class VitalPbxClient {
  private cfg: Required<
    Pick<VitalPbxConfig, "timeoutMs" | "simulate" | "tenantHeaderName" | "tenantQueryName" | "tenantTransport" | "retryCount" | "userAgent">
  > &
    Omit<VitalPbxConfig, "timeoutMs" | "simulate" | "tenantHeaderName" | "tenantQueryName" | "tenantTransport" | "retryCount" | "userAgent">;

  constructor(cfg: VitalPbxConfig) {
    this.cfg = {
      timeoutMs: cfg.timeoutMs || 12000,
      simulate: !!cfg.simulate,
      tenantHeaderName: cfg.tenantHeaderName || "tenant",
      tenantQueryName: cfg.tenantQueryName || "tenant",
      tenantTransport: cfg.tenantTransport || "header",
      retryCount: cfg.retryCount ?? 2,
      userAgent: cfg.userAgent || "connectcomms-vitalpbx-client/1.0",
      ...cfg
    };
  }

  private base(path: string): string {
    const baseUrl = String(this.cfg.baseUrl || "").replace(/\/$/, "");
    return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private emit(entry: Parameters<NonNullable<VitalPbxConfig["logger"]>>[0]): void {
    if (typeof this.cfg.logger === "function") this.cfg.logger(entry);
  }

  private authHeaders(): Record<string, string> {
    const appKey = this.cfg.appKey || this.cfg.apiToken;
    if (!this.cfg.simulate && (!this.cfg.baseUrl || !appKey)) {
      throw makeVitalPbxError("VitalPBX connector not configured", "NOT_CONFIGURED", 503, false);
    }
    const out: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json"
    };
    if (appKey) out["app-key"] = String(appKey);
    // VitalPBX auth format is app-key header only.
    return out;
  }

  private maybeInjectTenant(
    endpoint: VitalPbxEndpointDefinition,
    tenant: string | undefined,
    headers: Record<string, string>,
    query: Record<string, string | number | boolean | null | undefined>
  ): void {
    if (!tenant) return;
    if (!endpoint.tenantAware) return;
    if (this.cfg.tenantTransport === "header" || this.cfg.tenantTransport === "both") {
      headers[this.cfg.tenantHeaderName] = tenant;
    }
    if (this.cfg.tenantTransport === "query" || this.cfg.tenantTransport === "both") {
      query[this.cfg.tenantQueryName] = tenant;
    }
  }

  private async request<T = any>(
    method: VitalPbxHttpMethod,
    path: string,
    params: VitalPbxCallParams = {},
    attempt = 0
  ): Promise<T> {
    if (this.cfg.simulate) {
      return {
        status: "success",
        message: "simulated",
        data: { simulated: true, method, path, tenant: params.tenant || null, query: params.query || {} }
      } as T;
    }

    const correlationId = params.correlationId || `vpbx_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const startedAt = Date.now();
    const headers = { ...this.authHeaders(), ...(params.headers || {}), "x-correlation-id": correlationId };
    const query = { ...(params.query || {}) };
    const url = `${this.base(path)}${toQueryString(query)}`;

    this.emit({ direction: "request", method, path: url, correlationId, message: "vitalpbx_request" });
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: params.body ? JSON.stringify(params.body) : undefined,
        signal: timeoutSignal(this.cfg.timeoutMs)
      });

      let payload: any = {};
      try {
        payload = await res.json();
      } catch {
        payload = {};
      }
      this.emit({
        direction: "response",
        method,
        path: url,
        status: res.status,
        correlationId,
        elapsedMs: Date.now() - startedAt,
        message: JSON.stringify({
          status: payload?.status ?? null,
          message: payload?.message ?? null,
          hasData: payload?.data !== undefined
        })
      });

      if (res.ok) return payload as T;

      const msg = String(payload?.message || payload?.error || `VitalPBX request failed (${res.status})`);
      const normalized = normalizeVitalPbxError(res.status, msg);
      if (normalized.retryable && isIdempotentRead(method) && attempt < this.cfg.retryCount) {
        await sleep(200 * 2 ** attempt);
        return this.request<T>(method, path, params, attempt + 1);
      }
      throw makeVitalPbxError(msg, normalized.code, res.status, normalized.retryable, { payload });
    } catch (err: any) {
      if (String(err?.name || "").toLowerCase() === "aborterror") {
        if (isIdempotentRead(method) && attempt < this.cfg.retryCount) {
          await sleep(200 * 2 ** attempt);
          return this.request<T>(method, path, params, attempt + 1);
        }
        throw makeVitalPbxError("VitalPBX request timed out", "PBX_UNREACHABLE", 408, true);
      }
      if (err?.code) throw err;
      this.emit({
        direction: "error",
        method,
        path: url,
        correlationId,
        errorCode: String(err?.code || "PBX_UNREACHABLE"),
        message: String(err?.cause?.message || err?.message || err)
      });
      throw makeVitalPbxError("VitalPBX unreachable", "PBX_UNREACHABLE", 503, true, { cause: String(err?.message || err) });
    }
  }

  async callEndpoint<T = any>(
    endpointKey: string,
    input?: {
      pathParams?: Record<string, string | number>;
      tenant?: string;
      query?: Record<string, string | number | boolean | null | undefined>;
      body?: Record<string, unknown> | Array<unknown>;
      headers?: Record<string, string | undefined>;
      correlationId?: string;
    }
  ): Promise<VitalPbxApiEnvelope<T>> {
    const endpoint = getVitalPbxEndpoint(endpointKey);
    const headers: Record<string, string> = {};
    const query = { ...(input?.query || {}) };
    this.maybeInjectTenant(endpoint, input?.tenant, headers, query);
    const path = replacePathParams(endpoint.path, input?.pathParams);
    return this.request<VitalPbxApiEnvelope<T>>(endpoint.method, path, {
      body: input?.body,
      query,
      headers: { ...headers, ...(input?.headers || {}) },
      tenant: input?.tenant,
      correlationId: input?.correlationId
    });
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string | null }> {
    const tenants = await this.listTenants();
    const healthy = Array.isArray(tenants) && tenants.every((t) => t && typeof t === "object");
    if (!healthy) throw makeVitalPbxError("VitalPBX tenants response invalid", "PBX_PARSE_ERROR", 502, false);
    return { ok: true, version: null };
  }

  async detectCapabilities(): Promise<VitalPbxCapabilityMatrix> {
    // Capabilities are docs-driven and further constrained at runtime by version checks if available.
    const version = (await this.healthCheck().catch(() => ({ ok: false, version: null }))).version || null;
    const supportsByDocs = (key: string) => listVitalPbxEndpoints().some((r) => r.key.startsWith(key));
    const is454Plus = version ? /^4\.(?:[5-9]|\d{2,})\./.test(version) : true;
    return {
      supportsAuthorizationCodesCrud: supportsByDocs("authorizationCodes."),
      supportsCustomerCodesCrud: supportsByDocs("customerCodes."),
      supportsAiApiKeysCrud: supportsByDocs("aiApiKeys.") && is454Plus,
      supportsAccountCodesRead: supportsByDocs("accountCodes."),
      supportsExtensionAccountCodesRead: supportsByDocs("accountCodes."),
      supportsTenantsCrud: supportsByDocs("tenants."),
      supportsQueuesCrud: supportsByDocs("queues."),
      supportsRecordingsRead: false,
      supportsVoicemailDelete: supportsByDocs("voicemail.delete"),
      supportsVoicemailMarkListened: supportsByDocs("voicemail.markListened"),
      supportsWhatsappMessaging: supportsByDocs("whatsapp."),
      supportsSmsSending: supportsByDocs("sms."),
      supportsCdrRead: supportsByDocs("cdr."),
      supportsRecordingUrlInCdr: false
    };
  }

  // ---- Tenants ----
  async listTenants(): Promise<any[]> {
    const out = await this.callEndpoint<any>("tenants.list");
    const data = unwrapData<any>(out);
    const pick = (d: unknown): any[] =>
      Array.isArray(d)
        ? d
        : d && typeof d === "object"
          ? Array.isArray((d as { result?: unknown }).result)
            ? ((d as { result: any[] }).result)
            : Array.isArray((d as { rows?: unknown }).rows)
              ? ((d as { rows: any[] }).rows)
              : Array.isArray((d as { items?: unknown }).items)
                ? ((d as { items: any[] }).items)
                : []
          : [];
    let rows = pick(data);
    if (rows.length === 0 && Array.isArray((out as { data?: unknown }).data)) {
      rows = (out as { data: any[] }).data;
    }
    // VitalPBX may paginate; fetch further pages if offset is honored.
    const pageSize = 200;
    if (rows.length === pageSize) {
      const seen = new Set(rows.map((t: any) => String(t?.tenant_id ?? t?.id ?? t?.name ?? "")));
      for (let page = 1; page < 50; page++) {
        const next = await this.callEndpoint<any>("tenants.list", {
          query: { limit: pageSize, offset: page * pageSize },
        });
        const nd = unwrapData<any>(next);
        const chunk = pick(nd);
        if (chunk.length === 0) break;
        let added = 0;
        for (const t of chunk) {
          const k = String(t?.tenant_id ?? t?.id ?? t?.name ?? "");
          if (k && !seen.has(k)) {
            seen.add(k);
            rows.push(t);
            added++;
          }
        }
        if (chunk.length < pageSize || added === 0) break;
      }
    }
    return rows;
  }
  async getTenant(id: string): Promise<any> {
    return unwrapData(await this.callEndpoint<any>("tenants.get", { pathParams: { tenantId: id } }));
  }
  async createTenant(input: Record<string, unknown>): Promise<any> {
    return unwrapData(await this.callEndpoint<any>("tenants.create", { body: input }));
  }
  async updateTenant(id: string, input: Record<string, unknown>): Promise<any> {
    return unwrapData(await this.callEndpoint<any>("tenants.update", { pathParams: { tenantId: id }, body: input }));
  }
  async deleteTenant(id: string): Promise<{ ok: true }> {
    await this.callEndpoint("tenants.delete", { pathParams: { tenantId: id } });
    return { ok: true };
  }
  async suspendTenant(id: string): Promise<{ ok: true }> {
    await this.callEndpoint("tenants.changeState", { pathParams: { tenantId: id, state: "disable" } });
    return { ok: true };
  }
  async unsuspendTenant(id: string): Promise<{ ok: true }> {
    await this.callEndpoint("tenants.changeState", { pathParams: { tenantId: id, state: "enable" } });
    return { ok: true };
  }
  async syncTenant(id: string): Promise<any> {
    return unwrapData(await this.callEndpoint<any>("tenants.applyChanges", { pathParams: { tenantId: id } }));
  }

  // ---- Extensions ----
  async listExtensions(tenantId?: string): Promise<any[]> {
    const out = await this.callEndpoint<any[]>("extensions.list", { tenant: tenantId });
    return Array.isArray(out.data) ? out.data : [];
  }
  async getExtension(extensionId: string, tenantId?: string): Promise<any> {
    return unwrapData(await this.callEndpoint<any>("extensions.get", { tenant: tenantId, pathParams: { extensionId } }));
  }
  async getExtensionDevices(extensionId: string, tenantId?: string): Promise<any[]> {
    const out = await this.callEndpoint<any[]>("extensions.devices", { tenant: tenantId, pathParams: { extensionId } });
    return Array.isArray(out.data) ? out.data : [];
  }
  async getExtensionQueues(extensionId: string, tenantId?: string): Promise<any[]> {
    const out = await this.callEndpoint<any[]>("extensions.queues", { tenant: tenantId, pathParams: { extensionId } });
    return Array.isArray(out.data) ? out.data : [];
  }
  async getExtensionCdrSummary(extensionId: string, tenantId?: string): Promise<any> {
    return unwrapData(await this.callEndpoint<any>("extensions.cdrSummary", { tenant: tenantId, pathParams: { extensionId } }));
  }
  async getExtensionVoicemailRecords(extensionId: string, tenantId?: string): Promise<any[]> {
    const out = await this.callEndpoint<any[]>("extensions.voicemailRecords", { tenant: tenantId, pathParams: { extensionId } });
    return Array.isArray(out.data) ? out.data : [];
  }
  async createExtension(_input: Record<string, unknown>, _tenantId?: string): Promise<any> {
    throw makeVitalPbxError("VitalPBX public docs do not expose extension create endpoint", "NOT_SUPPORTED", 400, false);
  }
  async updateExtension(_id: string, _input: Record<string, unknown>, _tenantId?: string): Promise<any> {
    throw makeVitalPbxError("VitalPBX public docs do not expose extension update endpoint", "NOT_SUPPORTED", 400, false);
  }
  async deleteExtension(_id: string, _tenantId?: string): Promise<{ ok: true }> {
    throw makeVitalPbxError("VitalPBX public docs do not expose extension delete endpoint", "NOT_SUPPORTED", 400, false);
  }
  async resetExtensionPassword(_id: string, _tenantId?: string): Promise<any> {
    throw makeVitalPbxError("VitalPBX public docs do not expose extension password reset endpoint", "NOT_SUPPORTED", 400, false);
  }
  async provisionDevice(_id: string, _input: Record<string, unknown>, _tenantId?: string): Promise<any> {
    throw makeVitalPbxError("VitalPBX public docs do not expose extension device provisioning endpoint", "NOT_SUPPORTED", 400, false);
  }

  // ---- Trunks / Routes ----
  async listTrunks(tenantId?: string): Promise<any[]> {
    const out = await this.callEndpoint<any[]>("trunks.list", { tenant: tenantId });
    return Array.isArray(out.data) ? out.data : [];
  }
  async getTrunk(id: string, tenantId?: string): Promise<any> {
    return unwrapData(await this.callEndpoint<any>("trunks.get", { tenant: tenantId, pathParams: { id } }));
  }
  async createTrunk(_input: Record<string, unknown>, _tenantId?: string): Promise<any> { throw makeVitalPbxError("Trunk create not documented in VitalPBX 4 public collection", "NOT_SUPPORTED", 400, false); }
  async updateTrunk(_id: string, _input: Record<string, unknown>, _tenantId?: string): Promise<any> { throw makeVitalPbxError("Trunk update not documented in VitalPBX 4 public collection", "NOT_SUPPORTED", 400, false); }
  async deleteTrunk(_id: string, _tenantId?: string): Promise<{ ok: true }> { throw makeVitalPbxError("Trunk delete not documented in VitalPBX 4 public collection", "NOT_SUPPORTED", 400, false); }

  async listRoutes(tenantId?: string): Promise<any[]> {
    const out = await this.callEndpoint<any[]>("outboundRoutes.list", { tenant: tenantId });
    return Array.isArray(out.data) ? out.data : [];
  }
  async createRoute(_input: Record<string, unknown>, _tenantId?: string): Promise<any> { throw makeVitalPbxError("Outbound route create not documented in VitalPBX 4 public collection", "NOT_SUPPORTED", 400, false); }
  async updateRoute(_id: string, _input: Record<string, unknown>, _tenantId?: string): Promise<any> { throw makeVitalPbxError("Outbound route update not documented in VitalPBX 4 public collection", "NOT_SUPPORTED", 400, false); }
  async deleteRoute(_id: string, _tenantId?: string): Promise<{ ok: true }> { throw makeVitalPbxError("Outbound route delete not documented in VitalPBX 4 public collection", "NOT_SUPPORTED", 400, false); }

  async listRingGroups(_tenantId?: string): Promise<any[]> { throw makeVitalPbxError("Ring groups endpoints are not present in public VitalPBX 4 collection", "NOT_SUPPORTED", 400, false); }
  async createRingGroup(_input: Record<string, unknown>, _tenantId?: string): Promise<any> { throw makeVitalPbxError("Ring groups endpoints are not present in public VitalPBX 4 collection", "NOT_SUPPORTED", 400, false); }
  async updateRingGroup(_id: string, _input: Record<string, unknown>, _tenantId?: string): Promise<any> { throw makeVitalPbxError("Ring groups endpoints are not present in public VitalPBX 4 collection", "NOT_SUPPORTED", 400, false); }
  async deleteRingGroup(_id: string, _tenantId?: string): Promise<{ ok: true }> { throw makeVitalPbxError("Ring groups endpoints are not present in public VitalPBX 4 collection", "NOT_SUPPORTED", 400, false); }
  async listIvr(_tenantId?: string): Promise<any[]> { throw makeVitalPbxError("IVR endpoints are not present in public VitalPBX 4 collection", "NOT_SUPPORTED", 400, false); }
  async createIvr(_input: Record<string, unknown>, _tenantId?: string): Promise<any> { throw makeVitalPbxError("IVR endpoints are not present in public VitalPBX 4 collection", "NOT_SUPPORTED", 400, false); }
  async updateIvr(_id: string, _input: Record<string, unknown>, _tenantId?: string): Promise<any> { throw makeVitalPbxError("IVR endpoints are not present in public VitalPBX 4 collection", "NOT_SUPPORTED", 400, false); }
  async deleteIvr(_id: string, _tenantId?: string): Promise<{ ok: true }> { throw makeVitalPbxError("IVR endpoints are not present in public VitalPBX 4 collection", "NOT_SUPPORTED", 400, false); }

  // ---- Queues ----
  async listQueues(tenantId?: string): Promise<any[]> {
    const out = await this.callEndpoint<any[]>("queues.list", { tenant: tenantId });
    return Array.isArray(out.data) ? out.data : [];
  }
  async createQueue(input: Record<string, unknown>, tenantId?: string): Promise<any> {
    return unwrapData(await this.callEndpoint<any>("queues.create", { tenant: tenantId, body: input }));
  }
  async updateQueue(id: string, input: Record<string, unknown>, tenantId?: string): Promise<any> {
    return unwrapData(await this.callEndpoint<any>("queues.update", { tenant: tenantId, pathParams: { queueId: id }, body: input }));
  }
  async deleteQueue(id: string, tenantId?: string): Promise<{ ok: true }> {
    await this.callEndpoint("queues.delete", { tenant: tenantId, pathParams: { queueId: id } });
    return { ok: true };
  }

  // ---- CDR / reports ----
  async fetchCdrs(input: {
    tenantId?: string;
    pbxTenantId?: string;
    lastSeenCdrId?: string;
    lastSeenTimestamp?: string;
    limit?: number;
    overlapSeconds?: number;
  }): Promise<{ records: any[]; nextCursor?: { lastSeenCdrId?: string; lastSeenTimestamp?: string } }> {
    const tenant = input.tenantId || input.pbxTenantId;
    const overlapSeconds = Math.max(0, Number(input.overlapSeconds || 90));
    const query: Record<string, string | number | boolean> = {
      limit: Math.min(Math.max(Number(input.limit || 200), 1), 1000),
      sort_by: "date",
      sort_order: "asc"
    };
    if (input.lastSeenTimestamp) {
      const d = new Date(input.lastSeenTimestamp);
      if (!Number.isNaN(d.getTime())) {
        query.start_date = Math.floor((d.getTime() - overlapSeconds * 1000) / 1000);
      }
    }
    const envelope = await this.callEndpoint<any>("cdr.list", { tenant, query });
    const data = unwrapData<any>(envelope);
    const rows = Array.isArray(data?.items) ? data.items : Array.isArray(data?.rows) ? data.rows : Array.isArray(data) ? data : [];

    const dedupe = new Map<string, any>();
    for (const row of rows) {
      const id = String(row?.id || row?.uniqueid || `${row?.src || row?.source || ""}-${row?.dst || row?.destination || ""}-${row?.date || row?.calldate || ""}`);
      dedupe.set(id, row);
    }
    const normalized = [...dedupe.values()];
    const last = normalized[normalized.length - 1];
    return {
      records: normalized,
      nextCursor: last
        ? {
            lastSeenCdrId: String(last?.id || last?.uniqueid || input.lastSeenCdrId || ""),
            lastSeenTimestamp: String(last?.date || last?.calldate || input.lastSeenTimestamp || "")
          }
        : undefined
    };
  }

  async listCallRecordings(input: { tenantId?: string; extension?: string; dateFrom?: string; dateTo?: string; q?: string }): Promise<any[]> {
    const cdr = await this.fetchCdrs({
      tenantId: input.tenantId,
      lastSeenTimestamp: input.dateFrom,
      limit: 500
    });
    return cdr.records.filter((row) => {
      if (input.extension && !String(row?.src || row?.source || "").includes(input.extension) && !String(row?.dst || row?.destination || "").includes(input.extension)) return false;
      if (input.q) {
        const blob = JSON.stringify(row).toLowerCase();
        if (!blob.includes(String(input.q).toLowerCase())) return false;
      }
      if (input.dateTo && String(row?.date || row?.calldate || "") > input.dateTo) return false;
      return true;
    });
  }

  async getCallReports(input: { tenantId?: string; dateFrom?: string; dateTo?: string }): Promise<any> {
    const rows = await this.listCallRecordings({ tenantId: input.tenantId, dateFrom: input.dateFrom, dateTo: input.dateTo });
    const answered = rows.filter((r) => String(r?.disposition || "").toUpperCase() === "ANSWERED").length;
    const missed = rows.length - answered;
    const totalDuration = rows.reduce((acc, r) => acc + Number(r?.duration || r?.billsec || 0), 0);
    return {
      answered,
      missed,
      avgDurationSec: rows.length ? Math.round(totalDuration / rows.length) : 0,
      inbound: rows.filter((r) => Number(r?.calltype) === 2).length,
      outbound: rows.filter((r) => Number(r?.calltype) === 3).length,
      total: rows.length
    };
  }

  // ---- Codes ----
  async listAccountCodes(tenantId?: string): Promise<any[]> {
    const out = await this.callEndpoint<any[]>("accountCodes.list", { tenant: tenantId });
    return Array.isArray(out.data) ? out.data : [];
  }

  async listAuthorizationCodes(tenantId?: string): Promise<any[]> {
    const out = await this.callEndpoint<any[]>("authorizationCodes.list", { tenant: tenantId });
    return Array.isArray(out.data) ? out.data : [];
  }
  async createAuthorizationCode(input: Record<string, unknown>, tenantId?: string): Promise<any> {
    return unwrapData(await this.callEndpoint<any>("authorizationCodes.create", { tenant: tenantId, body: input }));
  }
  async updateAuthorizationCode(id: string, input: Record<string, unknown>, tenantId?: string): Promise<any> {
    return unwrapData(await this.callEndpoint<any>("authorizationCodes.updatePatch", { tenant: tenantId, pathParams: { id }, body: input }));
  }
  async deleteAuthorizationCode(id: string, tenantId?: string): Promise<{ ok: true }> {
    await this.callEndpoint("authorizationCodes.delete", { tenant: tenantId, pathParams: { id } });
    return { ok: true };
  }

  async listCustomerCodes(tenantId?: string): Promise<any[]> {
    const out = await this.callEndpoint<any[]>("customerCodes.list", { tenant: tenantId });
    return Array.isArray(out.data) ? out.data : [];
  }
  async createCustomerCode(input: Record<string, unknown>, tenantId?: string): Promise<any> {
    return unwrapData(await this.callEndpoint<any>("customerCodes.create", { tenant: tenantId, body: input }));
  }
  async updateCustomerCode(id: string, input: Record<string, unknown>, tenantId?: string): Promise<any> {
    return unwrapData(await this.callEndpoint<any>("customerCodes.updatePatch", { tenant: tenantId, pathParams: { id }, body: input }));
  }
  async deleteCustomerCode(id: string, tenantId?: string): Promise<{ ok: true }> {
    await this.callEndpoint("customerCodes.delete", { tenant: tenantId, pathParams: { id } });
    return { ok: true };
  }

  // ---- Live / real-time helpers ----

  /**
   * Returns CDR rows for today with direction classification.
   * If options.timezone (IANA, e.g. America/New_York) is set, "today" is the business day in that zone;
   * otherwise midnight UTC to now (backward compatible).
   * VitalPBX /api/v2/cdr only contains completed calls (written on hangup).
   * calltype: 1=internal, 2=incoming, 3=outgoing.
   */
  async getCdrToday(
    tenantId?: string,
    options?: { timezone?: string; debug?: boolean }
  ): Promise<{
    rows: any[];
    incoming: number;
    outgoing: number;
    internal: number;
    answered: number;
    missed: number;
    total: number;
    debug?: { requestStartIso: string; requestEndIso: string; rawRowCountFromApi: number; todayStr: string };
  }> {
    const now = new Date();
    // VitalPBX /api/v2/cdr filters on start_date/end_date as UNIX TIMESTAMPS (seconds), not YYYY-MM-DD.
    // Date-only strings yield empty result sets → dashboard KPIs all zero.
    let todayStr: string;
    let startDate: Date;
    let endDate: Date = now;
    if (options?.timezone && options.timezone.trim()) {
      const tz = options.timezone.trim();
      todayStr = now.toLocaleDateString("en-CA", { timeZone: tz });
      const { start, end } = getTodayBoundsInTimezone(tz);
      startDate = start;
      endDate = end;
    } else {
      todayStr = now.toLocaleDateString("en-CA", { timeZone: "UTC" });
      const y = now.getUTCFullYear();
      const m = now.getUTCMonth();
      const d = now.getUTCDate();
      startDate = new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
      endDate = new Date(Math.min(now.getTime(), Date.UTC(y, m, d, 23, 59, 59, 999)));
    }
    const startSec = Math.floor(startDate.getTime() / 1000);
    const endSec = Math.floor(endDate.getTime() / 1000);
    // High-volume tenants can exceed 1000 rows/day; page until a short page (or cap pages).
    const queryBase: Record<string, string | number | boolean> = {
      limit: 800,
      sort_by: "date",
      sort_order: "asc",
      start_date: startSec,
      end_date: endSec,
    };
    let rows: any[] = [];
    let rawRowCountFromApi = 0;
    try {
      const seen = new Map<string, any>();
      const pageLimit = 800;
      const maxPages = 25; // up to 20k rows / tenant / day
      for (let page = 0; page < maxPages; page++) {
        const query: Record<string, string | number | boolean> = {
          ...queryBase,
          limit: pageLimit,
          offset: page * pageLimit,
        };
        const envelope = await this.callEndpoint<any>("cdr.list", { tenant: tenantId, query });
        const data = unwrapData<any>(envelope);
        const raw = Array.isArray(data?.result) ? data.result
          : Array.isArray(data?.items) ? data.items
          : Array.isArray(data?.rows) ? data.rows
          : Array.isArray(data) ? data
          : Array.isArray((envelope as any)?.result) ? (envelope as any).result
          : [];
        rawRowCountFromApi += raw.length;
        let newlyAdded = 0;
        for (const r of raw) {
          const id = String(r?.id || r?.uniqueid || `${r?.src || ""}-${r?.dst || ""}-${r?.calldate || r?.date || ""}`);
          if (!seen.has(id)) newlyAdded++;
          seen.set(id, r);
        }
        if (raw.length < pageLimit) break;
        // If PBX ignores offset we get duplicate IDs — stop to avoid a useless loop.
        if (page > 0 && newlyAdded === 0) break;
      }
      rows = [...seen.values()];
    } catch {
      rows = [];
    }
    // Light sanity check: VitalPBX filters server-side, so trust the response.
    // Only drop rows that clearly belong to a different date (loose check to handle timezone edge-cases).
    const todayPrefix = todayStr; // "2026-03-17"
    rows = rows.filter((r) => {
      const dateStr = String(r?.date ?? r?.calldate ?? "").trim();
      if (!dateStr) return true; // keep rows with no date field
      // Accept if the date string starts with today (handles "2026-03-17 14:30:00" format)
      return dateStr.startsWith(todayPrefix);
    });
    let incoming = 0, outgoing = 0, internal = 0, answered = 0, missed = 0;
    for (const r of rows) {
      const ct = Number(r?.calltype ?? r?.callType ?? 0);
      let isIncoming = false;
      if (ct === 2) { incoming++; isIncoming = true; }
      else if (ct === 3) outgoing++;
      else if (ct === 1) internal++;
      else {
        const dir = String(r?.direction || r?.call_type || "").toLowerCase();
        if (dir.includes("in") && !dir.includes("internal")) { incoming++; isIncoming = true; }
        else if (dir.includes("internal")) internal++;
        else outgoing++;
      }
      const disposition = String(r?.disposition || "").toUpperCase();
      if (disposition === "ANSWERED") answered++;
      else if (isIncoming) missed++;
    }
    const result: {
      rows: any[];
      incoming: number;
      outgoing: number;
      internal: number;
      answered: number;
      missed: number;
      total: number;
      debug?: { requestStartIso: string; requestEndIso: string; rawRowCountFromApi: number; todayStr: string };
    } = { rows, incoming, outgoing, internal, answered, missed, total: rows.length };
    if (options?.debug) {
      result.debug = {
        requestStartIso: startDate.toISOString(),
        requestEndIso: endDate.toISOString(),
        rawRowCountFromApi,
        todayStr
      };
    }
    return result;
  }

  /**
   * Attempts to fetch active channels from Asterisk ARI.
   * VitalPBX REST API v2 does not expose active calls; ARI is the proper interface.
   * Returns null if ARI is not configured or unreachable.
   */
  async getAriChannels(ariUser?: string, ariPassword?: string): Promise<any[] | null> {
    if (!ariUser || !ariPassword) return null;
    const ariBase = String(this.cfg.ariBaseUrl || this.cfg.baseUrl || "").replace(/\/$/, "");
    if (!ariBase) return null;
    const url = `${ariBase}/ari/channels`;
    const credentials = Buffer.from(`${ariUser}:${ariPassword}`).toString("base64");
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Basic ${credentials}`,
          accept: "application/json"
        },
        signal: timeoutSignal(Math.min(this.cfg.timeoutMs, 5000))
      });
      if (!res.ok) return null;
      const payload = await res.json().catch(() => null);
      return Array.isArray(payload) ? payload : null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch SIP peer registration counts from Asterisk ARI /ari/endpoints.
   * Returns { registered, unregistered, total } or null if ARI is not configured.
   * "registered" endpoints have state "online" or "registered" in the ARI response.
   */
  async getAriEndpointCounts(ariUser?: string, ariPassword?: string): Promise<{ registered: number; unregistered: number; total: number } | null> {
    if (!ariUser || !ariPassword) return null;
    const ariBase = String(this.cfg.ariBaseUrl || this.cfg.baseUrl || "").replace(/\/$/, "");
    if (!ariBase) return null;
    const url = `${ariBase}/ari/endpoints`;
    const credentials = Buffer.from(`${ariUser}:${ariPassword}`).toString("base64");
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Basic ${credentials}`,
          accept: "application/json"
        },
        signal: timeoutSignal(Math.min(this.cfg.timeoutMs, 5000))
      });
      if (!res.ok) return null;
      const payload = await res.json().catch(() => null);
      if (!Array.isArray(payload)) return null;
      let registered = 0;
      let unregistered = 0;
      for (const ep of payload) {
        const state = String(ep.state || ep.status || "").toLowerCase();
        if (state === "online" || state === "registered") {
          registered++;
        } else {
          unregistered++;
        }
      }
      return { registered, unregistered, total: payload.length };
    } catch {
      return null;
    }
  }

  async listAiApiKeys(tenantId?: string): Promise<any[]> {
    const out = await this.callEndpoint<any[]>("aiApiKeys.list", { tenant: tenantId });
    return Array.isArray(out.data) ? out.data : [];
  }
  async createAiApiKey(input: Record<string, unknown>, tenantId?: string): Promise<any> {
    return unwrapData(await this.callEndpoint<any>("aiApiKeys.create", { tenant: tenantId, body: input }));
  }
  async updateAiApiKey(id: string, input: Record<string, unknown>, tenantId?: string): Promise<any> {
    return unwrapData(await this.callEndpoint<any>("aiApiKeys.update", { tenant: tenantId, pathParams: { id }, body: input }));
  }
  async deleteAiApiKey(id: string, tenantId?: string): Promise<{ ok: true }> {
    await this.callEndpoint("aiApiKeys.delete", { tenant: tenantId, pathParams: { id } });
    return { ok: true };
  }
}
