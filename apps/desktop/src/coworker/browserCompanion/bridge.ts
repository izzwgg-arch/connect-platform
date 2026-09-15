import http from "node:http";
import { randomUUID } from "node:crypto";
import { BrowserCommand, CommandName, DEFAULT_PORT, MAX_MESSAGE_BYTES, nonce, sign, validateArgs, verify } from "./protocol";

type Pending = { command: BrowserCommand; resolve: (r: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void };
export type BridgeOptions = { secret: string; extensionId: string; port?: number; onControl?: (taskId: string | null) => void };

/** Only the paired extension can poll/results. There is deliberately NO HTTP command endpoint. */
export class BrowserCompanionBridge {
  private server: http.Server | null = null;
  private pending = new Map<string, Pending>();
  private queue: unknown[] = [];
  private replay = new Map<string, number>();
  private poll: (() => void) | null = null;
  private seenAt = 0;
  private boot = nonce();
  private stopped = false;
  private cancelled = new Set<string>();
  constructor(private options: BridgeOptions) {
    if (!/^[a-f0-9]{64}$/.test(options.secret) || !/^[a-p]{32}$/.test(options.extensionId)) throw Error("invalid_pairing");
  }
  status() { return { connected: Date.now() - this.seenAt < 35_000, protocol: 1, pending: this.pending.size, port: (this.server?.address() as import("node:net").AddressInfo)?.port ?? this.options.port ?? DEFAULT_PORT, stopped: this.stopped }; }
  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); }); });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 5000;
    this.server.maxConnections = 8;
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.options.port ?? DEFAULT_PORT, "127.0.0.1", () => { this.server!.removeListener("error", reject); resolve(); }); });
    this.server.on("error", () => { this.seenAt = 0; this.cancel(null); });
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const origin = `chrome-extension://${this.options.extensionId}`;
    const port = (this.server?.address() as import("node:net").AddressInfo)?.port;
    if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== origin) { res.writeHead(403); res.end(); return; }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS" && req.url === "/exchange") {
      res.setHeader("Access-Control-Allow-Methods", "POST"); res.setHeader("Access-Control-Allow-Headers", "Content-Type"); res.writeHead(204); res.end(); return;
    }
    if (req.method !== "POST" || req.url !== "/exchange" || req.headers["content-type"] !== "application/json") { res.writeHead(404); res.end(); return; }
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += chunk.length; if (size > MAX_MESSAGE_BYTES) { res.writeHead(413); res.end(); req.destroy(); return; } chunks.push(chunk); }
    const packet = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!verify(this.options.secret, "extension", packet) || this.replay.has(packet.nonce)) { res.writeHead(401); res.end(); return; }
    const now = Date.now();
    for (const [key, at] of this.replay) if (now - at > 60_000) this.replay.delete(key);
    if (this.replay.size > 5000) { res.writeHead(429); res.end(); return; }
    this.replay.set(packet.nonce, now);
    const data = JSON.parse(packet.body);
    this.seenAt = now;
    if (data.type === "result") {
      const pending = this.pending.get(data.id);
      if (pending && data.boot === this.boot && data.result && typeof data.result === "object" && !Array.isArray(data.result)) {
        this.finish(data.id, data.result);
      }
    } else if (data.type === "stop") {
      this.stopped = true; this.cancel(null); this.options.onControl?.(null);
    } else if (data.type === "resume") { this.stopped = false;
    } else if (data.type !== "poll") { res.writeHead(400); res.end(); return; }
    const reply = (body: unknown) => { if (!res.destroyed && !res.writableEnded) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(sign(this.options.secret, "desktop", body, packet.nonce))); } };
    if (data.type !== "poll") { reply({ ok: true, boot: this.boot }); return; }
    if (this.poll) { reply({ error: "poll_already_pending", boot: this.boot }); return; }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => flush(), 20_000);
      const flush = () => { clearTimeout(timer); this.poll = null; reply({ boot: this.boot, commands: this.queue.splice(0, 16), stopped: this.stopped }); resolve(); };
      this.poll = flush;
      res.once("close", () => { if (this.poll === flush) { clearTimeout(timer); this.poll = null; resolve(); } });
      if (this.queue.length) flush();
    });
  }
  execute(command: CommandName, args: Record<string, unknown>, taskId: string, signal: AbortSignal, scopeId = taskId, phase: "prepare" | "execute" = "execute", authorization?: string): Promise<Record<string, unknown>> {
    validateArgs(command, args);
    if (signal.aborted || this.cancelled.has(taskId)) return Promise.resolve({ ok: false, error: "task_cancelled" });
    if (this.stopped) return Promise.resolve({ ok: false, error: "browser_stopped", message: "Resume in the Browser Companion popup." });
    if (!this.status().connected) return Promise.resolve({ ok: false, error: "chrome_not_connected", message: "Open Chrome and connect Loopcom Browser Companion from Coworker Settings & Connections." });
    if (this.pending.size >= 32) return Promise.resolve({ ok: false, error: "browser_busy" });
    const id = randomUUID();
    return new Promise((resolve) => {
      const expires = Date.now() + (command === "download" ? 180_000 : 60_000);
      const item = { id, taskId, scopeId, command, args, expires, phase, ...(authorization ? {authorization} : {}) };
      const terminate = (error: string) => { this.queue = this.queue.filter((q: any) => q.id !== id); this.enqueueControl({cancel:id}); this.finish(id, { ok: false, error, effect: "An already dispatched browser action may have occurred; inspect before retrying." }); this.poll?.(); };
      const abort = () => terminate("task_cancelled");
      this.pending.set(id, { command: item, resolve, timer: setTimeout(() => terminate("browser_command_timeout"), expires - Date.now()), cleanup: () => signal.removeEventListener("abort", abort) });
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(item); this.poll?.();
    });
  }
  private finish(id: string, result: Record<string, unknown>) { const p = this.pending.get(id); if (!p) return; clearTimeout(p.timer); p.cleanup(); this.pending.delete(id); p.resolve(result); }
  private enqueueControl(control: unknown) {
    // A disconnected extension must not make cancellation metadata grow without bound.
    if (this.queue.length >= 64) { this.stopped = true; this.queue = [{cancelTask:"*"}]; }
    else this.queue.unshift(control);
  }
  cancel(taskId: string | null) {
    if (taskId && this.cancelled.size < 1000) this.cancelled.add(taskId);
    if (this.cancelled.size >= 1000) this.stopped = true;
    for (const [id, p] of this.pending) if (!taskId || p.command.taskId === taskId) { if (this.cancelled.size < 1000) this.cancelled.add(p.command.taskId); this.finish(id, { ok: false, error: "task_cancelled" }); }
    this.queue = this.queue.filter((q: any) => taskId && q.taskId !== taskId);
    this.enqueueControl({ cancelTask: taskId ?? "*" }); this.poll?.();
  }
  async stop() { this.cancel(null); this.poll?.(); this.seenAt = 0; this.server?.closeAllConnections(); await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve()); this.server = null; }
}
