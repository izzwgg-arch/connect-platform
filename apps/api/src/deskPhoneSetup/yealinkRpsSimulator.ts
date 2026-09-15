import { YealinkRpsClient } from "./yealinkRps";
import type { SipConfig } from "./yealinkConfig";

/**
 * ⛔ TEST-ONLY. A stateful simulator of the Yealink YMCS v2 open-API HTTP
 * contract (OAuth2 client-credentials + Bearer, /v2/rps/* endpoints), matching
 * what us-api.ymcs.yealink.com answered on 2026-09-15.
 *
 * Imported by tests only — no runtime module may import this file, and
 * `configuredRps()` refuses YEALINK_RPS_MODE=test/mock outright, so production
 * can never be pointed at it. It verifies Basic credentials on the token call,
 * requires a valid Bearer token everywhere else, rejects nonce replay, and can
 * inject 401/403/429/500 and a "timed out after the add was accepted" fault.
 *
 * It is deliberately NOT a `*.test.ts` file: it used to live inside
 * yealinkRps.test.ts, which made every importer re-run that file's tests.
 */
export const sip: SipConfig = { endpoint: "T21_101", username: "T21_101", authName: "T21_101", password: "canonical-secret",
  server: "pbx.example.com", port: 5060, transport: "UDP", label: "101", displayName: "Front desk", blf: [{ extension: "102", label: "Warehouse" }] };

export class RpsSimulator {
  devices = new Map<string, any>(); servers = new Map<string, any>(); nonces = new Set<string>();
  private failQueue: Array<number | "timeout_after_add"> = [];
  /** Enqueue one injected fault (assignment style kept for existing tests). */
  set failNext(value: number | "timeout_after_add" | null) { if (value !== null) this.failQueue.push(value); }
  /** Enqueue the same status several times, e.g. fail(401, 2) to defeat the one-shot token refresh. */
  fail(status: number, times = 1) { for (let i = 0; i < times; i++) this.failQueue.push(status); }
  foreign = new Set<string>(); calls: string[] = [];
  tokens = new Set<string>(); tokenCalls = 0;
  /** Set to make the CURRENT token invalid once, to prove the one-shot refresh. */
  expireToken = false;
  private err(status: number, code: string, message: string) {
    return new Response(JSON.stringify({ code, details: [], message, requestId: null }), { status, headers: { "Content-Type": "application/json" } });
  }
  fetch: typeof fetch = (async (urlInput: any, init: any) => {
    const url = new URL(String(urlInput));
    const path = url.pathname.replace(/^\/v2\//, "");
    this.calls.push(path);
    const headers = init.headers as Record<string, string>;
    const nonce = headers["nonce"];
    if (!nonce || !headers["timestamp"] || this.nonces.has(nonce)) return this.err(401, "500401", "Invalid request header");
    this.nonces.add(nonce);
    if (path === "token") {
      this.tokenCalls++;
      if (headers["Authorization"] !== `Basic ${Buffer.from("test-key:test-secret").toString("base64")}`) return this.err(401, "500401", "Invalid request header");
      if (JSON.parse(init.body).grant_type !== "client_credentials") return this.err(400, "900400", "Bad grant");
      const token = `tok-${this.tokenCalls}`;
      this.tokens.add(token);
      return Response.json({ access_token: token, token_type: "Bearer", expires_in: 3600 });
    }
    const bearer = (headers["Authorization"] || "").replace("Bearer ", "");
    if (!this.tokens.has(bearer) || this.expireToken) { this.expireToken = false; this.tokens.delete(bearer); return this.err(401, "900401", "Not logged in"); }
    if (typeof this.failQueue[0] === "number") { const status = this.failQueue.shift() as number; return this.err(status, `900${status}`, "secret-never-propagated"); }
    const p = init.body ? JSON.parse(init.body) : {};
    if (path === "rps/listDevices") {
      const mac = p?.filter?.mac ?? "";
      const rows = [...this.devices.values()].filter(d => d.mac.includes(mac));
      return Response.json({ skip: p.skip ?? 0, limit: p.limit ?? 100, total: rows.length, data: rows.slice(p.skip ?? 0, (p.skip ?? 0) + (p.limit ?? 100)) || null });
    }
    const detail = path.match(/^rps\/devices\/(.+)$/);
    if (detail && init.method === "GET") {
      const row = [...this.devices.values()].find(d => d.id === decodeURIComponent(detail[1]));
      return row ? Response.json(row) : this.err(400, "900400", "The resource does not exist or has been deleted");
    }
    // ⛔ Our account tier is FORBIDDEN from MAC-only add (proven live: 403).
    if (path === "rps/addDevicesByMac") return this.err(403, "900403", "This request is forbidden");
    // SN-based add — the allowed path. Requires a serial; returns 201.
    if (path === "rps/devices" && init.method === "POST") {
      if (!p.sn) return this.err(400, "900400", "sn required");
      if (this.foreign.has(p.mac)) return this.err(400, "800004", "Device already managed by another organization");
      if (this.devices.has(p.mac)) return this.err(400, "800003", "Resource already exists");
      const d = { ...p, id: `id-${p.mac}` }; this.devices.set(p.mac, d);
      if (this.failQueue[0] === "timeout_after_add") { this.failQueue.shift(); throw new Error("timed out after accepted"); }
      return new Response(JSON.stringify(d), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    if (path === "rps/delDevices") {
      for (const [mac, d] of this.devices) if (p.deviceIds.includes(d.id) && p.deviceIdType === "id") this.devices.delete(mac);
      return Response.json({ ok: true });
    }
    if (path === "rps/servers" && init.method === "POST") {
      if (!p.url) return this.err(400, "900400", "Can not be empty");
      const d = { ...p, id: `server-${this.servers.size}` }; this.servers.set(d.id, d); return Response.json(d);
    }
    if (path === "rps/listServers") {
      const rows = [...this.servers.values()];
      return Response.json({ skip: p.skip ?? 0, limit: p.limit ?? 100, total: rows.length, data: rows.length ? rows : null });
    }
    throw new Error(`Simulator operation missing: ${path}`);
  }) as typeof fetch;
  client() { return new YealinkRpsClient("https://us-api.ymcs.yealink.com", "test-key", "test-secret", this.fetch); }
}
