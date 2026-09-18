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
  /**
   * Random, new on every LAUNCH of the app (the desktopId identifies the machine
   * and survives restarts; this identifies the run). ⛔ It is what makes "open
   * Loopcom on the computer you are sitting at and new work goes there" true: a
   * re-hello from the SAME run must not reshuffle anything, but a fresh run is a
   * fresh connection. Absent from apps older than 2026-09-18.
   */
  launchId?: string;
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
/**
 * The turn that owned this task is over (any outcome). ⛔ NOT a cancel: nothing is
 * aborted and nothing failed. It exists because the desktop otherwise has no way to
 * know a task ended — it only ever sees calls arrive — and a screen-control session
 * whose task has finished would sit there holding the screen until it timed out,
 * refusing the NEXT task with `screen_busy`. Older apps ignore unknown kinds.
 */
export type TaskDoneMessage = { kind: "task_done"; taskId: string; issuedAt: string };
export type DesktopMessage = PendingCall | CancelMessage | TaskDoneMessage;

export type DesktopCallResult = { ok: boolean; content: unknown; durationMs?: number };

export type LinkIdentity = { tenantId: string; clientUserId: string };

type Waiter = { resolve: (m: DesktopMessage | null) => void; timer: ReturnType<typeof setTimeout> };
type Inflight = { resolve: (r: DesktopCallResult) => void; timer: ReturnType<typeof setTimeout>; taskId: string; name: string; startedAt: number; deadlineMs: number };

