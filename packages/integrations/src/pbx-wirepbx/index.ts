export type WirePbxConfig = {
  baseUrl?: string;
  apiToken?: string;
  apiSecret?: string;
  timeoutMs?: number;
  simulate?: boolean;
  webhookRegisterPath?: string;
  webhookListPath?: string;
  webhookDeletePath?: string;
  activeCallsPath?: string;
  webhookCallbackUrl?: string;
  webhookSignatureMode?: "HMAC" | "TOKEN" | "NONE";
  webhookEventTypes?: string[];
  supportsWebhooks?: boolean;
  supportsActiveCallPolling?: boolean;
};

export type WirePbxCapability = {
  supportsWebhooks: boolean;
  supportsActiveCallPolling: boolean;
  webhookSignatureMode: "HMAC" | "TOKEN" | "NONE";
  activeCallsEndpointPath?: string;
  webhookEventTypes?: string[];
};

export type WirePbxWebhook = {
  webhookId: string;
  callbackUrl?: string;
  eventTypes?: string[];
  isEnabled?: boolean;
  raw?: Record<string, unknown>;
};

export type WirePbxActiveCall = {
  callId: string;
  state: string;
  from: string;
  toExtension: string;
  tenantHint?: string;
  pbxExtensionId?: string;
  startedAt: string;
};

export type WirePbxErrorCode =
  | "NOT_CONFIGURED"
  | "NOT_SUPPORTED"
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

function parseBoolean(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const x = v.toLowerCase();
  if (x === "true" || x === "1" || x === "yes") return true;
  if (x === "false" || x === "0" || x === "no") return false;
  return undefined;
}

function ensureLeadingSlash(path: string): string {
  if (!path) return path;
  return path.startsWith("/") ? path : `/${path}`;
}

export class WirePbxClient {
  private cfg: WirePbxConfig;

  constructor(cfg: WirePbxConfig) {
    this.cfg = cfg;
  }

