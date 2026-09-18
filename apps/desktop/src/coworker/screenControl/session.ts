/**
 * Screen control — the PURE heart. No Electron, no fs, no PowerShell.
 *
 * This is the deterministic logic behind the Coworker driving the person's real
 * desktop: the state machine, the "ask once then flow" consent rule, the map from
 * a model tool call to a sanitized OS input command, and the yield decision that
 * hands the mouse back the instant the person touches it. It is pure so the whole
 * of it can be exhaustively unit- and stress-tested without a screen (the Electron
 * surface in screenController.ts calls into this and adds nothing the tests can't see).
 *
 * ⛔ THE ONE PHYSICAL SCREEN IS A SHARED, SINGLE-OWNER RESOURCE. Only one task may
 * control it at a time, and only after a live approval for THAT task. A second
 * task cannot inherit the first task's consent — `isApprovedFor` is per task id.
 *
 * ⛔ WE NEVER FIGHT THE PERSON FOR THE CURSOR (Izzy, 2026-09-15: "one mouse, I'll
 * live with that"). Every input we inject is stamped with SCREEN_CONTROL_SIGNATURE
 * so the low-level hook can tell our own events from the person's; a real event
 * from the person pauses us at once.
 */

import { sanitizeCommand, type InputCommand } from "../../remoteSupport/inputInjector";

/**
 * The magic marker written into every injected event's `dwExtraInfo`. The yield
 * watcher reads it back off the low-level hook: an event carrying it is ours and
 * is ignored; an event without it is the person and pauses us. A fixed 32-bit
 * constant, chosen to be recognizable in a trace and nothing a normal app emits.
 */
export const SCREEN_CONTROL_SIGNATURE = 0x10_0c_c0_1c; // "LooC" ish

export type ScreenControlState =
  /** No session; the overlay is down; nothing is being driven. */
  | "idle"
  /** A session is open and approved; the Coworker is driving. Frame: blue. */
  | "working"
  /** The person touched the mouse or keyboard; we stepped aside. Frame: grey. */
  | "paused"
  /** Stopped on an approval question that is on screen. Frame: amber. */
  | "asking"
  /** Torn down (end / Escape / cancel / call started). Terminal. */
  | "ended";

/** The frame colour the overlay shows for each state — the mockup's four states. */
export const STATE_FRAME: Record<ScreenControlState, "blue" | "grey" | "amber" | "green" | "none"> = {
  idle: "none",
  working: "blue",
  paused: "grey",
  asking: "amber",
  ended: "green",
};

export type ScreenActionName =
  | "computer_screen_click"
  | "computer_screen_type"
  | "computer_screen_key"
  | "computer_screen_scroll"
  | "computer_screen_move";

/**
 * Map a model tool call to ONE sanitized OS input command, or null if the args do
 * not describe a valid action. Coordinates are 0..1 fractions of the virtual
 * desktop (the sender never needs the person's resolution), exactly as remote
 * support already sends them, and go through the SAME `sanitizeCommand` trust
 * boundary — a malformed fraction refuses the command, it never defaults to a
 * corner of the real screen.
 *
 * ⛔ Returns null (refuse) rather than a "best effort" for anything it cannot make
 * safe. A dropped action is always better than an action somewhere nobody asked.
 */
export function screenArgsToCommand(name: ScreenActionName, args: Record<string, unknown>): InputCommand | null {
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const x = num(args.x);
  const y = num(args.y);
  switch (name) {
    case "computer_screen_move":
      if (x === undefined || y === undefined) return null;
      return sanitizeCommand({ kind: "move", x, y });
    case "computer_screen_click": {
      if (x === undefined || y === undefined) return null;
      const button = args.button === "right" || args.button === "middle" ? args.button : "left";
      return sanitizeCommand({ kind: "click", x, y, button, double: args.double === true });
    }
    case "computer_screen_scroll": {
      if (x === undefined || y === undefined) return null;
      const deltaY = num(args.amount) ?? num(args.deltaY);
      if (deltaY === undefined || deltaY === 0) return null;
      // 120 units == one notch, matching a real wheel.
      return sanitizeCommand({ kind: "scroll", x, y, deltaY: deltaY * 120 });
    }
    case "computer_screen_type": {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) return null;
      return sanitizeCommand({ kind: "text", text });
    }
    case "computer_screen_key": {
      const key = typeof args.key === "string" ? args.key : "";
      if (!key) return null;
      const modifiers = Array.isArray(args.modifiers) ? args.modifiers.map((m) => String(m)) : undefined;
      return sanitizeCommand({ kind: "key", key, modifiers });
    }
    default:
      return null;
  }
}

/** A low-level input event as the yield hook reports it (pure shape, no Windows types). */
export type ObservedInput = {
  /** True when the event carried our SCREEN_CONTROL_SIGNATURE — i.e. we caused it. */
  synthetic: boolean;
  /** "mouse" | "keyboard" — for the log only; both pause us. */
  source: "mouse" | "keyboard";
};

/**
 * The yield decision, pure. The person's OWN input (not our synthetic events),
 * while we are working, pauses us. Our own injected events never pause us, or the
 * Coworker would stop itself the instant it moved the mouse.
 *
 * ⛔ Synthetic-first: a hook that cannot read the signature (returns synthetic
 * undefined) is treated as the PERSON, because failing safe here means "hand the
 * mouse back", never "keep driving through the person".
 */
