"use client";
/**
 * The conversation with live steps — what the approved mockup calls the "IDE"
 * part: every tool the Coworker uses shows as a plain-English step while it runs,
 * a question it asks shows as a card you answer, and an approval it is waiting on
 * says where to answer it. No code, ever.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check, ChevronRight, CircleHelp, Cpu, FileSpreadsheet, FileText, Folder, GitBranch, Globe, Hand, Phone, Sparkles, Terminal, UserRound, Workflow, X,
} from "lucide-react";
import type { CoworkerSession, ChatItem } from "./useCoworkerSession";
import { formatDuration, parseReply, stepsDone, type StepKind, type StepState, type StepView, type TurnView } from "./coworkerModel";

export const CHAT_PHRASES = [
  "What should I work on?",
  "I can work with the files on this computer, a web browser, spreadsheets, code projects and your Loopcom phone system. I'll show you each step, and I'll ask before I change anything.",
  "I can read files you attach, look things up in your Loopcom account, and answer questions. Open the Loopcom app on your computer to let me work with your files and programs.",
  "Organize my Downloads folder", "Put August's unpaid invoices from my email into a spreadsheet", "Why did my phone miss calls this morning?",
  "What changed in my project since yesterday?", "Summarize the file I attach",
  "Files", "Browser", "Spreadsheet", "Phone system", "Command", "This computer", "Code project", "Connected app", "Question", "Account", "Thinking",
  "Working", "Done", "Stopped", "Didn't finish", "of", "steps", "Working…", "Waiting for you", "Waiting for your OK", "Skipped", "Not allowed", "Didn't work",
  "Coworker needs your OK", "Look for the Loopcom approval box on your screen to allow or refuse this.",
  "Coworker has a question", "Type your answer", "Answer", "Skip", "You answered", "You skipped this question",
  "Show steps", "Hide steps", "Thinking…", "Loading this task…", "You said no, so this didn't run.",
] as string[];

const KIND: Record<StepKind, { icon: ReactNode; name: string }> = {
  files: { icon: <Folder size={11} />, name: "Files" },
  web: { icon: <Globe size={11} />, name: "Browser" },
  sheet: { icon: <FileSpreadsheet size={11} />, name: "Spreadsheet" },
  phone: { icon: <Phone size={11} />, name: "Phone system" },
  shell: { icon: <Terminal size={11} />, name: "Command" },
  system: { icon: <Cpu size={11} />, name: "This computer" },
  git: { icon: <GitBranch size={11} />, name: "Code project" },
  mcp: { icon: <Workflow size={11} />, name: "Connected app" },
  ask: { icon: <CircleHelp size={11} />, name: "Question" },
  account: { icon: <UserRound size={11} />, name: "Account" },
  think: { icon: <Sparkles size={11} />, name: "Thinking" },
};

export function CoworkerMark({ size = 28 }: { size?: number }) {
  return (
    <span className="cw-logo" style={{ width: size, height: size }} aria-hidden="true">
      <img src="/brand/loopcom/loopcom-icon-64.png" alt="" draggable={false} />
    </span>
  );
}

function StateLead({ state }: { state: StepState }) {
  switch (state) {
    case "running": return <span className="cw-spin" />;
    case "waiting": return <span className="cw-wait" style={{ display: "inline-flex" }}><Hand size={14} /></span>;
    case "done": return <span className="cw-ok" style={{ display: "inline-flex" }}><Check size={14} strokeWidth={2.6} /></span>;
    case "cancelled": return <span className="cw-mute" style={{ display: "inline-flex" }}><X size={14} /></span>;
    default: return <span className="cw-bad" style={{ display: "inline-flex" }}><X size={14} strokeWidth={2.4} /></span>;
  }
}

function stateText(step: StepView, t: (s: string) => string): string {
  switch (step.state) {
    case "running": return t("Working…");
    case "waiting": return t("Waiting for your OK");
    case "done": return step.tookMs != null ? formatDuration(step.tookMs) : t("Done");
    case "cancelled": return t("Stopped");
    case "denied": return t("Not allowed");
    default: return t("Didn't work");
  }
}

function StepRow({ step, t }: { step: StepView; t: (s: string) => string }) {
  const [open, setOpen] = useState(false);
  const kind = KIND[step.kind] ?? KIND.think;
  const hasDetail = step.detail.length > 0;
  return (
    <div className={`cw-step ${step.state}${open ? " open" : ""}`}>
      <button type="button" className="cw-step-row" onClick={() => hasDetail && setOpen((o) => !o)} aria-expanded={hasDetail ? open : undefined}>
        <StateLead state={step.state} />
        <span className="cw-tool">{kind.icon}{t(kind.name)}</span>
        <span className="cw-step-label" title={step.label}>{step.label}</span>
        <span className="cw-step-state">{stateText(step, t)}</span>
        {hasDetail && <span className="cw-chev"><ChevronRight size={12} /></span>}
      </button>
      {hasDetail && (
        <div className="cw-step-detail">
          <ul>{step.detail.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function QuestionCard({ s, turn, t }: { s: CoworkerSession; turn: TurnView; t: (s: string) => string }) {
  const q = turn.question!;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (q.allowText) input.current?.focus(); }, [q.questionId, q.allowText]);
  const reply = async (v: string | null) => {
    if (busy) return;
    setBusy(true);
    await s.answer(turn.turnId, q.questionId, v);
    setBusy(false);
  };
  return (
    <div className="cw-approve" role="group" aria-label={t("Coworker has a question")}>
      <div className="cw-approve-h"><CircleHelp size={15} />{t("Coworker has a question")}</div>
      <p>{q.question}</p>
      {q.options.length > 0 && (
        <div className="cw-row">
          {q.options.map((o) => <button key={o} type="button" className="cw-btn" disabled={busy} onClick={() => void reply(o)}>{o}</button>)}
        </div>
      )}
      {q.allowText && (
        <form className="cw-question-input" onSubmit={(e) => { e.preventDefault(); if (value.trim()) void reply(value.trim()); }}>
          <input ref={input} value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("Type your answer")} maxLength={2000} disabled={busy} aria-label={t("Type your answer")} />
          <button type="submit" className="cw-btn primary" disabled={busy || !value.trim()}>{t("Answer")}</button>
        </form>
      )}
      <div className="cw-row"><button type="button" className="cw-btn" disabled={busy} onClick={() => void reply(null)}>{t("Skip")}</button></div>
    </div>
  );
}

function ReplyText({ text }: { text: string }) {
  const blocks = parseReply(text);
  return (
    <div className="cw-text">
      {blocks.map((b, i) =>
        b.type === "p" ? (
          <p key={i}>{b.inline.map((x, j) => (x.bold ? <b key={j}>{x.text}</b> : <span key={j}>{x.text}</span>))}</p>
        ) : b.type === "ul" ? (
          <ul key={i}>{b.items.map((it, j) => <li key={j}>{it.map((x, k) => (x.bold ? <b key={k}>{x.text}</b> : <span key={k}>{x.text}</span>))}</li>)}</ul>
        ) : (
          <ol key={i}>{b.items.map((it, j) => <li key={j}>{it.map((x, k) => (x.bold ? <b key={k}>{x.text}</b> : <span key={k}>{x.text}</span>))}</li>)}</ol>
        ),
      )}
    </div>
  );
}

function TurnBlock({ s, turn, reply, showSteps, t, now }: { s: CoworkerSession; turn: TurnView | null; reply: Extract<ChatItem, { kind: "ai" }>; showSteps: boolean; t: (s: string) => string; now: number }) {
  const [expanded, setExpanded] = useState(showSteps);
  useEffect(() => setExpanded(showSteps), [showSteps]);
  const running = !!turn && !turn.done && reply.text === null;
  const steps = turn?.steps ?? [];
  const waiting = steps.some((x) => x.state === "waiting");
  const elapsed = turn ? formatDuration((turn.endedAt ?? now) - turn.startedAt) : "";
  const headLabel = running ? t("Working") : turn?.stopped ? t("Stopped") : turn && turn.ok === false ? t("Didn't finish") : t("Done");
  const showThinking = running && !turn?.question && !waiting && !steps.some((x) => x.state === "running");
  return (
    <div className="cw-msg-ai">
      <CoworkerMark size={24} />
      <div className="cw-msg-body">
        {turn && (steps.length > 0 || running) && (
          <div className="cw-steps">
            <div className="cw-steps-h">
              {running ? <span className="cw-spin" style={{ width: 11, height: 11 }} /> : <span className="cw-ok" style={{ display: "inline-flex" }}><Check size={13} /></span>}
              <b>{headLabel}</b>
              {steps.length > 0 && <span>· {stepsDone(turn)} {t("of")} {steps.length} {t("steps")}</span>}
              <span className="cw-timer">{elapsed}</span>
              {steps.length > 0 && (
                <button type="button" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>{expanded ? t("Hide steps") : t("Show steps")}</button>
              )}
            </div>
            {expanded && steps.map((step) => <StepRow key={step.stepId} step={step} t={t} />)}
            {showThinking && (
              <div className="cw-thinking"><span className="cw-typing"><i /><i /><i /></span>{t("Thinking…")}</div>
            )}
          </div>
        )}
        {turn && waiting && !turn.done && (
          <div className="cw-approve" role="status">
            <div className="cw-approve-h"><Hand size={15} />{t("Coworker needs your OK")}</div>
            <p>{steps.find((x) => x.state === "waiting")?.label}</p>
            <small>{t("Look for the Loopcom approval box on your screen to allow or refuse this.")}</small>
          </div>
        )}
        {turn?.question && !turn.done && <QuestionCard s={s} turn={turn} t={t} />}
        {reply.text === null && !turn && <div className="cw-typing"><i /><i /><i /></div>}
        {reply.text !== null && (reply.failed ? <div className="cw-error">{reply.text}</div> : <ReplyText text={reply.text} />)}
      </div>
    </div>
  );
}

export function CoworkerChatView({ s, t, desktop, onSuggest }: { s: CoworkerSession; t: (s: string) => string; desktop: boolean; onSuggest?: (text: string) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!s.activeTurnId) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [s.activeTurnId]);

  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [s.items, s.turns, s.error, s.notice]);

  const onScroll = () => {
    const el = list.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const suggestions = desktop
    ? [
        { icon: <Folder size={15} />, text: "Organize my Downloads folder" },
        { icon: <FileSpreadsheet size={15} />, text: "Put August's unpaid invoices from my email into a spreadsheet" },
        { icon: <Phone size={15} />, text: "Why did my phone miss calls this morning?" },
      ]
    : [
        { icon: <Phone size={15} />, text: "Why did my phone miss calls this morning?" },
        { icon: <FileText size={15} />, text: "Summarize the file I attach" },
        { icon: <GitBranch size={15} />, text: "What changed in my project since yesterday?" },
      ];

  return (
    <div className="cw-chat" ref={list} onScroll={onScroll} aria-live="polite">
      {s.loadingTask && s.items.length === 0 ? (
        <div className="cw-empty"><span className="cw-spin" /><p>{t("Loading this task…")}</p></div>
      ) : s.items.length === 0 ? (
        <div className="cw-empty">
          <CoworkerMark size={40} />
          <h3>{t("What should I work on?")}</h3>
          <p>{desktop
            ? t("I can work with the files on this computer, a web browser, spreadsheets, code projects and your Loopcom phone system. I'll show you each step, and I'll ask before I change anything.")
            : t("I can read files you attach, look things up in your Loopcom account, and answer questions. Open the Loopcom app on your computer to let me work with your files and programs.")}</p>
          <div className="cw-suggest">
            {suggestions.map((x) => (
              <button key={x.text} type="button" onClick={() => onSuggest ? onSuggest(t(x.text)) : void s.send(t(x.text))}>{x.icon}{t(x.text)}</button>
            ))}
          </div>
        </div>
      ) : (
        s.items.map((it) =>
          it.kind === "user" ? (
            <div key={it.id} className="cw-msg-user">
              {it.text}
              {(it.attached.length > 0 || it.folders.length > 0) && (
                <div className="cw-attached">
                  {it.folders.map((f) => <span key={f.path}>{f.repo ? <GitBranch size={10} /> : <Folder size={10} />}{f.name}</span>)}
                  {it.attached.map((a) => <span key={a}><FileText size={10} />{a}</span>)}
                </div>
              )}
            </div>
          ) : (
            <TurnBlock key={it.id} s={s} turn={it.turnId ? s.turns[it.turnId] ?? null : null} reply={it} showSteps={s.prefs.showSteps !== false} t={t} now={now} />
          ),
        )
      )}
      {s.notice && <div className="cw-notice" role="status">{s.notice}</div>}
      {s.error && <div className="cw-error" role="alert">{s.error}</div>}
    </div>
  );
}
