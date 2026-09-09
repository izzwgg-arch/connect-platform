/**
 * The desktop link — how the agent's model loop reaches the Loopcom Windows app
 * on the person's own computer, and gets the result back INSIDE THE SAME TURN.
 *
 * ⛔ THE SHAPE, IN ONE PARAGRAPH. The desktop app (Electron main process) says
 * `hello` with a MANIFEST of the tools it can run (its built-in hands plus any MCP
 * server tools it has connected), then long-polls `next` for work. When the model
 * calls one of those tools, `dispatch()` queues the call for THAT person's desktop
 * and awaits the `result` the desktop posts back. The desktop decides locally
 * (policy core, profile, approval dialog) whether the call may run at all — this
 * module never executes anything and never decides anything. It is a mailbox with
 * timeouts.
 *
 * ⛔ KEYED BY THE SERVER-VERIFIED IDENTITY (tenantId + clientUserId). A tool call
 * can only ever be delivered to the desktop that authenticated as the same person
 * the conversation belongs to. There is no "send to desktop X" parameter anywhere.
 *
 * ⛔ IN-MEMORY ON PURPOSE. A tool call that outlives the agent process has no
 * caller left to receive its result; the desktop keeps its own durable task
 * journal, and the conversation history is in the database. Nothing here needs a
 * migration, and a restart drops nothing that could still be used.
 */
import { randomUUID } from "node:crypto";

export type DesktopToolSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type DesktopToolManifest = {
  /** Tool name as the model will see it. `^[a-z][a-z0-9_]{0,63}$`. */
  name: string;
  description: string;
  parameters: DesktopToolSchema;
  /** Policy metadata, declared by the desktop and re-checked THERE before running. */
  category?: string;
  risk?: string;
  domains?: string[];
  /** "builtin" hands or a tool discovered on a connected MCP server. */
  source?: "builtin" | "mcp";
  server?: string;
  timeoutMs?: number;
};

export type DesktopManifest = {
  desktopId: string;
  appVersion: string;
  hostname: string;
  os: string;
  username?: string;
  /** SAFE / TRUSTED / AUTONOMOUS as chosen on the machine. Informational here. */
  profile: string;
  /** The acceptance/test workspace root the desktop exposes, if any. */
  workspace?: string;
  tools: DesktopToolManifest[];
  mcpServers?: { id: string; name: string; state: string; tools: number }[];
};

export type PendingCall = {
  kind: "call";
  id: string;
  name: string;
  args: Record<string, unknown>;
  taskId: string;
  conversationId?: string;
  issuedAt: string;
  timeoutMs: number;
};
export type CancelMessage = { kind: "cancel"; taskId: string | null; issuedAt: string };
export type DesktopMessage = PendingCall | CancelMessage;

export type DesktopCallResult = { ok: boolean; content: unknown; durationMs?: number };

export type LinkIdentity = { tenantId: string; clientUserId: string };

type Waiter = { resolve: (m: DesktopMessage | null) => void; timer: ReturnType<typeof setTimeout> };
type Inflight = { resolve: (r: DesktopCallResult) => void; timer: ReturnType<typeof setTimeout>; taskId: string; name: string; startedAt: number; deadlineMs: number };

type Session = {
  key: string;
  identity: LinkIdentity;
  manifest: DesktopManifest;
  connectedAt: number;
  lastSeen: number;
  queue: DesktopMessage[];
  waiters: Waiter[];
  inflight: Map<string, Inflight>;
  cancelledTasks: Set<string>;
  /** Turns currently running with the hands (registered by the engine's provider). */
  activeTasks: Set<string>;
  /** Tool calls ever dispatched to this desktop, for /status and the harness. */
  stats: { dispatched: number; completed: number; failed: number; timedOut: number; cancelled: number };
};

/** A desktop that has not polled for this long is treated as gone. */
export const DESKTOP_PRESENCE_MS = 90_000;
/** Longest a single tool call may wait for the desktop, whatever it declares. */
export const MAX_CALL_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * How much longer a call may wait once the desktop says an approval prompt is on
 * the screen: the prompt's own lifetime (5 min on the desktop) plus slack. Human
 * time is not tool time — see extend().
 */
export const APPROVAL_WAIT_MS = 5 * 60 * 1000 + 30_000;
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** Longest one long-poll is held open (nginx read timeout is 120 s; stay well under). */
export const MAX_POLL_WAIT_MS = 25_000;
/** Bound on what a desktop may hand back per call; the model's context is finite. */
export const MAX_RESULT_CHARS = 60_000;

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function identityKey(id: LinkIdentity): string {
  return `${id.tenantId}:${id.clientUserId}`;
}

