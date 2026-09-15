/**
 * The Coworker workspace's view of one task turn, built from the agent's live
 * activity events (apps/agent/src/coworker/activity.ts).
 *
 * ⛔ PURE. Events arrive by polling, possibly late, duplicated, or from a second
 * window watching the same task, so `applyEvents` is idempotent by sequence number
 * and order-independent within one batch. Everything the screen shows — steps, the
 * plan, the open question, "what changed", "asked you N times", the thing it has
 * open right now — is derived here, so it can be tested without a browser.
 */

export type StepKind = "think" | "files" | "web" | "sheet" | "phone" | "shell" | "system" | "git" | "mcp" | "ask" | "account";
export type StepState = "running" | "waiting" | "done" | "failed" | "denied" | "cancelled";
export type StepResource = { kind: "folder" | "file" | "web" | "sheet" | "repo" | "phone" | "system"; title: string };

export type ActivityEvent =
  | { seq: number; at: number; type: "thinking" }
  | { seq: number; at: number; type: "step"; stepId: string; state: StepState; kind: StepKind; label: string; detail?: string[]; tookMs?: number; changed?: string; resource?: StepResource }
  | { seq: number; at: number; type: "question"; questionId: string; question: string; options: string[]; allowText: boolean }
  | { seq: number; at: number; type: "answered"; questionId: string; answer: string | null; skipped: boolean }
  | { seq: number; at: number; type: "plan"; steps: string[]; current: number }
  | { seq: number; at: number; type: "conversation"; conversationId: string }
  | { seq: number; at: number; type: "done"; ok: boolean; stopped: boolean };

export type StepView = {
  stepId: string;
  kind: StepKind;
  label: string;
  state: StepState;
  detail: string[];
  tookMs: number | null;
  changed: string | null;
  resource: StepResource | null;
  firstSeq: number;
  startedAt: number;
};

export type QuestionView = { questionId: string; question: string; options: string[]; allowText: boolean; askedAt: number };

export type TurnView = {
  turnId: string;
  lastSeq: number;
  steps: StepView[];
  plan: { steps: string[]; current: number } | null;
  question: QuestionView | null;
  answers: { questionId: string; question: string; answer: string | null; skipped: boolean }[];
  questionsAsked: number;
  thinkingSince: number | null;
  conversationId: string | null;
  startedAt: number;
  endedAt: number | null;
  done: boolean;
  ok: boolean | null;
  stopped: boolean;
};

export function newTurn(turnId: string, now: number = Date.now()): TurnView {
  return {
    turnId, lastSeq: 0, steps: [], plan: null, question: null, answers: [], questionsAsked: 0,
    thinkingSince: now, conversationId: null, startedAt: now, endedAt: null, done: false, ok: null, stopped: false,
  };
}

const FINAL: ReadonlySet<StepState> = new Set(["done", "failed", "denied", "cancelled"]);

export function applyEvents(view: TurnView, events: readonly ActivityEvent[]): TurnView {
  const fresh = [...events].filter((e) => e && typeof e.seq === "number" && e.seq > view.lastSeq).sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) return view;
  const next: TurnView = { ...view, steps: [...view.steps], answers: [...view.answers] };
  const questions = new Map<string, QuestionView>();
  if (next.question) questions.set(next.question.questionId, next.question);
  for (const e of fresh) {
    next.lastSeq = e.seq;
    switch (e.type) {
      case "thinking":
        next.thinkingSince = next.thinkingSince ?? e.at;
        break;
      case "step": {
        next.thinkingSince = null;
        const i = next.steps.findIndex((s) => s.stepId === e.stepId);
        if (i < 0) {
          next.steps.push({
            stepId: e.stepId, kind: e.kind, label: e.label, state: e.state, detail: e.detail ?? [],
            tookMs: e.tookMs ?? null, changed: e.changed ?? null, resource: e.resource ?? null, firstSeq: e.seq, startedAt: e.at,
          });
        } else {
          const prev = next.steps[i];
          // ⛔ A finished step never goes back to running/waiting (a late duplicate can't un-finish it).
          if (FINAL.has(prev.state) && !FINAL.has(e.state)) break;
          next.steps[i] = {
            ...prev,
            state: e.state,
            label: e.label || prev.label,
            detail: e.detail?.length ? e.detail : prev.detail,
            tookMs: e.tookMs ?? prev.tookMs,
            changed: e.changed ?? prev.changed,
            resource: e.resource ?? prev.resource,
          };
        }
        break;
      }
      case "question": {
        const q: QuestionView = { questionId: e.questionId, question: e.question, options: e.options ?? [], allowText: e.allowText !== false, askedAt: e.at };
        questions.set(e.questionId, q);
        next.question = q;
        next.questionsAsked += 1;
        next.thinkingSince = null;
        break;
      }
      case "answered": {
        const q = questions.get(e.questionId);
        next.answers.push({ questionId: e.questionId, question: q?.question ?? "", answer: e.answer, skipped: e.skipped });
        if (next.question?.questionId === e.questionId) next.question = null;
        next.thinkingSince = e.at;
        break;
      }
      case "plan":
        next.plan = { steps: e.steps, current: e.current };
        break;
      case "conversation":
        next.conversationId = e.conversationId;
        break;
      case "done":
        next.done = true;
        next.ok = e.ok;
        next.stopped = e.stopped;
        next.endedAt = e.at;
        next.question = null;
        next.thinkingSince = null;
        next.steps = next.steps.map((s) => (FINAL.has(s.state) ? s : { ...s, state: e.stopped ? "cancelled" : "failed" }));
        break;
    }
  }
  return next;
}

