import { rpsSignature, YealinkRpsClient } from "./yealinkRps";
import type { SipConfig } from "./yealinkConfig";

/**
 * ⛔ TEST-ONLY. A stateful simulator of the Yealink JSON RPS v1 HTTP contract.
 *
 * Imported by tests only — no runtime module may import this file, and
 * `configuredRps()` refuses YEALINK_RPS_MODE=test/mock outright, so production
 * can never be pointed at it. It verifies the request signature the same way the
 * real service would, rejects nonce replay, and can inject 401/403/429/500 and a
 * "timed out after the add was accepted" fault.
 *
 * It is deliberately NOT a `*.test.ts` file: it used to live inside
 * yealinkRps.test.ts, which made every importer re-run that file's tests.
 */
export const sip: SipConfig = { endpoint: "T21_101", username: "T21_101", authName: "T21_101", password: "canonical-secret",
  server: "pbx.example.com", port: 5060, transport: "UDP", label: "101", displayName: "Front desk", blf: [{ extension: "102", label: "Warehouse" }] };

export class RpsSimulator {
  devices = new Map<string, any>(); servers = new Map<string, any>(); nonces = new Set<string>();
  failNext: number | "timeout_after_add" | null = null;
  foreign = new Set<string>(); calls: string[] = [];
  fetch: typeof fetch = (async (urlInput: any, init: any) => {
    const url = new URL(String(urlInput)); const path = url.pathname.replace("/api/open/v1/", "");
    this.calls.push(path);
    const headers = init.headers as Record<string, string>;
    const nonce = headers["X-Ca-Nonce"];
    const signing = rpsSignature(init.method, url.pathname, "test-key", "test-secret", init.body, Object.fromEntries(url.searchParams), nonce, headers["X-Ca-Timestamp"]);
    if (this.nonces.has(nonce) || headers["X-Ca-Signature"] !== signing["X-Ca-Signature"]) return new Response("denied", { status: 401 });
    this.nonces.add(nonce);
    if (typeof this.failNext === "number") { const status = this.failNext; this.failNext = null; return new Response("secret-never-propagated", { status }); }
    const p = init.body ? JSON.parse(init.body) : Object.fromEntries(url.searchParams);
    const ok = (data: any) => Response.json({ ret: data == null ? 0 : 1, data, error: null });
    if (path === "device/checkMac") return ok({ existed: this.devices.has(p.mac) || this.foreign.has(p.mac), self: this.foreign.has(p.mac) ? false : this.devices.has(p.mac) ? true : null });
    if (path === "device/list") return ok({ data: [...this.devices.values()].filter(d => d.mac.includes(p.key)).slice(p.skip, p.skip + p.limit) });
    if (path === "device/detail") return ok([...this.devices.values()].find(d => d.id === p.id));
    if (path === "device/add") {
      if (this.devices.has(p.macs[0])) return Response.json({ ret: -1, data: null, error: { msg: "device.mac.existed" } });
      const made = p.macs.map((mac: string) => { const d = { ...p, mac, id: `id-${mac}` }; this.devices.set(mac, d); return d; });
      if (this.failNext === "timeout_after_add") { this.failNext = null; throw new Error("timed out after accepted"); }
      return ok(made);
    }
    if (path === "device/edit" || path === "device/migrate") {
      const ids = p.ids || [p.id]; const rows = [...this.devices.values()].filter(d => ids.includes(d.id));
      rows.forEach(d => Object.assign(d, p)); return ok(path === "device/edit" ? rows[0] : rows);
    }
    if (path === "device/delete") { for (const [mac, d] of this.devices) if (p.ids.includes(d.id)) this.devices.delete(mac); return ok(null); }
    if (path === "server/add") { const d = { ...p, id: `server-${this.servers.size}` }; this.servers.set(d.id, d); return ok(d); }
    if (path === "server/list") return ok({ data: [...this.servers.values()] });
    if (path === "server/detail") return ok(this.servers.get(p.id));
    if (path === "server/checkServerName") return ok([...this.servers.values()].some(s => s.serverName === p.serverName));
    if (path === "server/edit") { Object.assign(this.servers.get(p.id), p); return ok(this.servers.get(p.id)); }
    if (path === "server/delete") { p.ids.forEach((id: string) => this.servers.delete(id)); return ok(null); }
    throw new Error(`Simulator operation missing: ${path}`);
  }) as typeof fetch;
  client() { return new YealinkRpsClient("https://dm.yealink.com", "test-key", "test-secret", this.fetch); }
}