/** Strict, bounded read of a manifest handed over the wire. Unknown/oversized → null. */
export function parseManifest(raw: unknown): { ok: true; manifest: DesktopManifest } | { ok: false; refused: string } {
  if (!raw || typeof raw !== "object") return { ok: false, refused: "not_an_object" };
  const m = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const desktopId = str(m.desktopId, 80);
  if (!desktopId) return { ok: false, refused: "missing_desktop_id" };
  if (!Array.isArray(m.tools)) return { ok: false, refused: "missing_tools" };
  if (m.tools.length > 200) return { ok: false, refused: "too_many_tools" };
  const tools: DesktopToolManifest[] = [];
  const seen = new Set<string>();
  for (const t of m.tools as unknown[]) {
    if (!t || typeof t !== "object") return { ok: false, refused: "bad_tool" };
    const tt = t as Record<string, unknown>;
    const name = str(tt.name, 64);
    if (!TOOL_NAME_RE.test(name)) return { ok: false, refused: `bad_tool_name:${name.slice(0, 32)}` };
    if (seen.has(name)) return { ok: false, refused: `duplicate_tool:${name}` };
    seen.add(name);
    const description = str(tt.description, 2000);
    if (!description) return { ok: false, refused: `tool_without_description:${name}` };
    const p = tt.parameters as Record<string, unknown> | undefined;
    const parameters: DesktopToolSchema = {
      type: "object",
      properties: p && typeof p.properties === "object" && p.properties ? (p.properties as Record<string, unknown>) : {},
      ...(Array.isArray(p?.required) ? { required: (p!.required as unknown[]).filter((r): r is string => typeof r === "string") } : {}),
      additionalProperties: false,
    };
    const domains = Array.isArray(tt.domains) ? (tt.domains as unknown[]).filter((d): d is string => typeof d === "string").slice(0, 10) : [];
    const timeoutMs = typeof tt.timeoutMs === "number" && Number.isFinite(tt.timeoutMs) ? Math.min(Math.max(1000, tt.timeoutMs), MAX_CALL_TIMEOUT_MS) : DEFAULT_CALL_TIMEOUT_MS;
    tools.push({
      name, description, parameters, domains, timeoutMs,
      category: str(tt.category, 32) || undefined,
      risk: str(tt.risk, 16) || undefined,
      source: tt.source === "mcp" ? "mcp" : "builtin",
      server: str(tt.server, 64) || undefined,
    });
  }
  const mcpServers = Array.isArray(m.mcpServers)
    ? (m.mcpServers as unknown[]).slice(0, 50).map((s) => {
        const ss = (s ?? {}) as Record<string, unknown>;
        return { id: str(ss.id, 64), name: str(ss.name, 80), state: str(ss.state, 24), tools: typeof ss.tools === "number" ? ss.tools : 0 };
      })
    : [];
  return {
    ok: true,
    manifest: {
      desktopId,
      appVersion: str(m.appVersion, 40),
      hostname: str(m.hostname, 80),
      os: str(m.os, 80),
      username: str(m.username, 80) || undefined,
      profile: str(m.profile, 16) || "SAFE",
      workspace: str(m.workspace, 400) || undefined,
      tools,
      mcpServers,
    },
  };
}

function boundContent(content: unknown): unknown {
  if (content === undefined) return null;
  let text: string;
  try { text = JSON.stringify(content); } catch { return { error: "unserializable_result" }; }
  if (text.length <= MAX_RESULT_CHARS) return content;
  return { truncated: true, note: `result cut at ${MAX_RESULT_CHARS} characters`, preview: text.slice(0, MAX_RESULT_CHARS) };
}

export class DesktopLink {
  private sessions = new Map<string, Session>();
  constructor(private now: () => number = () => Date.now()) {}

  /** The desktop announced itself (again). Replaces the manifest; keeps the queue. */
  hello(identity: LinkIdentity, manifest: DesktopManifest): { key: string; replaced: boolean } {
    const key = identityKey(identity);
    const existing = this.sessions.get(key);
    const t = this.now();
    if (existing) {
      existing.manifest = manifest;
      existing.lastSeen = t;
      return { key, replaced: true };
    }
    this.sessions.set(key, {
      key, identity, manifest, connectedAt: t, lastSeen: t,
      queue: [], waiters: [], inflight: new Map(), cancelledTasks: new Set(), activeTasks: new Set(),
      stats: { dispatched: 0, completed: 0, failed: 0, timedOut: 0, cancelled: 0 },
    });
    return { key, replaced: false };
  }