export function shouldYieldTo(event: ObservedInput, state: ScreenControlState): boolean {
  if (state !== "working") return false;
  return event.synthetic !== true;
}

/**
 * The single-owner, ask-once-then-flow session.
 *
 * ⛔ `begin()` is the ONLY transition that requires a fresh approval; it records
 * the owning task. Every subsequent action for that SAME task is `isApprovedFor`
 * → true and flows without re-asking (Izzy's chosen autonomy: ask once to start,
 * then work; the risky domains — delete/pay/send/admin — ride their own tools and
 * still ask through the ordinary policy gate). A different task is never approved
 * by this session and must run its own `begin()`.
 */
export class ScreenControlSession {
  private state: ScreenControlState = "idle";
  private ownerTaskId: string | null = null;
  private approvedAt = 0;
  /** When this session last did anything. Drives the abandoned-session rule below. */
  private lastActionAt = 0;
  private resumeTimer: number | null = null;

  constructor(private now: () => number = () => Date.now()) {}

  getState(): ScreenControlState {
    return this.state;
  }
  owner(): string | null {
    return this.ownerTaskId;
  }
  frame(): "blue" | "grey" | "amber" | "green" | "none" {
    return STATE_FRAME[this.state];
  }

  /** True when this exact task holds an OPEN, approved session (working or paused). */
  isApprovedFor(taskId: string): boolean {
    return this.ownerTaskId === taskId && (this.state === "working" || this.state === "paused" || this.state === "asking");
  }

  /** Is anyone driving the screen right now? (For "one owner at a time".) */
  isBusy(): boolean {
    return this.state === "working" || this.state === "paused" || this.state === "asking";
  }

  /**
   * Open control for a task after its approval landed. Refuses if another task is
   * already driving — one physical screen, one owner. Returns false without
   * changing state on refusal.
   */
  /** Something happened in this session — resets the abandoned-session clock. */
  touch(): void {
    this.lastActionAt = this.now();
  }
  /** How long since this session did anything (since it opened, if it never has). */
  idleMs(): number {
    if (!this.isBusy()) return 0;
    return this.now() - (this.lastActionAt || this.approvedAt);
  }
  /**
   * ⛔⛔ AN ABANDONED SESSION MUST NOT LOCK THE SCREEN. A turn can die without ever
   * calling `computer_screen_end` — the chat is closed, the agent restarts, the
   * person walks away mid-task. Before this, the session simply stayed open until
   * the FOUR HOUR ceiling, and every later task was refused `screen_busy`: one
   * interrupted job took the whole feature out for the rest of the day. Proven the
   * hard way — an acceptance run killed mid-task made every following run fail.
   */
  isStale(idleMs: number = SCREEN_IDLE_END_MS): boolean {
    return this.isBusy() && this.idleMs() >= idleMs;
  }

  begin(taskId: string): boolean {
    if (this.isBusy() && this.ownerTaskId !== taskId) {
      // Another task holds the screen. Take it over ONLY if that task has clearly
      // been abandoned; a session that is actually working is never interrupted.
      if (!this.isStale()) return false;
      this.end();
      this.reset();
    }
    this.ownerTaskId = taskId;
    this.approvedAt = this.now();
    this.lastActionAt = this.now();
    this.state = "working";
    return true;
  }

  /** The person touched the mouse/keyboard — step aside. No-op unless working. */
  pause(): boolean {
    if (this.state !== "working") return false;
    this.state = "paused";
    return true;
  }

  /** Resume driving after the person has been idle again. No-op unless paused. */
  resume(): boolean {
    if (this.state !== "paused") return false;
    this.state = "working";
    return true;
  }

  /** Enter the amber "waiting on a Yes/No" state (a risky sub-action asked). */
  asking(): void {
    if (this.isBusy()) this.state = "asking";
  }
  /** Leave the amber state back to driving. */
  answered(): void {
    if (this.state === "asking") this.state = "working";
  }

  /** Tear the session down — end, Escape, cancel, or a call starting. Terminal. */
  end(): void {
    this.state = "ended";
    this.ownerTaskId = null;
    if (this.resumeTimer !== null) this.resumeTimer = null;
  }

  /** Back to a clean slate so a later task can begin fresh. */
  reset(): void {
    this.state = "idle";
    this.ownerTaskId = null;
    this.approvedAt = 0;
    this.lastActionAt = 0;
  }

  /** How long this session has been open, ms. For the hard ceiling. */
  ageMs(): number {
    return this.approvedAt ? this.now() - this.approvedAt : 0;
  }
}

/** The hard ceiling: no screen-control session outlives four hours (call-limit parity). */
export const SCREEN_SESSION_MAX_MS = 4 * 60 * 60 * 1000;

/** After the person stops touching input, wait this long before resuming on our own. */
export const RESUME_AFTER_IDLE_MS = 2500;

/**
 * A screen-control session that has done NOTHING for this long is treated as
 * abandoned: it ends itself, and another task may take the screen. ⛔ Not a
 * convenience — without it one interrupted task holds the screen until the 4-hour
 * ceiling and every later task is refused.
 */
export const SCREEN_IDLE_END_MS = 3 * 60 * 1000;
