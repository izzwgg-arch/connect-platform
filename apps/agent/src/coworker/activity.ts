/**
 * The Coworker's live activity feed — what the chat shows WHILE a turn runs.
 *
 * Izzy, 2026-09-15: *"Just like it's saying 'Using tool', it's running command
 * stuff, just like active, so the user can see what's going on. No code, though."*
 *
 * ⛔ THE SHAPE. A chat message is still ONE HTTP request that returns when the turn
 * is over (nginx gives /agent-api/ 900 s). The page picks a random `turnId`, sends it
 * with the message, and polls `/agent/coworker/activity` for this turn's events
 * while the request is open. Every event carries a sequence number, so a poll that
 * is late, duplicated or made from a SECOND window (the bubble and the full page
 * watching the same task) simply asks for "everything after N".
 *
 * ⛔ OWNED BY THE VERIFIED IDENTITY. A turn is opened by the tenant+user that sent
 * the message; every read, answer and stop is refused unless it comes from that same
 * identity. A turnId is not a capability.
 *
 * ⛔ IN MEMORY ON PURPOSE, like desktopLink.ts. A turn that outlives the agent
 * process has no request left to finish it; the conversation and its messages live
 * in the database, and the finished steps are written to the audit log.
 *
 * ⛔ A QUESTION IS ESCAPABLE (memory `a-clarifying-question-must-be-escapable`): it
 * can be answered, skipped, stopped or left to time out, every one of those resolves
 * the model's wait, and a turn may ask at most MAX_QUESTIONS_PER_TURN times.
 */

export type StepKind =
  | "think" | "files" | "web" | "sheet" | "phone" | "shell" | "system" | "git" | "mcp" | "ask" | "account";

export type StepState = "running" | "waiting" | "done" | "failed" | "denied" | "cancelled";

export type StepResource = { kind: "folder" | "file" | "web" | "sheet" | "repo" | "phone" | "system"; title: string };

export type ActivityEvent =
  | { seq: number; at: number; type: "thinking" }
  | {
      seq: number; at: number; type: "step";
      stepId: string; state: StepState; kind: StepKind; label: string;
      detail?: string[]; tookMs?: number; changed?: string; resource?: StepResource;
    }
  | { seq: number; at: number; type: "question"; questionId: string; question: string; options: string[]; allowText: boolean }
  | { seq: number; at: number; type: "answered"; questionId: string; answer: string | null; skipped: boolean }
  | { seq: number; at: number; type: "plan"; steps: string[]; current: number }
  | { seq: number; at: number; type: "conversation"; conversationId: string }
  | { seq: number; at: number; type: "done"; ok: boolean; stopped: boolean };

type Owner = { tenantId: string; clientUserId: string };
type NewEvent = ActivityEvent extends infer E ? (E extends { seq: number; at: number } ? Omit<E, "seq" | "at"> : never) : never;

type PendingQuestion = { questionId: string; resolve: (r: QuestionOutcome) => void; timer: ReturnType<typeof setTimeout> };
export type QuestionOutcome =
  | { answered: true; answer: string }
  | { answered: false; reason: "skipped" | "timeout" | "stopped" | "limit" };

type Turn = {
  turnId: string;
  owner: Owner;
  events: ActivityEvent[];
  seq: number;
  openedAt: number;
  finishedAt: number | null;
  stopped: boolean;
  conversationId: string | null;
  questionsAsked: number;
  pending: Map<string, PendingQuestion>;
  onStop: (() => void)[];
  /** Steps still running, so an "approval prompt is up" signal can find its step. */
  running: Map<string, { tool: string; kind: StepKind; label: string; startedAt: number }>;
};

export const TURN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_QUESTIONS_PER_TURN = 3;
export const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;
/** Finished turns stay readable this long, so a slow second window still sees the end. */
export const FINISHED_TURN_TTL_MS = 10 * 60 * 1000;
/** A turn nobody finished (a crashed request) is dropped after this. */
export const STALE_TURN_TTL_MS = 30 * 60 * 1000;
export const MAX_EVENTS_PER_TURN = 1500;
export const MAX_TURNS = 5000;
export const MAX_QUESTION_CHARS = 300;
export const MAX_OPTION_CHARS = 60;
export const MAX_ANSWER_CHARS = 2000;

