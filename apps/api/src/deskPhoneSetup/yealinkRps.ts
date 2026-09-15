import { randomBytes } from "node:crypto";

/**
 * Yealink YMCS v2 open API (OAuth2 client-credentials), proven live 2026-09-15
 * against us-api.ymcs.yealink.com. The 2019 JSON RPS v1 X-Ca signature scheme is
 * DEAD on YMCS ("Invalid request header" on every path) — see the handoff.
 */
export class DeviceError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
export function strictMac(input: string): string {
  if (!/^(?:[a-f\d]{12}|(?:[a-f\d]{2}:){5}[a-f\d]{2}|(?:[a-f\d]{2}-){5}[a-f\d]{2})$/i.test(input.trim()))
    throw new DeviceError("invalid_mac", 400);
  const mac = input.trim().replace(/[:-]/g, "").toLowerCase();
  if (/^(0{12}|f{12})$/.test(mac) || (parseInt(mac.slice(0, 2), 16) & 1))
    throw new DeviceError("invalid_mac", 400);
  return mac;
}
export type RpsDevice = { id: string; mac: string; serverId?: string | null; uniqueServerUrl?: string | null; authName?: string | null };
export type RpsAssignment = { mac: string; serverId: string; uniqueServerUrl: string; authName: string; password: string };
export interface RpsAdapter {
  readonly mode: "live" | "disabled" | "test";
  assign(input: RpsAssignment): Promise<{ state: "assigned" | "pending_credentials"; id?: string }>;
  release(mac: string, serverId: string, expectedUrl: string): Promise<void>;
}
export class DisabledRps implements RpsAdapter {
  readonly mode = "disabled" as const;
  async assign() { return { state: "pending_credentials" as const }; }
  async release(): Promise<void> { throw new DeviceError("rps_credentials_required", 503); }
}
/** YMCS business-error codes that carry meaning for us (v2 error body: {code, message, details}). */
const OWNED_BY_OTHER = "800004";
const ALREADY_EXISTS = "800003";
export class YealinkRpsClient implements RpsAdapter {
  readonly mode = "live" as const;
  private base: string;
  private token: { value: string; expiresAt: number } | null = null;
  constructor(base: string, private key: string, private secret: string, private request: typeof fetch = fetch) {
    const url = new URL(base);
    // Only a genuine vendor HTTPS origin. No redirects with credentials attached.
    if (url.protocol !== "https:" || !/(^|\.)yealink\.com$/.test(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new DeviceError("rps_endpoint_invalid", 503);
    if (!key || !secret) throw new DeviceError("rps_credentials_required", 503);
    this.base = url.origin;
  }
  private common(): Record<string, string> {
    return { Accept: "application/json", timestamp: String(Date.now()), nonce: randomBytes(16).toString("hex") };
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    let response: Response;
    try {
      response = await this.request(`${this.base}/v2/token`, {
        method: "POST", body: JSON.stringify({ grant_type: "client_credentials" }),
        headers: { ...this.common(), "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${this.key}:${this.secret}`).toString("base64")}` },
        signal: AbortSignal.timeout(15_000), redirect: "error",
      });
    } catch { throw new DeviceError("rps_unreachable_retry_to_reconcile", 503); }
    // Never propagate a vendor response or fetch error: either can contain credentials.
    if (response.status === 401 || response.status === 403) throw new DeviceError("rps_authentication_failed", 503);
    if (response.status === 429) throw new DeviceError("rps_rate_limited_retry_later", 503);
    if (!response.ok) throw new DeviceError("rps_service_unavailable", 503);
    let body: any;
    try { body = await response.json(); } catch { throw new DeviceError("rps_invalid_response", 502); }
    if (!body?.access_token || !Number.isFinite(Number(body.expires_in))) throw new DeviceError("rps_invalid_response", 502);
    this.token = { value: String(body.access_token), expiresAt: Date.now() + Math.max(0, Number(body.expires_in) - 60) * 1000 };
    return this.token.value;
  }
  async call<T>(method: "GET" | "POST", api: string, params?: unknown, retried = false): Promise<T> {
    const token = await this.accessToken();
    const body = method === "POST" ? JSON.stringify(params ?? {}) : undefined;
    let response: Response;
    try {
      response = await this.request(`${this.base}/v2/${api}`, {
        method, body,
        headers: { ...this.common(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000), redirect: "error",
      });
    } catch { throw new DeviceError("rps_unreachable_retry_to_reconcile", 503); }
    if (response.status === 401 && !retried) { this.token = null; return this.call(method, api, params, true); }
    if (response.status === 401 || response.status === 403) throw new DeviceError("rps_authentication_failed", 503);
    if (response.status === 429) throw new DeviceError("rps_rate_limited_retry_later", 503);
    if (!response.ok) {
      // A vendor error body carries only a code we map; its text never propagates.
      let code = "";
      try { code = String(((await response.json()) as any)?.code ?? ""); } catch { /* mapped below */ }
      if (code === OWNED_BY_OTHER) throw new DeviceError("rps_ownership_conflict");
      if (code === ALREADY_EXISTS) throw new DeviceError("rps_duplicate_retry_to_reconcile");
      if (response.status >= 500) throw new DeviceError("rps_service_unavailable", 503);
      throw new DeviceError("rps_request_rejected_check_account", 502);
    }
    const text = await response.text();
    if (!text) return null as T;
    try { return JSON.parse(text) as T; } catch { throw new DeviceError("rps_invalid_response", 502); }
  }
  listServers(params: { skip?: number; limit?: number } = {}) {
    return this.call<{ total?: number; data: any[] | null }>("POST", "rps/listServers", { skip: params.skip ?? 0, limit: params.limit ?? 100 });
  }
  addServer(input: { serverName: string; url: string }) { return this.call("POST", "rps/servers", input); }
  listDevices(params: { mac?: string; skip?: number; limit?: number } = {}) {
    return this.call<{ total?: number; data: RpsDevice[] | null }>("POST", "rps/listDevices", {
      skip: params.skip ?? 0, limit: params.limit ?? 100, autoCount: false,
      ...(params.mac ? { filter: { mac: strictMac(params.mac) } } : {}),
    });
  }
  deviceDetail(id: string) { return this.call<RpsDevice>("GET", `rps/devices/${encodeURIComponent(id)}`); }
  addDevices(input: Omit<RpsAssignment, "mac"> & { macs: string[] }) {
    const { macs, ...rest } = input;
    return this.call<unknown>("POST", "rps/addDevicesByMac", macs.map(mac => ({ mac: strictMac(mac), ...rest })));
  }
  deleteDevices(ids: string[]) { return this.call("POST", "rps/delDevices", { deviceIdType: "id", deviceIds: ids }); }
  /**
   * v2 has no checkMac: the API only ever shows OUR devices, so a MAC held by
   * another account reads as not-found here and surfaces as OWNED_BY_OTHER only
   * when an add is attempted. `self` is therefore true or null, never false.
   */
  async checkMac(mac: string): Promise<{ existed: boolean; self: boolean | null }> {
    const found = await this.owned(strictMac(mac));
    return found ? { existed: true, self: true } : { existed: false, self: null };
  }
  private async owned(mac: string): Promise<RpsDevice | null> {
    // The filter can be fuzzy; match the complete canonical MAC, across pages.
    for (let skip = 0; skip < 10_000; skip += 100) {
      const page = await this.listDevices({ mac, skip, limit: 100 });
      const rows = page?.data ?? [];
      if (!Array.isArray(rows)) throw new DeviceError("rps_invalid_response", 502);
      const found = rows.find(d => d?.mac && strictMac(d.mac) === mac);
      if (found?.id) return this.deviceDetail(found.id);
      if (rows.length < 100) break;
    }
    return null;
  }
  async assign(input: RpsAssignment) {
    const mac = strictMac(input.mac);
    const current = await this.owned(mac);
    if (current) {
      if (strictMac(current.mac) !== mac || current.serverId !== input.serverId || current.uniqueServerUrl !== input.uniqueServerUrl || current.authName !== input.authName)
        throw new DeviceError("rps_assignment_conflict_requires_release");
      return { state: "assigned" as const, id: current.id };
    }
    const { mac: ignored, ...assignment } = input;
    await this.addDevices({ ...assignment, macs: [mac] });
    // An accepted write is not proof of assignment (a batch can refuse a row
    // inside a 200). Read it back, including after retries.
    const after = await this.owned(mac);
    if (!after || after.serverId !== input.serverId || after.uniqueServerUrl !== input.uniqueServerUrl || after.authName !== input.authName)
      throw new DeviceError("rps_assignment_not_verified", 502);
    return { state: "assigned" as const, id: after.id };
  }
  async release(mac: string, serverId: string, expectedUrl: string) {
    const current = await this.owned(strictMac(mac));
    if (!current) return;
    if (current.serverId !== serverId || current.uniqueServerUrl !== expectedUrl) throw new DeviceError("rps_assignment_conflict_requires_release");
    await this.deleteDevices([current.id]);
    if (await this.owned(strictMac(mac))) throw new DeviceError("rps_release_not_verified", 502);
  }
}
export function configuredRps(env: NodeJS.ProcessEnv = process.env): RpsAdapter {
  if (env.YEALINK_RPS_MODE === "test" || env.YEALINK_RPS_MODE === "mock") throw new DeviceError("rps_mock_not_allowed_in_runtime", 503);
  if (env.YEALINK_RPS_ENABLED !== "1") return new DisabledRps();
  if (!env.YEALINK_RPS_ACCESS_KEY_ID || !env.YEALINK_RPS_ACCESS_KEY_SECRET || !env.YEALINK_RPS_BASE_URL || !env.YEALINK_RPS_SERVER_ID)
    return new DisabledRps();
  return new YealinkRpsClient(env.YEALINK_RPS_BASE_URL, env.YEALINK_RPS_ACCESS_KEY_ID, env.YEALINK_RPS_ACCESS_KEY_SECRET);
}
