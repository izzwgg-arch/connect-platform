/**
 * The desktop end of the link: say hello with the manifest, long-poll for work,
 * hand each call to the runtime, post the result. Reconnects with backoff, and
 * re-reads the session token when the server says 401/403.
 *
 * ⛔ THE TOKEN IS THE SIGNED-IN USER'S PORTAL JWT, read from the main window's
 * localStorage (the hosted portal keeps it there; same origin as the bubble
 * chat). It is used for exactly this link and never written anywhere. No token
 * (signed out) means no link — the hands do not exist for a signed-out app.
 *
 * ⛔ Every message from the wire is untrusted input: parsed strictly, bounded,
 * and judged by the runtime's policy before anything runs.
 */
import type { CoworkerRuntime } from "./runtime";

export type LinkDeps = {
  portalUrl: string;
  /** The portal JWT, or null when nobody is signed in. Re-asked on 401/403. */
  getToken: () => Promise<string | null>;
  runtime: CoworkerRuntime;
  manifest: () => Record<string, unknown>;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  onStateChange?: (s: LinkState) => void;
};

export type LinkState = { state: "off" | "no_token" | "connecting" | "connected" | "error"; since: string; lastError: string | null; calls: number; helloAt: string | null; lastPollAt: string | null; desktopId: string };

const POLL_WAIT_SEC = 25;
const MIN_POLL_INTERVAL_MS = 750;
const HELLO_EVERY_MS = 5 * 60 * 1000;

export class DesktopLinkClient {
  private running = false;
  private loop: Promise<void> | null = null;
  private token: string | null = null;
  private state: LinkState;
  private lastHelloAt = 0;
  private manifestHash = "";
  private inflight = 0;
  constructor(private deps: LinkDeps, private desktopId: string) {
    this.state = { state: "off", since: new Date().toISOString(), lastError: null, calls: 0, helloAt: null, lastPollAt: null, desktopId };
  }

  status(): LinkState { return { ...this.state }; }

  private set(patch: Partial<LinkState>) {
    const prev = this.state.state;
    this.state = { ...this.state, ...patch };
    if (patch.state && patch.state !== prev) { this.state.since = new Date().toISOString(); this.deps.log(`link: ${prev} → ${patch.state}${patch.lastError ? ` (${patch.lastError})` : ""}`); }
    this.deps.onStateChange?.(this.status());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.set({ state: "connecting" });
    this.loop = this.run().catch((e) => this.deps.log(`link: loop crashed ${String(e)}`));
  }

  async stop(): Promise<void> {
    this.running = false;
    try { if (this.token) await this.call("POST", "/agent-api/coworker/goodbye", {}, 5000); } catch { /* best effort */ }
    this.set({ state: "off" });
  }

  /** Re-announce the manifest now (MCP server connected, profile changed). */
  announce(): void { this.lastHelloAt = 0; }