type Session = {
  key: string;
  identity: LinkIdentity;
  /** ⛔ ONE SESSION PER COMPUTER, not per person — see sessionKey(). */
  desktopId: string;
  manifest: DesktopManifest;
  connectedAt: number;
  /** Last POLL. Presence only — a poll is a heartbeat, not work. */
  lastSeen: number;
  /** Last hello (app start, manifest change, every 5 min). */
  helloAt: number;
  /** Last time a tool call was actually sent to or answered by THIS computer. */
  lastActivityAt: number;
  /**
   * This session has been polled by an app that NAMED itself. ⛔ Once true, an
   * unnamed poll may never touch it again — see `unnamedPoller`.
   */
  sawNamedPoll: boolean;
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

/**
 * How recently this computer CONNECTED. ⛔ Deliberately not the last poll (every
 * linked machine polls forever whether or not anybody is at it), not the periodic
 * re-hello (which would reshuffle two idle machines every five minutes), and not
 * the last tool call (that is the AGENT's own doing — ranking on it makes the
 * first pick self-reinforcing and leaves the person no way to redirect the work).
 * The app's connection is the one signal the PERSON controls: open Loopcom on the
 * machine you are sitting at and new tasks go there.
 */
function rank(s: { connectedAt: number }): number {
  return s.connectedAt;
}

export function identityKey(id: LinkIdentity): string {
  return `${id.tenantId}:${id.clientUserId}`;
}

/**
 * ⛔⛔ THE SESSION IS PER COMPUTER, NOT PER PERSON (2026-09-18).
 *
 * It used to be keyed on the identity alone, and ONE person with TWO computers
 * signed into the same Loopcom account therefore shared a single queue: the model
 * was shown machine A's tool list while `deliver()` handed the call to whichever
 * machine's long-poll happened to be at the head of the waiter list. Proven on
 * this very repo — a desktop advertising 72 tools was asked to open Notepad and
 * the file appeared on a DIFFERENT computer (an older build, 34 tools, another
 * user profile). A person with a desktop and a laptop would have had their work
 * land on whichever one the race picked.
 *
 * So: every computer gets its own session, and a TASK is bound to the computer it
 * started on (see `preferredKey` / `taskDesktop`) so a multi-step job can never
 * jump machines half way through.
 */
export function sessionKey(id: LinkIdentity, desktopId: string): string {
  return `${identityKey(id)}|${desktopId || "legacy"}`;
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
      launchId: str(m.launchId, 80) || undefined,
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

/**
 * A screenshot for the model to SEE gets its own, larger ceiling (≈675 KB of
 * base64) so `boundContent` never truncates the picture into garbage; the REST of
 * the result is still held to MAX_RESULT_CHARS. Kept well under nginx's 1 MB body
 * limit for /agent-api/.
 */
export const MAX_IMAGE_CHARS = 900_000;

export function boundContent(content: unknown): unknown {
  if (content === undefined) return null;
  // Image-bearing result (a Coworker screen tool): keep a bounded image, bound the rest apart.
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const c = content as Record<string, unknown>;
    const img = c.image as Record<string, unknown> | undefined;
    if (img && typeof img === "object" && typeof img.dataBase64 === "string") {
      const rest: Record<string, unknown> = { ...c };
      delete rest.image;
      let restText: string;
      try { restText = JSON.stringify(rest); } catch { restText = "{}"; }
      const restBounded: unknown = restText.length <= MAX_RESULT_CHARS ? rest : { truncated: true, note: `result cut at ${MAX_RESULT_CHARS} characters`, preview: restText.slice(0, MAX_RESULT_CHARS) };
      if (img.dataBase64.length > MAX_IMAGE_CHARS) {
        return { ...(restBounded as object), imageDropped: true, note: "The screenshot was too large to include; act from the control list (computer_screen_read)." };
      }
      const mt = typeof img.mediaType === "string" ? img.mediaType : "image/png";
      return { ...(restBounded as object), image: { mediaType: mt, dataBase64: img.dataBase64, ...(typeof img.width === "number" ? { width: img.width } : {}), ...(typeof img.height === "number" ? { height: img.height } : {}) } };
    }
  }
  let text: string;
  try { text = JSON.stringify(content); } catch { return { error: "unserializable_result" }; }
  if (text.length <= MAX_RESULT_CHARS) return content;
  return { truncated: true, note: `result cut at ${MAX_RESULT_CHARS} characters`, preview: text.slice(0, MAX_RESULT_CHARS) };
}

export class DesktopLink {
  private sessions = new Map<string, Session>();
  /** taskId → session key: a task stays on the computer it started on. */
  private taskDesktop = new Map<string, string>();
  /**
   * Told when the desktop reports an approval prompt on the person's screen, with
   * the tool it is for — the Coworker workspace shows that step as "waiting for your
   * OK" instead of spinning. ⛔ Display only; never consulted for any decision.
   */
  onAwaitingApproval: ((identity: LinkIdentity, tool: string) => void) | null = null;
  constructor(private now: () => number = () => Date.now()) {}

  /** The desktop announced itself (again). Replaces the manifest; keeps the queue. */
  hello(identity: LinkIdentity, manifest: DesktopManifest): { key: string; replaced: boolean; reconnected?: boolean } {
    const key = sessionKey(identity, manifest.desktopId);
    const existing = this.sessions.get(key);
    const t = this.now();
    if (existing) {
      // ⛔ A NEW RUN of the app is a new connection, and that is the only thing the
      // PERSON can do to say "work here": quitting and reopening Loopcom on the
      // machine in front of them must put it back in front of the queue. A periodic
      // re-hello from the same run must NOT (it would reshuffle idle machines every
      // five minutes). Older apps send no launchId, so they keep their original
      // connection time and simply never jump the queue.
      // ⛔⛔ ONLY a genuine relaunch, proven by a changed launchId. An earlier version
      // of this also counted "has not polled for a while" as a reconnect, and that
      // handed the queue to exactly the wrong machine: an app too old to name itself
      // gets nothing from `unnamedPoller`, so its polls never refresh `lastSeen`, so
      // EVERY one of its five-minute hellos looked like a return and put it back in
      // front of the computer the person was actually using. Proven live — an rc.10
      // machine took the preferred slot mid-acceptance-run and a newer machine's work
      // went to it. An app that cannot name its run simply keeps its place.
      const relaunched = !!manifest.launchId && !!existing.manifest.launchId && manifest.launchId !== existing.manifest.launchId;
      if (relaunched) existing.connectedAt = t;
      existing.manifest = manifest;
      existing.lastSeen = t;
      existing.helloAt = t;
      return { key, replaced: true, reconnected: relaunched };
    }
    this.sessions.set(key, {
      key, identity, desktopId: manifest.desktopId, manifest, connectedAt: t, lastSeen: t, helloAt: t, lastActivityAt: 0, sawNamedPoll: false,
      queue: [], waiters: [], inflight: new Map(), cancelledTasks: new Set(), activeTasks: new Set(),
      stats: { dispatched: 0, completed: 0, failed: 0, timedOut: 0, cancelled: 0 },
    });
    return { key, replaced: false };
  }

  /** Every computer this person has linked, the one new work would go to first. */
  sessionsFor(identity: LinkIdentity): Session[] {
    const prefix = `${identityKey(identity)}|`;
    // ⛔ The tiebreak is not decoration: two apps started by the same script can
    // connect inside one millisecond, and without it the order (hence which
    // computer new work goes to) depends on Map insertion order.
    return [...this.sessions.values()].filter((s) => s.key.startsWith(prefix)).sort((a, b) => rank(b) - rank(a) || a.desktopId.localeCompare(b.desktopId));
  }

  /**
   * The computer a NEW task should run on: the most recently CONNECTED one that is
   * still present (see `rank`). Presence comes first — a machine that stopped
   * polling is skipped however recently it connected — and a task, once started,
   * stays where it started whatever happens to this ordering.
   */
  private preferred(identity: LinkIdentity): Session | null {
    const all = this.sessionsFor(identity);
    const live = all.filter((s) => this.now() - s.lastSeen < DESKTOP_PRESENCE_MS);
    return live[0] ?? all[0] ?? null;
  }

  /** The desktop signed off (app quitting). In-flight calls fail immediately. */
  goodbye(identity: LinkIdentity, desktopId?: string): boolean {
    // ⛔ An unnamed goodbye may only close the session it can be sure of — otherwise
    // an old app quitting would disconnect the machine the person is actually using.
    const s = desktopId ? this.sessions.get(sessionKey(identity, desktopId)) : this.unnamedPoller(identity);
    if (!s) return false;
    for (const [id, f] of s.inflight) {
      clearTimeout(f.timer);
      f.resolve({ ok: false, content: { error: "desktop_disconnected", message: "The Loopcom app on the computer went away before this finished." } });
      s.inflight.delete(id);
      s.stats.failed++;
    }
    for (const w of s.waiters) { clearTimeout(w.timer); w.resolve(null); }
    this.sessions.delete(s.key);
    for (const [task, key] of this.taskDesktop) if (key === s.key) this.taskDesktop.delete(task);
    return true;
  }

  /**
   * One computer's session. `desktopId` names it (the app sends it on every call);
   * without one this is the preferred computer — see `unnamedPoller` for why that
   * is NOT good enough when the person has more than one computer.
   */
  session(identity: LinkIdentity, desktopId?: string): Session | null {
    if (desktopId) return this.sessions.get(sessionKey(identity, desktopId)) ?? null;
    return this.preferred(identity);
  }

  /**
   * Which session an app that did NOT name itself is allowed to act on.
   *
   * ⛔⛔ An app older than 2026-09-18 sends no `x-loopcom-desktop-id`, so when it
   * long-polls there is NOTHING in the request that says which computer it is. If
   * we fall back to "the preferred computer" it sits on the NEWER machine's queue
   * and is handed that machine's work — the exact bug this change exists to kill,
   * re-opened for anyone with an old build still running somewhere. Proven live:
   * one account here had three computers linked, two of them old builds.
   *
   * So an unnamed poller may act only when BOTH hold:
   *   1. exactly one computer is present (every single-computer customer — the
   *      ordinary case), and
   *   2. that computer has never been polled by an app that named itself.
   *
   * ⛔⛔ Rule 2 is the one that matters and it was missing at first. A CURRENT app
   * always names itself, so an unnamed poll can never be that app — but when the
   * other machines happened to fall out of presence, "exactly one present" was the
   * current machine, and an old app's poll was handed ITS work. Proven live: three
   * computers on one account, and an acceptance run's tool calls vanished onto an
   * rc.10 machine whenever the other two went quiet. Once a session has answered a
   * named poll it is off limits to unnamed ones for good.
   */
  private unnamedPoller(identity: LinkIdentity): Session | null {
    const present = this.sessionsFor(identity).filter((s) => this.now() - s.lastSeen < DESKTOP_PRESENCE_MS);
    if (present.length !== 1) return null;
    const only = present[0];
    if (only.sawNamedPoll || only.manifest.launchId) return null;
    return only;
  }

  /** Present = said hello and polled within DESKTOP_PRESENCE_MS (any computer, or the named one). */
  connected(identity: LinkIdentity, desktopId?: string): boolean {
    const s = this.session(identity, desktopId);
    return !!s && this.now() - s.lastSeen < DESKTOP_PRESENCE_MS;
  }

  manifest(identity: LinkIdentity): DesktopManifest | null {
    const s = this.preferred(identity);
    return s && this.now() - s.lastSeen < DESKTOP_PRESENCE_MS ? s.manifest : null;
  }

  /**
   * Long-poll: the next message for this desktop, or null after `waitMs`.
   * Polling is what keeps presence alive, so a desktop with nothing to do still
   * has to call this every ≤ DESKTOP_PRESENCE_MS.
   */
  next(identity: LinkIdentity, waitMs: number, desktopId?: string): Promise<DesktopMessage | null> {
    const s = desktopId ? this.session(identity, desktopId) : this.unnamedPoller(identity);
    if (!s) return Promise.resolve(null);
    if (desktopId) s.sawNamedPoll = true;
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
    // ⛔ A task stays on the computer it started on. The first call picks the
    // preferred computer and binds the task to it; every later call of the same
    // task follows that binding, so a job cannot finish on a different machine
    // from the one it read the window on. If that computer went away, the task
    // re-binds to the one that is present and says so in the result.
    const bound = this.taskDesktop.get(call.taskId);
    let s = bound ? this.sessions.get(bound) ?? null : null;
    let moved = false;
    if (s && this.now() - s.lastSeen >= DESKTOP_PRESENCE_MS) { s = null; moved = true; }
    if (!s) {
      s = this.preferred(identity);
      if (s) this.taskDesktop.set(call.taskId, s.key);
    }
    if (!s || this.now() - s.lastSeen >= DESKTOP_PRESENCE_MS) {
      return Promise.resolve({ ok: false, content: { error: "desktop_not_connected", message: "The Loopcom app on the person's computer is not connected right now, so nothing can run there." } });
    }
    if (moved) {
      return Promise.resolve({ ok: false, content: { error: "desktop_changed", message: `The computer this task was running on (${bound?.split("|")[1] ?? "?"}) went away. Anything already done stayed there. Say what was finished and ask the person before carrying on somewhere else.` } });
    }
    if (s.cancelledTasks.has(call.taskId)) {
      return Promise.resolve({ ok: false, content: { error: "task_cancelled", message: "The person cancelled this task." } });
    }
    const timeoutMs = Math.min(Math.max(1000, call.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS), MAX_CALL_TIMEOUT_MS);
    const id = randomUUID();
    const startedAt = this.now();
    s.stats.dispatched++;
    s.lastActivityAt = startedAt;
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
  /** The computer holding this call id (whichever of the person's computers it is). */
  private holder(identity: LinkIdentity, callId: string): Session | null {
    for (const s of this.sessionsFor(identity)) if (s.inflight.has(callId)) return s;
    return null;
  }

  extend(identity: LinkIdentity, callId: string, extraMs: number): boolean {
    const s = this.holder(identity, callId);
    if (!s) return false;
    s.lastSeen = this.now();
    const f = s.inflight.get(callId);
    if (!f) return false;
    const ms = Math.min(Math.max(1000, extraMs), APPROVAL_WAIT_MS);
    clearTimeout(f.timer);
    f.deadlineMs += ms;
    f.timer = setTimeout(() => this.expire(s, callId), ms);
    try { this.onAwaitingApproval?.(identity, f.name); } catch { /* display only */ }
    return true;
  }

  /** The desktop reports what happened. Unknown/expired ids are ignored (false). */
  result(identity: LinkIdentity, callId: string, r: { ok: boolean; content: unknown }): boolean {
    const s = this.holder(identity, callId);
    if (!s) return false;
    s.lastSeen = this.now();
    const f = s.inflight.get(callId);
    if (!f) return false;
    clearTimeout(f.timer);
    s.inflight.delete(callId);
    s.lastActivityAt = this.now();
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
    // ⛔ STOP MEANS STOP ON EVERY COMPUTER. The person pressed one button; they
    // do not know (or care) which of their machines the job landed on.
    const all = this.sessionsFor(identity);
    if (!all.length) return { cancelled: 0, flagged: 0 };
    let n = 0;
    let flagged = 0;
    for (const s of all) {
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
      flagged += s.cancelledTasks.size;
    }
    return { cancelled: n, flagged };
  }

  isCancelled(identity: LinkIdentity, taskId: string): boolean {
    return this.sessionsFor(identity).some((s) => s.cancelledTasks.has(taskId));
  }

  /**
   * A turn with the hands began. ⛔ Registered BEFORE the first tool call so a
   * cancel that lands while the model is still planning (no call in flight yet)
   * still stops the job: every later dispatch for the task is refused.
   */
  beginTask(identity: LinkIdentity, taskId: string): void {
    for (const s of this.sessionsFor(identity)) s.activeTasks.add(taskId);
  }

  /**
   * The task finished (any outcome): its flags and its computer binding go, and the
   * computer it ran on is TOLD, so anything it was holding for that task (a screen
   * control session) can be let go at once instead of waiting to time out.
   */
  endTask(identity: LinkIdentity, taskId: string): void {
    const bound = this.taskDesktop.get(taskId);
    const owner = bound ? this.sessions.get(bound) : null;
    if (owner) this.deliver(owner, { kind: "task_done", taskId, issuedAt: new Date(this.now()).toISOString() });
    for (const s of this.sessionsFor(identity)) { s.cancelledTasks.delete(taskId); s.activeTasks.delete(taskId); }
    this.taskDesktop.delete(taskId);
  }

  status(identity: LinkIdentity) {
    const s = this.preferred(identity);
    if (!s) return { connected: false as const };
    const all = this.sessionsFor(identity);
    return {
      connected: this.now() - s.lastSeen < DESKTOP_PRESENCE_MS,
      // ⛔ More than one computer signed into this account is normal, and which one
      // a task runs on is decided per task — so say so instead of pretending there
      // is only ever one.
      desktops: all.map((x) => ({ desktopId: x.manifest.desktopId, hostname: x.manifest.hostname, appVersion: x.manifest.appVersion, tools: x.manifest.tools.length, lastSeenMsAgo: this.now() - x.lastSeen, lastActivityMsAgo: x.lastActivityAt ? this.now() - x.lastActivityAt : null, present: this.now() - x.lastSeen < DESKTOP_PRESENCE_MS, preferred: x.key === s.key })),
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
      if (this.now() - s.lastSeen > idleMs && s.inflight.size === 0) { this.goodbye(s.identity, s.desktopId); n++; }
    }
    return n;
  }
}