const sameOwner = (a: Owner, b: Owner) => a.tenantId === b.tenantId && a.clientUserId === b.clientUserId;
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export class ActivityHub {
  private turns = new Map<string, Turn>();
  private idSeq = 0;
  constructor(private now: () => number = () => Date.now()) {}

  /** Open (or re-attach to) a turn. A turnId already owned by someone else is refused. */
  open(turnId: string, owner: Owner): { ok: true } | { ok: false; error: "bad_turn_id" | "turn_owned_elsewhere" | "turn_busy" } {
    if (!TURN_ID_RE.test(turnId)) return { ok: false, error: "bad_turn_id" };
    this.sweep();
    const t = this.turns.get(turnId);
    if (t) {
      if (!sameOwner(t.owner, owner)) return { ok: false, error: "turn_owned_elsewhere" };
      // ⛔ A turnId is single-use: a second message reusing a live one would mix two turns' steps.
      if (t.finishedAt === null) return { ok: false, error: "turn_busy" };
      this.turns.delete(turnId);
    }
    if (this.turns.size >= MAX_TURNS) this.evictOldest();
    this.turns.set(turnId, {
      turnId, owner, events: [], seq: 0, openedAt: this.now(), finishedAt: null, stopped: false,
      conversationId: null, questionsAsked: 0, pending: new Map(), onStop: [], running: new Map(),
    });
    return { ok: true };
  }

  has(turnId: string): boolean { return this.turns.has(turnId); }

  private push(t: Turn, ev: NewEvent): ActivityEvent | null {
    if (t.events.length >= MAX_EVENTS_PER_TURN) {
      // Keep the story readable at the cap: drop the oldest "thinking" pings first.
      const i = t.events.findIndex((e) => e.type === "thinking");
      if (i >= 0) t.events.splice(i, 1); else return null;
    }
    const full = { ...ev, seq: ++t.seq, at: this.now() } as ActivityEvent;
    t.events.push(full);
    return full;
  }

  emit(turnId: string, ev: NewEvent): void {
    const t = this.turns.get(turnId);
    if (!t || t.finishedAt !== null) return;
    // Collapse back-to-back "thinking" pings — one model call per tool round would
    // otherwise flood the feed with identical events.
    if (ev.type === "thinking" && t.events[t.events.length - 1]?.type === "thinking") return;
    this.push(t, ev);
  }

  nextStepId(): string { return `s${(++this.idSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

  stepStarted(turnId: string, stepId: string, tool: string, kind: StepKind, label: string, resource?: StepResource): void {
    const t = this.turns.get(turnId);
    if (!t || t.finishedAt !== null) return;
    t.running.set(stepId, { tool, kind, label, startedAt: this.now() });
    this.push(t, { type: "step", stepId, state: "running", kind, label, ...(resource ? { resource } : {}) });
  }

  stepEnded(turnId: string, stepId: string, patch: { state: Exclude<StepState, "running" | "waiting">; label?: string; detail?: string[]; changed?: string; resource?: StepResource }): void {
    const t = this.turns.get(turnId);
    if (!t) return;
    const r = t.running.get(stepId);
    t.running.delete(stepId);
    if (t.finishedAt !== null) return;
    this.push(t, {
      type: "step", stepId, state: patch.state,
      kind: r?.kind ?? "think", label: patch.label ?? r?.label ?? "Step",
      ...(patch.detail?.length ? { detail: patch.detail.slice(0, 8).map((d) => clip(d, 240)) } : {}),
      ...(r ? { tookMs: this.now() - r.startedAt } : {}),
      ...(patch.changed ? { changed: clip(patch.changed, 120) } : {}),
      ...(patch.resource ? { resource: patch.resource } : {}),
    });
  }

  /**
   * The desktop says an approval prompt is on the person's screen for a call to
   * `tool`. Every turn this person has running with a step for that tool shows it as
   * waiting — the chat then says "check the Loopcom approval box" instead of spinning.
   */
  markWaiting(owner: Owner, tool: string): number {
    let n = 0;
    for (const t of this.turns.values()) {
      if (t.finishedAt !== null || !sameOwner(t.owner, owner)) continue;
      for (const [stepId, r] of t.running) {
        if (r.tool !== tool) continue;
        this.push(t, { type: "step", stepId, state: "waiting", kind: r.kind, label: r.label });
        n++;
      }
    }
    return n;
  }

  setConversation(turnId: string, conversationId: string): void {
    const t = this.turns.get(turnId);
    if (!t || t.conversationId === conversationId) return;
    t.conversationId = conversationId;
    this.push(t, { type: "conversation", conversationId });
  }

  /** The turn still running for this person's conversation, so a newly opened window can attach. */
  activeTurnFor(owner: Owner, conversationId: string): string | null {
    let best: Turn | null = null;
    for (const t of this.turns.values()) {
      if (t.finishedAt !== null || t.conversationId !== conversationId || !sameOwner(t.owner, owner)) continue;
      if (!best || t.openedAt > best.openedAt) best = t;
    }
    return best?.turnId ?? null;
  }

  read(turnId: string, owner: Owner, after: number): { ok: true; events: ActivityEvent[]; done: boolean; lastSeq: number } | { ok: false; error: "not_found" } {
    const t = this.turns.get(turnId);
    // ⛔ Someone else's turn reads exactly like a missing one — never "forbidden".
    if (!t || !sameOwner(t.owner, owner)) return { ok: false, error: "not_found" };
    const from = Number.isFinite(after) ? after : 0;
    return { ok: true, events: t.events.filter((e) => e.seq > from), done: t.finishedAt !== null, lastSeq: t.seq };
  }

  /** The model asks the person something and waits (bounded) for the answer. */
  ask(turnId: string, q: { question: string; options?: string[]; allowText?: boolean }): Promise<QuestionOutcome> {
    const t = this.turns.get(turnId);
    if (!t || t.finishedAt !== null || t.stopped) return Promise.resolve({ answered: false, reason: "stopped" });
    if (t.questionsAsked >= MAX_QUESTIONS_PER_TURN) return Promise.resolve({ answered: false, reason: "limit" });
    t.questionsAsked++;
    const question = clip(q.question, MAX_QUESTION_CHARS);
    const options = Array.from(new Set((q.options ?? []).map((o) => clip(o, MAX_OPTION_CHARS)).filter(Boolean))).slice(0, 4);
    const allowText = q.allowText !== false || options.length === 0;
    const questionId = `q${(++this.idSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return new Promise<QuestionOutcome>((resolve) => {
      const settle = (r: QuestionOutcome) => {
        const p = t.pending.get(questionId);
        if (!p) return;
        clearTimeout(p.timer);
        t.pending.delete(questionId);
        this.push(t, { type: "answered", questionId, answer: r.answered ? r.answer : null, skipped: !r.answered });
        resolve(r);
      };
      const timer = setTimeout(() => settle({ answered: false, reason: "timeout" }), QUESTION_TIMEOUT_MS);
      t.pending.set(questionId, { questionId, resolve: settle, timer });
      this.push(t, { type: "question", questionId, question, options, allowText });
    });
  }

  answer(turnId: string, owner: Owner, questionId: string, answer: string | null): { ok: true } | { ok: false; error: "not_found" | "already_answered" | "empty_answer" } {
    const t = this.turns.get(turnId);
    if (!t || !sameOwner(t.owner, owner)) return { ok: false, error: "not_found" };
    const p = t.pending.get(questionId);
    if (!p) return { ok: false, error: "already_answered" };
    if (answer === null) { p.resolve({ answered: false, reason: "skipped" }); return { ok: true }; }
    const text = String(answer).trim().slice(0, MAX_ANSWER_CHARS);
    if (!text) return { ok: false, error: "empty_answer" };
    p.resolve({ answered: true, answer: text });
    return { ok: true };
  }

  /** Register what stopping this turn must also stop (the desktop's running calls). */
  onStop(turnId: string, fn: () => void): void {
    const t = this.turns.get(turnId);
    if (!t) return;
    if (t.stopped) { try { fn(); } catch { /* best effort */ } return; }
    t.onStop.push(fn);
  }

  stop(turnId: string, owner: Owner): { ok: true; alreadyDone: boolean } | { ok: false; error: "not_found" } {
    const t = this.turns.get(turnId);
    if (!t || !sameOwner(t.owner, owner)) return { ok: false, error: "not_found" };
    if (t.finishedAt !== null) return { ok: true, alreadyDone: true };
    if (!t.stopped) {
      t.stopped = true;
      for (const p of [...t.pending.values()]) p.resolve({ answered: false, reason: "stopped" });
      for (const fn of t.onStop.splice(0)) { try { fn(); } catch { /* best effort */ } }
    }
    return { ok: true, alreadyDone: false };
  }

  isStopped(turnId: string): boolean { return !!this.turns.get(turnId)?.stopped; }

  counts(turnId: string): { questionsAsked: number } { return { questionsAsked: this.turns.get(turnId)?.questionsAsked ?? 0 }; }

  finish(turnId: string, ok: boolean): void {
    const t = this.turns.get(turnId);
    if (!t || t.finishedAt !== null) return;
    for (const p of [...t.pending.values()]) p.resolve({ answered: false, reason: "stopped" });
    // A step the turn never closed (a tool that threw past its wrapper) must not spin forever.
    for (const stepId of [...t.running.keys()]) this.stepEnded(turnId, stepId, { state: t.stopped ? "cancelled" : "failed" });
    this.push(t, { type: "done", ok, stopped: t.stopped });
    t.finishedAt = this.now();
    t.onStop = [];
  }

  sweep(): number {
    const now = this.now();
    let n = 0;
    for (const [id, t] of this.turns) {
      const expired = t.finishedAt !== null ? now - t.finishedAt > FINISHED_TURN_TTL_MS : now - t.openedAt > STALE_TURN_TTL_MS;
      if (!expired) continue;
      for (const p of t.pending.values()) clearTimeout(p.timer);
      this.turns.delete(id);
      n++;
    }
    return n;
  }

  private evictOldest(): void {
    let oldest: Turn | null = null;
    for (const t of this.turns.values()) if (t.finishedAt !== null && (!oldest || t.openedAt < oldest.openedAt)) oldest = t;
    if (!oldest) for (const t of this.turns.values()) if (!oldest || t.openedAt < oldest.openedAt) oldest = t;
    if (oldest) { for (const p of oldest.pending.values()) clearTimeout(p.timer); this.turns.delete(oldest.turnId); }
  }

  size(): number { return this.turns.size; }
}
