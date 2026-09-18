/**
 * The Local Worker's owner — Loopcom starts it, watches it, restarts it, and
 * never lets the Coworker believe a dead worker is alive.
 *
 * Lifecycle (Phase 5 of the brief): started lazily on the first op; `ping`ed
 * before an op when it has been idle; a crash rejects every in-flight call with
 * `worker_died` (the model is told, the runtime marks the screen session ended);
 * the next op respawns it with exponential backoff; stopped after
 * `IDLE_STOP_MS` without work so a phone-only user never carries the process.
 *
 * Protocol: one JSON object per line each way (see workerScript.ts). Responses
 * carry the request id; `{"event":…}` lines are unsolicited (hook input, ready,
 * fatal) and go to `onEvent`. Every call has a timeout; a call that outlives it
 * is rejected AND the worker is considered wedged if a `ping` then also fails.
 *
 * ⛔ Pure Node (child_process) — no Electron — so it is unit-testable with a fake
 * spawn, and the worker script it writes is the one in workerScript.ts (rewritten
 * on every start, so an app update always runs its own worker).
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORKER_SCRIPT, WORKER_PROTOCOL_VERSION } from "./workerScript";

export type WorkerEvent = { event: "input"; kind: "mouse" | "key" | "escape"; button?: boolean; injected?: boolean } | { event: "ready"; protocol: number; pid: number } | { event: "fatal"; message: string } | { event: string; [k: string]: unknown };

export type WorkerResult<T = Record<string, unknown>> = { ok: true; result: T } | { ok: false; error: string; message: string };

export type SpawnLike = (cmd: string, args: string[], opts: any) => ChildProcessWithoutNullStreams;

export type LocalWorkerDeps = {
  /** Where the script file is written (userData/coworker/worker/). */
  dir: string;
  log: (line: string) => void;
  onEvent?: (e: WorkerEvent) => void;
  /** Fired when the worker died unexpectedly (not on a deliberate stop). */
  onDied?: (reason: string) => void;
  spawn?: SpawnLike;
  now?: () => number;
  /** Test hook: the script text to write (defaults to the real worker). */
  script?: string;
  powershellPath?: string;
};

export const IDLE_STOP_MS = 10 * 60 * 1000;
export const START_TIMEOUT_MS = 25_000;
export const DEFAULT_CALL_TIMEOUT_MS = 20_000;
const BACKOFF_MS = [500, 1500, 4000, 10_000, 30_000];

type Pending = { resolve: (r: WorkerResult) => void; timer: ReturnType<typeof setTimeout>; op: string; startedAt: number };

