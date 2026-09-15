/**
 * ⛔⛔ TEST-ONLY GDMS SIMULATOR. No runtime module may import this file — a guard in
 * deviceProviders.test.ts fails if one does, and `assertGdmsRuntimeMode` refuses
 * GDMS_MODE=test|mock in production.
 *
 * It behaves like the documented GDMS Open API: password-grant tokens, SHA-256 request
 * signatures (it recomputes and REFUSES a wrong one, so a client signing bug fails the
 * suite), the { data, msg, retCode } envelope, an account whose devices are the only
 * ones listable, device/add requiring a serial number, and task/add for reboot (1) and
 * factory reset (2). Failure injection covers timeouts, 401, 429 and 500.
 *
 * ⛔ The device-row field names are the simulator's assumption, exactly as unverified
 * as the parser that reads them.
 */
import { createHash } from "node:crypto";
import { formatMac, normalizeMac } from "@connect/shared";
import { GdmsClient, gdmsFormSignature, gdmsPasswordDigest, gdmsSignature, type GdmsCredentials } from "./gdmsClient";

type SimDevice = {
  mac: string;
  model: string;
  sn: string;
  firmwareVersion: string;
  status: "online" | "offline";
  /**
   * "ours" = in the simulated account; "other" = bound to a different GDMS account;
   * "unowned" = GDMS's factory registry knows the MAC+SN pair but no account holds it —
   * invisible to device/list, addable only with the serial that really belongs to the MAC
   * (the live cloud refuses a mismatched pair per-item with errorMsg 30010).
   */
  owner: "ours" | "other" | "unowned";
  deviceName?: string;
};