  private async call(method: string, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: any }> {
    const f = this.deps.fetchImpl ?? fetch;
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await f(`${this.deps.portalUrl}${path}`, {
        method, signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}`, ...(this.deps.userAgent ? { "User-Agent": this.deps.userAgent } : {}) },
        ...(body === undefined || method === "GET" ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
      return { status: res.status, json };
    } finally { clearTimeout(timer); }
  }

  private async hello(): Promise<boolean> {
    const manifest = this.deps.manifest();
    const hash = JSON.stringify(manifest).length + ":" + (manifest.tools as unknown[]).length;
    const r = await this.call("POST", "/agent-api/coworker/hello", { manifest }, 20_000);
    if (r.status === 200) {
      this.lastHelloAt = Date.now(); this.manifestHash = hash;
      this.set({ state: "connected", helloAt: new Date().toISOString(), lastError: null });
      this.deps.log(`link: hello ok, tools=${r.json?.tools ?? "?"}`);
      return true;
    }
    if (r.status === 401 || r.status === 403) { this.token = null; this.set({ state: "no_token", lastError: `hello ${r.status}` }); return false; }
    this.set({ state: "error", lastError: `hello ${r.status} ${JSON.stringify(r.json ?? "").slice(0, 120)}` });
    return false;
  }

  private async run(): Promise<void> {
    let backoff = 1000;
    while (this.running) {
      try {
        if (!this.token) {
          this.token = await this.deps.getToken();
          if (!this.token) { this.set({ state: "no_token" }); await sleep(5000); continue; }
        }
        const manifest = this.deps.manifest();
        const hash = JSON.stringify(manifest).length + ":" + (manifest.tools as unknown[]).length;
        if (Date.now() - this.lastHelloAt > HELLO_EVERY_MS || hash !== this.manifestHash) {
          if (!(await this.hello())) { await sleep(backoff); backoff = Math.min(backoff * 2, 30_000); continue; }
          backoff = 1000;
        }
        const pollStarted = Date.now();
        const r = await this.call("GET", `/agent-api/coworker/next?wait=${POLL_WAIT_SEC}`, undefined, (POLL_WAIT_SEC + 20) * 1000);
        this.set({ lastPollAt: new Date().toISOString() });
        // ⛔ Never spin: a server that answers instantly (an empty wait, a proxy
        // that cuts the long-poll short) must not turn this loop into a hot loop.
        const elapsed = Date.now() - pollStarted;
        if (elapsed < MIN_POLL_INTERVAL_MS) await sleep(MIN_POLL_INTERVAL_MS - elapsed);
        if (r.status === 204) { backoff = 1000; continue; }
        if (r.status === 409) { this.lastHelloAt = 0; continue; }
        if (r.status === 401 || r.status === 403) { this.token = null; this.set({ state: "no_token", lastError: `poll ${r.status}` }); continue; }
        if (r.status !== 200) { this.set({ state: "error", lastError: `poll ${r.status}` }); await sleep(backoff); backoff = Math.min(backoff * 2, 30_000); continue; }
        const msg = r.json?.message;
        if (msg && msg.kind === "cancel") { this.deps.runtime.cancel(typeof msg.taskId === "string" ? msg.taskId : null); continue; }
        if (msg && msg.kind === "call" && typeof msg.id === "string" && typeof msg.name === "string") {
          // Handle without blocking the poll loop: the next call may be needed to finish this one.
          this.inflight++;
          void this.handleCall(msg).finally(() => { this.inflight--; });
        }
        backoff = 1000;
      } catch (e: any) {
        const name = String(e?.name ?? "");
        if (name === "AbortError") { continue; } // the long-poll timed out client-side; poll again
        this.set({ state: "error", lastError: String(e?.cause?.code ?? e?.message ?? e).slice(0, 120) });
        await sleep(backoff); backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  private async handleCall(msg: { id: string; name: string; args?: unknown; taskId?: string; timeoutMs?: number }) {
    const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? (msg.args as Record<string, unknown>) : {};
    const taskId = typeof msg.taskId === "string" ? msg.taskId.slice(0, 120) : "task";
    const started = Date.now();
    const out = await this.deps.runtime.handle({ id: msg.id, name: msg.name.slice(0, 64), args, taskId, timeoutMs: msg.timeoutMs });
    this.set({ calls: this.state.calls + 1 });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await this.call("POST", "/agent-api/coworker/result", { callId: msg.id, ok: out.ok, content: out.content, name: msg.name, durationMs: Date.now() - started }, 20_000);
        if (r.status === 200) { if (!r.json?.accepted) this.deps.log(`link: result for ${msg.id.slice(0, 8)} arrived late (not accepted)`); return; }
        if (r.status === 401 || r.status === 403) { this.token = await this.deps.getToken(); continue; }
        this.deps.log(`link: result post ${r.status}`);
      } catch (e: any) { this.deps.log(`link: result post failed ${String(e?.message ?? e).slice(0, 100)}`); }
      await sleep(1000 * (attempt + 1));
    }
  }
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
