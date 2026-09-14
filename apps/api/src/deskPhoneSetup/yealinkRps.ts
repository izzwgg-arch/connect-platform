import { createHash, createHmac, randomUUID } from "node:crypto";

/** Yealink JSON RPS v1, official API reference §1–3; see the handoff for sources. */
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
export function rpsSignature(method: "POST" | "GET", api: string, key: string, secret: string,
  body?: string, query: Record<string, string> = {}, nonce = randomUUID().replace(/-/g, ""), timestamp = String(Date.now())) {
  const headers: Record<string, string> = { "X-Ca-Key": key, "X-Ca-Nonce": nonce, "X-Ca-Timestamp": timestamp };
  if (body !== undefined) headers["Content-MD5"] = createHash("md5").update(body).digest("base64");
  const q = Object.keys(query).sort().map(k => query[k] === "" ? k : `${k}=${query[k]}`).join("&");
  const canonical = `${method}\n${Object.keys(headers).sort().map(k => `${k}:${headers[k]}`).join("\n")}\n${api.replace(/^\//, "")}${q ? `\n${q}` : ""}`;
  headers["X-Ca-Signature"] = createHmac("sha256", secret).update(canonical).digest("base64");
  headers["Content-Type"] = "application/json;charset=UTF-8";
  return headers;
}
export type RpsDevice = { id: string; mac: string; serverId?: string; uniqueServerUrl?: string; authName?: string };
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
export class YealinkRpsClient implements RpsAdapter {
  readonly mode = "live" as const;
  private base: string;
  constructor(base: string, private key: string, private secret: string, private request: typeof fetch = fetch) {
    const url = new URL(base);
    // Only a genuine vendor HTTPS origin. No redirects with signed credentials.
    if (url.protocol !== "https:" || !/(^|\.)yealink\.com$/.test(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new DeviceError("rps_endpoint_invalid", 503);
    if (!key || !secret) throw new DeviceError("rps_credentials_required", 503);
    this.base = url.origin;
  }
  async call<T>(method: "GET" | "POST", api: string, params: Record<string, unknown> = {}): Promise<T> {
    const body = method === "POST" ? JSON.stringify(params) : undefined;
    const query = method === "GET" ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) : {};
    const qs = new URLSearchParams(query).toString();
    let response: Response;
    try {
      response = await this.request(`${this.base}/api/open/v1/${api}${qs ? `?${qs}` : ""}`, {
        method, body, headers: rpsSignature(method, `api/open/v1/${api}`, this.key, this.secret, body, query),
        signal: AbortSignal.timeout(15_000), redirect: "error",
      });
    } catch { throw new DeviceError("rps_unreachable_retry_to_reconcile", 503); }
    // Never propagate a vendor response or fetch error: either can contain credentials.
    if (response.status === 401 || response.status === 403) throw new DeviceError("rps_authentication_failed", 503);
    if (response.status === 429) throw new DeviceError("rps_rate_limited_retry_later", 503);
    if (!response.ok) throw new DeviceError("rps_service_unavailable", 503);
    let envelope: any;
    try { envelope = await response.json(); } catch { throw new DeviceError("rps_invalid_response", 502); }
    if (!envelope || !Number.isInteger(envelope.ret)) throw new DeviceError("rps_invalid_response", 502);
    if (envelope.ret < 0 || envelope.error) {
      const msg = envelope.error?.msg;
      if (["device.mac.added.by.other", "device.operate.forbidden"].includes(msg)) throw new DeviceError("rps_ownership_conflict");
      if (msg === "device.mac.existed") throw new DeviceError("rps_duplicate_retry_to_reconcile");
      throw new DeviceError("rps_request_rejected_check_account", 502);
    }
    return envelope.data as T;
  }
  listServers(params: { key?: string; skip?: number; limit?: number } = {}) { return this.call("POST", "server/list", params); }
  serverDetail(id: string) { return this.call("GET", "server/detail", { id }); }
  serverExists(serverName: string) { return this.call<boolean>("GET", "server/checkServerName", { serverName }); }
  addServer(input: { serverName: string; url: string; authName?: string; password?: string }) { return this.call("POST", "server/add", input); }
  editServer(input: { id: string; serverName: string; url: string; authName?: string; password?: string }) { return this.call("POST", "server/edit", input); }
  deleteServers(ids: string[]) { return this.call("POST", "server/delete", { ids }); }
  checkMac(mac: string) { return this.call<{ existed: boolean; self: boolean | null }>("GET", "device/checkMac", { mac: strictMac(mac) }); }
  checkDevice(mac: string) { return this.call<string>("GET", "device/checkDevice", { mac: strictMac(mac) }); }
  deviceDetail(id: string) { return this.call<RpsDevice>("GET", "device/detail", { id }); }
  deviceServers() { return this.call("GET", "device/serverList"); }
  listDevices(params: { key?: string; skip?: number; limit?: number } = {}) { return this.call<{ data: RpsDevice[] }>("POST", "device/list", params); }
  addDevices(input: Omit<RpsAssignment, "mac"> & { macs: string[] }) { return this.call<RpsDevice[]>("POST", "device/add", { ...input, macs: input.macs.map(strictMac) }); }
  editDevice(input: Omit<RpsAssignment, "mac"> & { id: string }) { return this.call<RpsDevice>("POST", "device/edit", input); }
  migrateDevices(ids: string[], serverId: string) { return this.call("POST", "device/migrate", { ids, serverId }); }
  deleteDevices(ids: string[]) { return this.call("POST", "device/delete", { ids }); }
  private async owned(mac: string): Promise<RpsDevice | null> {
    const check = await this.checkMac(mac);
    if (!check || typeof check.existed !== "boolean") throw new DeviceError("rps_invalid_response", 502);
    if (!check.existed) return null;
    if (check.self !== true) throw new DeviceError("rps_ownership_conflict");
    // The list is a fuzzy search; match the complete canonical MAC, across pages.
    for (let skip = 0; skip < 10_000; skip += 100) {
      const page = await this.listDevices({ key: mac, skip, limit: 100 });
      if (!Array.isArray(page?.data)) throw new DeviceError("rps_invalid_response", 502);
      const found = page.data.find(d => strictMac(d.mac) === mac);
      if (found?.id) return this.deviceDetail(found.id);
      if (page.data.length < 100) break;
    }
    throw new DeviceError("rps_device_lookup_inconsistent", 502);
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
    // An accepted write is not proof of assignment. Read it back, including after retries.
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
    if ((await this.checkMac(mac)).existed) throw new DeviceError("rps_release_not_verified", 502);
  }
}
export function configuredRps(env: NodeJS.ProcessEnv = process.env): RpsAdapter {
  if (env.YEALINK_RPS_MODE === "test" || env.YEALINK_RPS_MODE === "mock") throw new DeviceError("rps_mock_not_allowed_in_runtime", 503);
  if (env.YEALINK_RPS_ENABLED !== "1") return new DisabledRps();
  if (!env.YEALINK_RPS_ACCESS_KEY_ID || !env.YEALINK_RPS_ACCESS_KEY_SECRET || !env.YEALINK_RPS_BASE_URL || !env.YEALINK_RPS_SERVER_ID)
    return new DisabledRps();
  return new YealinkRpsClient(env.YEALINK_RPS_BASE_URL, env.YEALINK_RPS_ACCESS_KEY_ID, env.YEALINK_RPS_ACCESS_KEY_SECRET);
}