export type SimFailure = "timeout" | "401" | "429" | "500" | "timeout_after_add" | "token_401";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export class GdmsSimulator {
  readonly creds: GdmsCredentials = {
    region: "us",
    apiId: "sim-api-id-0001",
    secretKey: "sim-secret-key-0123456789",
    username: "sim-owner@example.test",
    password: "sim-password-not-real",
  };
  devices = new Map<string, SimDevice>();
  tasks: Array<{ type: number; mac: string; name: string }> = [];
  /** Configs pushed via device/config/xml, by normalized MAC — the XML GDMS would deliver. */
  pushedConfigs = new Map<string, string>();
  configPushCalls = 0;
  addCalls = 0;
  tokenCalls = 0;
  apiCalls: string[] = [];
  failNext: SimFailure | null = null;
  requestedHosts = new Set<string>();
  private tokens = new Set<string>();
  private seq = 0;

  seed(device: Omit<SimDevice, "mac"> & { mac: string }): void {
    const mac = normalizeMac(device.mac);
    if (!mac) throw new Error("bad sim mac");
    this.devices.set(mac, { ...device, mac });
  }

  client(now: () => number = Date.now): GdmsClient {
    return new GdmsClient(this.creds, this.fetch, now);
  }

  fetch: typeof fetch = async (input: any, init?: any) => {
    const url = new URL(String(input));
    this.requestedHosts.add(url.hostname);
    const failure = this.failNext;
    const body = typeof init?.body === "string" ? init.body : "";

    if (url.pathname === "/oapi/oauth/token") {
      this.tokenCalls++;
      if (failure === "token_401") { this.failNext = null; return json(401, { error: "invalid_client" }); }
      const form = new URLSearchParams(body);
      if (form.get("client_id") !== this.creds.apiId || form.get("client_secret") !== this.creds.secretKey) {
        return json(401, { error: "invalid_client" });
      }
      if (form.get("grant_type") === "password") {
        if (form.get("username") !== this.creds.username || form.get("password") !== gdmsPasswordDigest(this.creds.password)) {
          return json(400, { error: "invalid_grant" });
        }
      } else if (form.get("grant_type") !== "refresh_token" || !this.tokens.has(`r:${form.get("refresh_token")}`)) {
        return json(400, { error: "invalid_grant" });
      }
      const access = `sim-access-${++this.seq}`;
      const refresh = `sim-refresh-${this.seq}`;
      this.tokens.add(access);
      this.tokens.add(`r:${refresh}`);
      return json(200, { access_token: access, refresh_token: refresh, expires_in: 3600 });
    }

    const api = url.pathname.replace(/^\/oapi\//, "");
    this.apiCalls.push(api);
    if (failure && failure !== "timeout_after_add") {
      this.failNext = null;
      if (failure === "timeout") throw new Error("simulated network timeout");
      if (failure === "401") return json(401, { msg: "unauthorized" });
      if (failure === "429") return json(429, { msg: "too many requests" });
      if (failure === "500") return json(500, { msg: "internal error" });
    }

    const accessToken = url.searchParams.get("access_token") ?? "";
    const timestamp = url.searchParams.get("timestamp") ?? "";
    const signature = url.searchParams.get("signature") ?? "";
    if (!this.tokens.has(accessToken)) return json(401, { msg: "token invalid" });

    // device/config/xml is a MULTIPART file upload signed the FORM way — handled before the
    // JSON signature/parse path (its body is FormData, not a JSON string).
    if (api === "v1.0.0/device/config/xml") {
      this.configPushCalls++;
      const fd: any = init?.body;
      const macRaw = typeof fd?.get === "function" ? fd.get("mac") : null;
      const orgId = typeof fd?.get === "function" ? fd.get("orgId") : null;
      const xmlPart: any = typeof fd?.get === "function" ? fd.get("xml") : null;
      const xml = xmlPart && typeof xmlPart.text === "function" ? await xmlPart.text()
        : (typeof xmlPart === "string" ? xmlPart : "");
      const textParams: Record<string, string> = {};
      if (macRaw != null) textParams.mac = String(macRaw);
      if (orgId != null) textParams.orgId = String(orgId);
      const expectedForm = gdmsFormSignature({
        accessToken, clientId: this.creds.apiId, clientSecret: this.creds.secretKey, timestamp,
        textParams, fileMd5: { xml: createHash("md5").update(Buffer.from(xml, "utf8")).digest("hex") },
      });
      if (signature !== expectedForm) return json(200, { data: null, msg: "bad signature", retCode: 40003 });
      const mac = normalizeMac(macRaw);
      if (!mac) return json(200, { data: null, msg: "mac required", retCode: 50005 });
      if (!xml.includes("<gs_provision")) return json(200, { data: null, msg: "bad xml", retCode: 50005 });
      this.pushedConfigs.set(mac, xml);
      return json(200, { data: "", msg: "", retCode: 0 });
    }

    const expected = gdmsSignature({ accessToken, clientId: this.creds.apiId, clientSecret: this.creds.secretKey, timestamp, body });
    if (signature !== expected) return json(200, { data: null, msg: "signature error", retCode: 40001 });
    let payload: any;
    try { payload = body ? JSON.parse(body) : {}; } catch { return json(200, { data: null, msg: "bad json", retCode: 40002 }); }

    const row = (d: SimDevice) => ({
      mac: formatMac(d.mac), model: d.model, sn: d.sn, firmwareVersion: d.firmwareVersion,
      status: d.status, deviceName: d.deviceName ?? null, siteId: 1,
    });

    switch (api) {
      case "v1.0.0/org/list":
        return json(200, { data: { result: [{ id: 1, organization: "Simulated org" }], total: 1 }, msg: "", retCode: 0 });
      case "v1.0.0/site/list":
        return json(200, { data: { result: [{ id: 11, siteName: "Default" }], total: 1 }, msg: "", retCode: 0 });
      case "v1.0.0/device/list": {
        const mac = normalizeMac(payload?.mac);
        const d = mac ? this.devices.get(mac) : undefined;
        const result = d && d.owner === "ours" ? [row(d)] : [];
        return json(200, { data: { result, total: result.length, pages: 1, pageSize: 10, pageNum: 1 }, msg: "", retCode: 0 });
      }
      case "v1.0.0/device/add": {
        this.addCalls++;
        const items = Array.isArray(payload) ? payload : [];
        for (const item of items) {
          const mac = normalizeMac(item?.mac);
          if (!mac) return json(200, { data: null, msg: "mac invalid", retCode: 10001 });
          if (!item?.sn) return json(200, { data: null, msg: "sn required", retCode: 10002 });
          const existing = this.devices.get(mac);
          if (existing && existing.owner === "other") return json(200, { data: null, msg: "device bound to another account", retCode: 10003 });
          // The one PROVEN rejection shape (live cloud, 2026-09-15): a serial that does not
          // belong to this MAC comes back per-item inside a retCode-0 envelope, NOT as an
          // envelope-level error. errorMsg carried the numeric string "30010".
          if (existing && existing.sn !== item.sn) {
            return json(200, {
              data: {
                total: 1, success: 0, failure: 1,
                errorDeviceList: [{ orgId: null, deviceName: item.deviceName ?? null, siteId: item.siteId, mac: formatMac(mac).replace(/:/g, ""), errorMsg: "30010", sn: String(item.sn) }],
              },
              msg: "", retCode: 0,
            });
          }
          this.devices.set(mac, {
            mac, model: existing?.model ?? "GXP2170", sn: String(item.sn), firmwareVersion: existing?.firmwareVersion ?? "1.0.11.64",
            status: existing?.status ?? "online", owner: "ours", deviceName: item.deviceName,
          });
        }
        if (failure === "timeout_after_add") { this.failNext = null; throw new Error("simulated timeout after the write landed"); }
        return json(200, { data: null, msg: "", retCode: 0 });
      }
      case "v1.0.0/task/add": {
        const mac = normalizeMac(Array.isArray(payload?.macList) ? payload.macList[0] : null);
        const d = mac ? this.devices.get(mac) : undefined;
        if (!d || d.owner !== "ours") return json(200, { data: null, msg: "device not found", retCode: 20001 });
        if (payload.taskType !== 1 && payload.taskType !== 2) return json(200, { data: null, msg: "task type", retCode: 20002 });
        if (d.status !== "online") return json(200, { data: null, msg: "device offline", retCode: 20003 });
        this.tasks.push({ type: payload.taskType, mac: d.mac, name: String(payload.taskName) });
        return json(200, { data: { taskId: `task-${this.tasks.length}` }, msg: "", retCode: 0 });
      }
      default:
        return json(404, { msg: "not found" });
    }
  };
}