/** "Working" / "Waiting for you" / "Checking the approval box" / "Done" — the status line. */
export function turnStatus(view: TurnView | null): "idle" | "working" | "question" | "approval" | "done" | "stopped" {
  if (!view) return "idle";
  if (view.done) return view.stopped ? "stopped" : "done";
  if (view.question) return "question";
  if (view.steps.some((s) => s.state === "waiting")) return "approval";
  return "working";
}

export function stepsDone(view: TurnView | null): number {
  return view ? view.steps.filter((s) => FINAL.has(s.state)).length : 0;
}

/** What the task made or changed, newest last, de-duplicated. */
export function changedItems(view: TurnView | null): string[] {
  if (!view) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of view.steps) {
    if (s.state !== "done" || !s.changed || seen.has(s.changed)) continue;
    seen.add(s.changed);
    out.push(s.changed);
  }
  return out;
}

/** The last thing the Coworker had open — the "Right now" panel. */
export function currentResource(view: TurnView | null): { resource: StepResource; label: string; state: StepState } | null {
  if (!view) return null;
  for (let i = view.steps.length - 1; i >= 0; i--) {
    const s = view.steps[i];
    if (s.resource && s.resource.title) return { resource: s.resource, label: s.label, state: s.state };
  }
  return null;
}

export function elapsedMs(view: TurnView | null, now: number = Date.now()): number {
  if (!view) return 0;
  return Math.max(0, (view.endedAt ?? now) - view.startedAt);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

/** A random, URL-safe turn id the agent accepts (^[A-Za-z0-9_-]{8,64}$). */
export function newTurnId(rand: () => number = Math.random): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "cw_";
  const cryptoObj = typeof globalThis !== "undefined" ? (globalThis as { crypto?: Crypto }).crypto : undefined;
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(20);
    cryptoObj.getRandomValues(bytes);
    for (const b of bytes) out += alphabet[b % alphabet.length];
    return out;
  }
  for (let i = 0; i < 20; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}

/** Group task history the way people think about it. */
export function taskGroup(startedAt: string | number | Date, now: Date = new Date()): "Today" | "Yesterday" | "Last 7 days" | "Earlier" {
  const d = new Date(startedAt);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return "Today";
  if (t >= startOfToday - 86400_000) return "Yesterday";
  if (t >= startOfToday - 6 * 86400_000) return "Last 7 days";
  return "Earlier";
}

/**
 * The assistant writes plain text with light markdown (paragraphs, "- " lists,
 * "1." lists, **bold**). Parsed into blocks the screen renders as React nodes — never
 * as HTML, so nothing in a reply can inject markup.
 */
export type Inline = { text: string; bold: boolean };
export type Block = { type: "p"; inline: Inline[] } | { type: "ul" | "ol"; items: Inline[][] };

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), bold: false });
  return out.map((x) => ({ ...x, text: x.text.replace(/`([^`]+)`/g, "$1") }));
}

export function parseReply(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push({ type: "p", inline: parseInline(para.join(" ").trim()) }); para = []; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const type = bullet ? "ul" : "ol";
      const item = parseInline((bullet ?? numbered)![1]);
      const last = blocks[blocks.length - 1];
      if (last && last.type === type) last.items.push(item); else blocks.push({ type, items: [item] });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (/^#{1,6}\s+/.test(line)) { flush(); blocks.push({ type: "p", inline: [{ text: line.replace(/^#{1,6}\s+/, ""), bold: true }] }); continue; }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/** A stored user message: split off the "[Attached: …]" note the agent appends. */
export function splitAttachmentNote(content: string): { text: string; attached: string[] } {
  const lines = String(content ?? "").split("\n");
  const attached: string[] = [];
  const kept = lines.filter((l) => {
    const m = /^\[Attached: (.*)\]$/.exec(l.trim());
    if (!m) return true;
    // The agent writes "name (1.2 MB), other name (3 KB)" — a separator is the ", " right after a size.
    for (const part of m[1].split(/(?<=\([\d.]+ (?:KB|MB)\)),\s+/)) attached.push(part.replace(/\s*\([\d.]+ (?:KB|MB)\)\s*$/, "").trim());
    return false;
  });
  return { text: kept.join("\n").trim(), attached: attached.filter(Boolean) };
}