  /** The desktop signed off (app quitting). In-flight calls fail immediately. */
  goodbye(identity: LinkIdentity): boolean {
    const s = this.sessions.get(identityKey(identity));
    if (!s) return false;
    for (const [id, f] of s.inflight) {
      clearTimeout(f.timer);
      f.resolve({ ok: false, content: { error: "desktop_disconnected", message: "The Loopcom app on the computer went away before this finished." } });
      s.inflight.delete(id);
      s.stats.failed++;
    }
    for (const w of s.waiters) { clearTimeout(w.timer); w.resolve(null); }
    this.sessions.delete(s.key);
    return true;
  }

  session(identity: LinkIdentity): Session | null {
    return this.sessions.get(identityKey(identity)) ?? null;
  }

  /** Present = said hello and polled within DESKTOP_PRESENCE_MS. */
  connected(identity: LinkIdentity): boolean {
    const s = this.session(identity);
    return !!s && this.now() - s.lastSeen < DESKTOP_PRESENCE_MS;
  }

  manifest(identity: LinkIdentity): DesktopManifest | null {
    return this.connected(identity) ? this.session(identity)!.manifest : null;
  }

  /**
   * Long-poll: the next message for this desktop, or null after `waitMs`.
   * Polling is what keeps presence alive, so a desktop with nothing to do still
   * has to call this every ≤ DESKTOP_PRESENCE_MS.
   */
  next(identity: LinkIdentity, waitMs: number): Promise<DesktopMessage | null> {
    const s = this.session(identity);
    if (!s) return Promise.resolve(null);
    s.lastSeen = this.now();
    const queued = s.queue.shift();
    if (queued) return Promise.resolve(queued);
    const wait = Math.min(Math.max(0, waitMs), MAX_POLL_WAIT_MS);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          s.waiters = s.waiters.filter((w) => w !== waiter);
          resolve(null);
        }, wait),
      };
      s.waiters.push(waiter);
    });
  }

  private deliver(s: Session, msg: DesktopMessage): void {
    const w = s.waiters.shift();
    if (w) { clearTimeout(w.timer); w.resolve(msg); return; }
    s.queue.push(msg);
  }

  /**
   * Queue one tool call for the person's desktop and wait for its result.
   * Resolves (never rejects) so the model always gets an answer it can reason
   * about: a timeout, a disconnect and a cancellation are all results.
   */
  dispatch(
    identity: LinkIdentity,
    call: { name: string; args: Record<string, unknown>; taskId: string; conversationId?: string; timeoutMs?: number },
  ): Promise<DesktopCallResult> {
    const s = this.session(identity);
    if (!s || !this.connected(identity)) {
      return Promise.resolve({ ok: false, content: { error: "desktop_not_connected", message: "The Loopcom app on the person's computer is not connected right now, so nothing can run there." } });
    }
    if (s.cancelledTasks.has(call.taskId)) {
      return Promise.resolve({ ok: false, content: { error: "task_cancelled", message: "The person cancelled this task." } });
    }
    const timeoutMs = Math.min(Math.max(1000, call.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS), MAX_CALL_TIMEOUT_MS);
    const id = randomUUID();
    const startedAt = this.now();
    s.stats.dispatched++;
    return new Promise<DesktopCallResult>((resolve) => {
      const timer = setTimeout(() => this.expire(s, id), timeoutMs);
      s.inflight.set(id, { resolve, timer, taskId: call.taskId, name: call.name, startedAt, deadlineMs: timeoutMs });
      this.deliver(s, {
        kind: "call", id, name: call.name, args: call.args, taskId: call.taskId,
        conversationId: call.conversationId, issuedAt: new Date(startedAt).toISOString(), timeoutMs,
      });
    });
  }

  /** The deadline passed: the model gets a timeout RESULT (never a rejection). */
  private expire(s: Session, id: string): void {
    const f = s.inflight.get(id);
    if (!f) return;
    s.inflight.delete(id);
    s.stats.timedOut++;
    f.resolve({ ok: false, content: { error: "desktop_timeout", message: `The computer did not finish "${f.name}" within ${Math.round(f.deadlineMs / 1000)} seconds.` }, durationMs: this.now() - f.startedAt });
  }

  /**
   * The desktop is waiting on the PERSON for this call — an approval prompt is on
   * their screen. Human time is not tool time: push the deadline out by the
   * prompt's lifetime, so the model is not handed "desktop_timeout" — and does
   * not ask AGAIN, raising a second prompt — while the first prompt still stands.
   * (2026-09-09: a delete asked; the person took 64 s; the tool's 60 s timeout
   * fired; the model retried; two prompts stood and the first answer "arrived
   * late".) Unknown or already-settled ids → false. Bounded: one extension is at
   * most APPROVAL_WAIT_MS, and an unanswered prompt still expires.
   */
  extend(identity: LinkIdentity, callId: string, extraMs: number): boolean {
    const s = this.session(identity);
    if (!s) return false;
    s.lastSeen = this.now();
    const f = s.inflight.get(callId);
    if (!f) return false;
    const ms = Math.min(Math.max(1000, extraMs), APPROVAL_WAIT_MS);
    clearTimeout(f.timer);
    f.deadlineMs += ms;
    f.timer = setTimeout(() => this.expire(s, callId), ms);
    return true;
  }

  /** The desktop reports what happened. Unknown/expired ids are ignored (false). */
  result(identity: LinkIdentity, callId: string, r: { ok: boolean; content: unknown }): boolean {
    const s = this.session(identity);
    if (!s) return false;
    s.lastSeen = this.now();
    const f = s.inflight.get(callId);
    if (!f) return false;
    clearTimeout(f.timer);
    s.inflight.delete(callId);
    if (r.ok) s.stats.completed++; else s.stats.failed++;
    f.resolve({ ok: !!r.ok, content: boundContent(r.content), durationMs: this.now() - f.startedAt });
    return true;
  }

  /**
   * Cancel: every in-flight call for the task (or ALL tasks when null) is failed
   * back to the model at once, further dispatches for it are refused, and the
   * desktop is told so it can stop subprocesses and the browser.
   */
  cancel(identity: LinkIdentity, taskId: string | null): { cancelled: number; flagged: number } {
    const s = this.session(identity);
    if (!s) return { cancelled: 0, flagged: 0 };
    let n = 0;
    for (const [id, f] of s.inflight) {
      if (taskId && f.taskId !== taskId) continue;
      clearTimeout(f.timer);
      s.inflight.delete(id);
      s.stats.cancelled++;
      n++;
      f.resolve({ ok: false, content: { error: "task_cancelled", message: "The person cancelled this task. Stop and report what was and was not done." } });
    }
    // ⛔ Flag ACTIVE tasks too, not only the ones with a call in flight: a cancel
    // that lands while the model is between tool calls (planning, or waiting on
    // the provider) must still refuse the next dispatch, or the job carries on.
    if (taskId) s.cancelledTasks.add(taskId);
    else { for (const f of s.inflight.values()) s.cancelledTasks.add(f.taskId); for (const t of s.activeTasks) s.cancelledTasks.add(t); }
    this.deliver(s, { kind: "cancel", taskId, issuedAt: new Date(this.now()).toISOString() });
    return { cancelled: n, flagged: s.cancelledTasks.size };
  }

  isCancelled(identity: LinkIdentity, taskId: string): boolean {
    return !!this.session(identity)?.cancelledTasks.has(taskId);
  }

  /**
   * A turn with the hands began. ⛔ Registered BEFORE the first tool call so a
   * cancel that lands while the model is still planning (no call in flight yet)
   * still stops the job: every later dispatch for the task is refused.
   */
  beginTask(identity: LinkIdentity, taskId: string): void {
    this.session(identity)?.activeTasks.add(taskId);
  }

  /** The task finished (any outcome): its flags no longer need remembering. */
  endTask(identity: LinkIdentity, taskId: string): void {
    const s = this.session(identity);
    s?.cancelledTasks.delete(taskId);
    s?.activeTasks.delete(taskId);
  }

  status(identity: LinkIdentity) {
    const s = this.session(identity);
    if (!s) return { connected: false as const };
    return {
      connected: this.connected(identity),
      desktopId: s.manifest.desktopId,
      appVersion: s.manifest.appVersion,
      hostname: s.manifest.hostname,
      profile: s.manifest.profile,
      tools: s.manifest.tools.length,
      mcpServers: s.manifest.mcpServers ?? [],
      lastSeenMsAgo: this.now() - s.lastSeen,
      inflight: [...s.inflight.values()].map((f) => ({ name: f.name, taskId: f.taskId, runningMs: this.now() - f.startedAt })),
      activeTasks: [...s.activeTasks],
      queued: s.queue.length,
      stats: { ...s.stats },
    };
  }

  /** Drop sessions nobody has polled for a long time. Called on a timer by the server. */
  sweep(idleMs = 10 * 60 * 1000): number {
    let n = 0;
    for (const s of [...this.sessions.values()]) {
      if (this.now() - s.lastSeen > idleMs && s.inflight.size === 0) { this.goodbye(s.identity); n++; }
    }
    return n;
  }
}