  private base(path: string): string {
    return `${String(this.cfg.baseUrl || "").replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private pathFromConfig(primary?: string, envName?: string): string | undefined {
    const fromCfg = primary?.trim();
    if (fromCfg) return ensureLeadingSlash(fromCfg);
    const fromEnv = envName ? process.env[envName]?.trim() : undefined;
    if (fromEnv) return ensureLeadingSlash(fromEnv);
    return undefined;
  }

  private getCapabilities(): WirePbxCapability {
    const supportsWebhooks = this.cfg.supportsWebhooks ?? parseBoolean(process.env.PBX_SUPPORTS_WEBHOOKS) ?? !!this.pathFromConfig(this.cfg.webhookRegisterPath, "PBX_WEBHOOK_REGISTER_PATH");
    const supportsActiveCallPolling = this.cfg.supportsActiveCallPolling ?? parseBoolean(process.env.PBX_SUPPORTS_ACTIVE_CALL_POLLING) ?? !!this.pathFromConfig(this.cfg.activeCallsPath, "PBX_ACTIVE_CALLS_PATH");
    const signatureMode = this.cfg.webhookSignatureMode || (process.env.PBX_WEBHOOK_SIGNATURE_MODE as "HMAC" | "TOKEN" | "NONE" | undefined) || "TOKEN";
    const activeCallsEndpointPath = this.pathFromConfig(this.cfg.activeCallsPath, "PBX_ACTIVE_CALLS_PATH");

    let webhookEventTypes = this.cfg.webhookEventTypes;
    if (!webhookEventTypes || webhookEventTypes.length === 0) {
      const fromEnv = process.env.PBX_WEBHOOK_EVENT_TYPES;
      webhookEventTypes = fromEnv
        ? fromEnv.split(",").map((x) => x.trim()).filter(Boolean)
        : ["call.ringing", "call.answered", "call.hangup"];
    }

    return {
      supportsWebhooks,
      supportsActiveCallPolling,
      webhookSignatureMode: signatureMode,
      activeCallsEndpointPath,
      webhookEventTypes
    };
  }

  capabilities(): WirePbxCapability {
    return this.getCapabilities();
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

  private resolveWebhookCallbackUrl(callbackUrl?: string): string {
    const explicit = callbackUrl?.trim();
    if (explicit) return explicit;

    const configured = this.cfg.webhookCallbackUrl?.trim() || process.env.PBX_WEBHOOK_CALLBACK_URL?.trim();
    if (configured) return configured;

    const publicApiBase = process.env.NEXT_PUBLIC_API_URL?.trim();
    if (publicApiBase) return `${publicApiBase.replace(/\/$/, "")}/webhooks/pbx`;

    return "https://app.connectcomunications.com/api/webhooks/pbx";
  }

  async registerWebhook(callbackUrl?: string): Promise<{ webhookId: string }> {
    const cap = this.getCapabilities();
    const registerPath = this.pathFromConfig(this.cfg.webhookRegisterPath, "PBX_WEBHOOK_REGISTER_PATH");
    if (!cap.supportsWebhooks || !registerPath) throw makeErr("PBX webhook registration not supported", "NOT_SUPPORTED", 501, false);

    if (this.cfg.simulate) {
      return { webhookId: `sim_webhook_${Date.now()}` };
    }

    const resolvedCallbackUrl = this.resolveWebhookCallbackUrl(callbackUrl);
    const out = await this.request<any>("POST", registerPath, { callbackUrl: resolvedCallbackUrl, eventTypes: cap.webhookEventTypes });
    return { webhookId: String(out?.webhookId || out?.id || out?.data?.id || "") };
  }

  async listWebhooks(): Promise<WirePbxWebhook[]> {
    const cap = this.getCapabilities();
    const listPath = this.pathFromConfig(this.cfg.webhookListPath, "PBX_WEBHOOK_LIST_PATH");
    if (!cap.supportsWebhooks || !listPath) throw makeErr("PBX webhook listing not supported", "NOT_SUPPORTED", 501, false);

    if (this.cfg.simulate) {
      return [{ webhookId: "sim_webhook_1", callbackUrl: this.resolveWebhookCallbackUrl(), eventTypes: cap.webhookEventTypes, isEnabled: true }];
    }

    const out = await this.request<any>("GET", listPath);
    const rows = Array.isArray(out?.data) ? out.data : Array.isArray(out) ? out : [];
    return rows.map((x: any) => ({
      webhookId: String(x.webhookId || x.id || x.uuid || ""),
      callbackUrl: x.callbackUrl ? String(x.callbackUrl) : undefined,
      eventTypes: Array.isArray(x.eventTypes) ? x.eventTypes.map((v: any) => String(v)) : undefined,
      isEnabled: typeof x.isEnabled === "boolean" ? x.isEnabled : undefined,
      raw: x
    }));
  }

  async deleteWebhook(webhookId: string): Promise<{ ok: true }> {
    const cap = this.getCapabilities();
    const deletePath = this.pathFromConfig(this.cfg.webhookDeletePath, "PBX_WEBHOOK_DELETE_PATH");
    if (!cap.supportsWebhooks || !deletePath) throw makeErr("PBX webhook deletion not supported", "NOT_SUPPORTED", 501, false);

    if (this.cfg.simulate) return { ok: true };

    await this.request("DELETE", `${deletePath.replace(/\/$/, "")}/${encodeURIComponent(webhookId)}`);
    return { ok: true };
  }

  async pollActiveCalls(sinceCursor?: string): Promise<WirePbxActiveCall[]> {
    const cap = this.getCapabilities();
    const activePath = this.pathFromConfig(this.cfg.activeCallsPath, "PBX_ACTIVE_CALLS_PATH");
    if (!cap.supportsActiveCallPolling || !activePath) throw makeErr("PBX active call polling not supported", "NOT_SUPPORTED", 501, false);

    if (this.cfg.simulate) {
      const now = new Date().toISOString();
      return [{ callId: `sim_call_${Date.now()}`, state: "RINGING", from: "+13055550111", toExtension: "1001", tenantHint: "sim-tenant-1", startedAt: now }];
    }

    const query = new URLSearchParams();
    if (sinceCursor) query.set("cursor", sinceCursor);
    const path = query.toString() ? `${activePath}?${query.toString()}` : activePath;
    const out = await this.request<any>("GET", path);
    const rows = Array.isArray(out?.data) ? out.data : Array.isArray(out?.calls) ? out.calls : Array.isArray(out) ? out : [];

    return rows
      .map((x: any) => ({
        callId: String(x.callId || x.id || x.uuid || x.uniqueid || ""),
        state: String(x.state || x.status || x.eventType || "").toUpperCase(),
        from: String(x.from || x.caller || x.src || ""),
        toExtension: String(x.toExtension || x.extension || x.dst || ""),
        tenantHint: x.tenantHint || x.tenantId || x.pbxTenantId ? String(x.tenantHint || x.tenantId || x.pbxTenantId) : undefined,
        pbxExtensionId: x.pbxExtensionId || x.extensionId ? String(x.pbxExtensionId || x.extensionId) : undefined,
        startedAt: String(x.startedAt || x.startAt || x.timestamp || new Date().toISOString())
      }))
      .filter((x: WirePbxActiveCall) => x.callId && x.state && x.toExtension);
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