export class LocalWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<boolean> | null = null;
  private ready = false;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private buf = "";
  private lastUsedAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private stoppedDeliberately = false;
  private readonly now: () => number;
  readonly scriptPath: string;
  /** Stats for the diagnostics tool and the proof bundle. */
  readonly stats = { starts: 0, crashes: 0, calls: 0, failures: 0, timeouts: 0, events: 0 };

  constructor(private deps: LocalWorkerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.scriptPath = join(deps.dir, "loopcom-worker.ps1");
  }

  get alive(): boolean { return !!this.child && this.ready; }
  get pid(): number | undefined { return this.child?.pid; }

  /** Start (or reuse) the worker. Resolves true when it answered `ready`. */
  async start(): Promise<boolean> {
    if (this.alive) return true;
    if (this.starting) return this.starting;
    this.starting = this.spawnOnce().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async spawnOnce(): Promise<boolean> {
    this.stoppedDeliberately = false;
    if (this.failures > 0) {
      const wait = BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)];
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      mkdirSync(dirname(this.scriptPath), { recursive: true });
      writeFileSync(this.scriptPath, this.deps.script ?? WORKER_SCRIPT, "utf8");
    } catch (e) {
      this.deps.log(`worker: cannot write script: ${String(e)}`);
      this.failures++;
      return false;
    }
    const sp = this.deps.spawn ?? (nodeSpawn as unknown as SpawnLike);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = sp(this.deps.powershellPath ?? "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      this.deps.log(`worker: spawn failed: ${String(e)}`);
      this.failures++;
      return false;
    }
    this.child = child;
    this.ready = false;
    this.buf = "";
    this.stats.starts++;
    let stderrTail = "";
    child.stderr?.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString("utf8")).slice(-800); });
    child.stdin?.on("error", () => { /* handled by exit */ });
    child.stdout?.on("error", () => { /* read side */ });
    child.stderr?.on("error", () => { /* read side */ });
    child.stdout.on("data", (d: Buffer) => this.onData(d));
    const readyP = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), START_TIMEOUT_MS);
      this.readyResolvers.push((ok) => { clearTimeout(t); resolve(ok); });
    });
    child.on("exit", (code, signal) => {
      const wasReady = this.ready;
      const mine = this.child === child;
      if (!mine) return;
      this.child = null; this.ready = false;
      const reason = `exit code=${code ?? signal ?? "?"}${stderrTail.trim() ? ` stderr=${stderrTail.trim().slice(-200)}` : ""}`;
      for (const r of this.readyResolvers.splice(0)) r(false);
      this.rejectAll("worker_died", "The computer-control helper stopped unexpectedly; it is being restarted.");
      if (!this.stoppedDeliberately) {
        this.stats.crashes++;
        this.failures++;
        this.deps.log(`worker: died (${reason})${wasReady ? "" : " before ready"}`);
        try { this.deps.onDied?.(reason); } catch { /* best effort */ }
      } else {
        this.deps.log(`worker: stopped (${reason})`);
      }
    });
    child.on("error", (e) => { this.deps.log(`worker: error ${String(e)}`); });
    const ok = await readyP;
    if (ok) { this.failures = 0; this.deps.log(`worker: ready pid=${child.pid} protocol=${WORKER_PROTOCOL_VERSION}`); this.touch(); }
    else { this.failures++; this.deps.log(`worker: did not become ready (${stderrTail.trim().slice(-200)})`); try { child.kill(); } catch { /* gone */ } if (this.child === child) { this.child = null; } }
    return ok;
  }
  private readyResolvers: ((ok: boolean) => void)[] = [];

  private onData(d: Buffer): void {
    this.buf += d.toString("utf8");
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { this.deps.log(`worker: unparseable line ${line.slice(0, 120)}`); continue; }
      if (msg && typeof msg.event === "string") {
        if (msg.event === "ready") { this.ready = true; for (const r of this.readyResolvers.splice(0)) r(true); continue; }
        if (msg.event === "fatal") { this.deps.log(`worker: fatal ${String(msg.message).slice(0, 300)}`); for (const r of this.readyResolvers.splice(0)) r(false); continue; }
        this.stats.events++;
        try { this.deps.onEvent?.(msg as WorkerEvent); } catch { /* an event handler must not kill the reader */ }
        continue;
      }
      if (msg && typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok === true) p.resolve({ ok: true, result: (msg.result ?? {}) as Record<string, unknown> });
        else { this.stats.failures++; p.resolve({ ok: false, error: String(msg.error ?? "worker_error"), message: String(msg.message ?? "") }); }
      }
    }
  }

  private rejectAll(error: string, message: string): void {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); this.pending.delete(id); p.resolve({ ok: false, error, message }); }
  }

  private touch(): void {
    this.lastUsedAt = this.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (this.pending.size === 0 && this.now() - this.lastUsedAt >= IDLE_STOP_MS - 50) void this.stop("idle"); }, IDLE_STOP_MS);
    if (typeof (this.idleTimer as { unref?: () => void }).unref === "function") (this.idleTimer as { unref: () => void }).unref();
  }

  /** One op. Starts the worker if needed. Never throws: every failure is a result. */
  async call<T = Record<string, unknown>>(op: string, args: Record<string, unknown> = {}, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<WorkerResult<T>> {
    const started = await this.start();
    if (!started || !this.child) return { ok: false, error: "worker_unavailable", message: "The computer-control helper could not start on this computer." };
    const id = ++this.seq;
    this.stats.calls++;
    this.touch();
    const child = this.child;
    return new Promise<WorkerResult<T>>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stats.timeouts++;
        resolve({ ok: false, error: "worker_timeout", message: `The computer did not finish ${op} within ${Math.round(timeoutMs / 1000)}s.` });
        // A wedged worker is worse than a restarted one: probe it, and kill it if the probe also hangs.
        void this.probeOrRestart();
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (r: WorkerResult) => void, timer, op, startedAt: this.now() });
      try { child.stdin.write(JSON.stringify({ id, op, args }) + "\n"); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); resolve({ ok: false, error: "worker_write_failed", message: String((e as Error)?.message ?? e) }); }
    });
  }

  private probing = false;
  private async probeOrRestart(): Promise<void> {
    if (this.probing || !this.child) return;
    this.probing = true;
    try {
      const child = this.child;
      const id = ++this.seq;
      const ok = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { this.pending.delete(id); resolve(false); }, 4000);
        this.pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r.ok); }, timer, op: "ping", startedAt: this.now() });
        try { child.stdin.write(JSON.stringify({ id, op: "ping", args: {} }) + "\n"); } catch { clearTimeout(timer); resolve(false); }
      });
      if (!ok && this.child === child) {
        this.deps.log("worker: wedged — killing for restart");
        try { child.kill(); } catch { /* gone */ }
        try { nodeSpawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* best effort */ }
      }
    } finally { this.probing = false; }
  }

  /** Health for the diagnostics tool: alive, pid, uptime, hook state, stats. */
  async health(): Promise<Record<string, unknown>> {
    if (!this.alive) return { alive: false, ...this.stats };
    const r = await this.call("ping", {}, 4000);
    return r.ok ? { alive: true, ...r.result, ...this.stats } : { alive: false, error: r.error, ...this.stats };
  }

  /** Deliberate stop (idle, app quit, kill switch). In-flight calls are rejected. */
  async stop(reason = "stop"): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stoppedDeliberately = true;
    this.deps.log(`worker: stopping (${reason})`);
    this.rejectAll("worker_stopped", "The computer-control helper was stopped.");
    try { child.stdin.write('{"op":"exit"}\n'); } catch { /* gone */ }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(); }, 1500);
      child.once("exit", () => { clearTimeout(t); resolve(); });
    });
    if (this.child === child) { this.child = null; this.ready = false; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  /** Drop every queued call at once (the kill switch). The worker itself keeps running. */
  cancelAll(): number {
    const n = this.pending.size;
    this.rejectAll("task_cancelled", "The person stopped the task.");
    return n;
  }
}
