"use client";
/**
 * The Coworker's FULL PAGE (sidebar → Workspace → Coworker): tasks on the left,
 * the live conversation in the middle, what it is doing on the right, plus
 * "Everything it did" and Settings — the approved mockup, wired to the real agent,
 * the real desktop app and the person's saved Coworker settings.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check, Cpu, FileSpreadsheet, Folder, FolderPlus, GitBranch, Globe, Hand, History, Laptop, ListChecks, Mail, MessageSquare, Minimize2, Phone,
  Plus, RefreshCw, Search, Settings, Square, Trash2, X,
} from "lucide-react";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { useCoworkerSession, type CoworkerSession } from "./useCoworkerSession";
import { CoworkerChatView, CoworkerMark, CHAT_PHRASES } from "./CoworkerChatView";
import { CoworkerComposer, COMPOSER_PHRASES } from "./CoworkerComposer";
import { changedItems, currentResource, elapsedMs, formatDuration, stepsDone, taskGroup, type StepResource } from "./coworkerModel";
import { cancelOnComputer, coworkerUi, isDesktopApp, type AccessProfile } from "./coworkerBridge";
import { COWORKER_STYLES } from "./coworkerStyles";

const PAGE_PHRASES = [
  "Coworker", "Loopcom", "New task", "Search your tasks", "Tasks", "Everything it did", "Settings", "No tasks yet.", "No matches.",
  "Today", "Yesterday", "Last 7 days", "Earlier", "History is off in Coworker settings.", "Your company has task history turned off.",
  "On this computer: connected", "On this computer: not connected", "In a web browser", "Back to the bubble",
  "What it's doing", "Waiting for a task", "Right now", "Nothing open", "When Coworker opens a folder, a web page or a spreadsheet, you'll see it here.",
  "This task", "Steps done", "Time", "Things changed", "None", "Asked you", "time", "times", "Made or changed", "Nothing yet.", "Stop everything",
  "Each step Coworker took, newest first — what it did, when, and how it went.", "Refresh", "Done", "Not allowed", "Didn't work", "Stopped", "Waiting", "Nothing here yet.",
  "Decide how much Coworker does on its own, what it can use, and what it should always remember about your business.",
  "How much it can do on its own", "This applies to this computer only.", "Ask me before every change",
  "Looking and reading is fine. Saving, moving, running or sending anything waits for your OK.", "Only ask for big things",
  "Everyday changes happen on its own. Commands, deleting, sending and signing in still ask.", "Just do it",
  "Fewest questions. The things listed below always ask, whatever you pick here.", "Always asks, no matter what:",
  "Deleting files", "Sending forms or payments on websites", "Sending code to a server", "Passwords & sign-ins", "Installing software or changing system settings", "Anything while you're on a call",
  "Open the Loopcom app on your computer to change what it may do there.", "What it can use", "Files on this computer", "Desktop, Documents, Downloads and folders you attach",
  "Web browser", "A separate Loopcom browser window. It never sees your normal Chrome.", "Spreadsheets", "Read and make Excel files", "Code projects",
  "See changes, history and branches; save checkpoints. Sending code to a server always asks.", "Git isn't installed on this computer yet.",
  "Your Loopcom phone system", "Calls, voicemail, extensions and your account", "Email", "Reads your email in its browser window. Never sends by itself.",
  "Folders it can use", "Folders and code projects you attached. Remove one to stop the Coworker using it.", "No folders attached yet.", "Attach a folder", "Use a code project", "Remove",
  "Things it should always know", "Write it the way you'd tell a new employee.", "Save", "Saved", "Saving…",
  "How it talks to you", "Short and to the point", "Tells you what it did in a couple of lines.", "Walk me through it", "Explains each step and why it did it.",
  "Show every step while it works", "The live list of what it's looking at and doing", "Let me know when a task finishes", "A red dot on the bubble and a Windows notification",
  "Send my voice right away", "When you finish speaking, it sends instead of waiting for you to press Send", "Bubble & history", "Show the bubble on my screen",
  "Drag it anywhere, on any monitor", "Keep past tasks for 30 days", "Show your recent tasks in the list", "Couldn't change that setting. Try again.",
  "We close on Fridays at 2. Invoices go in Documents › Invoices, one folder per month.",
];

const RESOURCE_ICON: Record<StepResource["kind"], ReactNode> = {
  folder: <Folder size={14} />, file: <Folder size={14} />, web: <Globe size={14} />, sheet: <FileSpreadsheet size={14} />, repo: <GitBranch size={14} />, phone: <Phone size={14} />, system: <Cpu size={14} />,
};

type View = "chat" | "activity" | "settings";

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <label className="cw-switch">
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <i />
    </label>
  );
}

export function CoworkerWorkspace() {
  const phrases = useMemo(() => [...PAGE_PHRASES, ...CHAT_PHRASES, ...COMPOSER_PHRASES], []);
  const { t } = useUiLanguage(phrases);
  const s = useCoworkerSession({ path: "/coworker" });
  const [view, setView] = useState<View>("chat");
  const [query, setQuery] = useState("");
  const desktop = !!coworkerUi();

  useEffect(() => {
    const id = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("task") : null;
    if (id) void s.openTask(id);
    void s.loadTaskList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (view === "activity") void s.loadActivityLog();
    if (view === "settings") void s.refreshDesktop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Keep the address bar pointing at the task, so a refresh reopens it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (s.taskId) url.searchParams.set("task", s.taskId); else url.searchParams.delete("task");
    window.history.replaceState(null, "", url.toString());
  }, [s.taskId]);

  const title = useMemo(() => {
    if (!s.taskId) return t("New task");
    const row = s.tasks?.find((x) => x.id === s.taskId);
    if (row) return row.title;
    const first = s.items.find((i) => i.kind === "user");
    return first && first.kind === "user" ? first.text.slice(0, 80) : t("Coworker");
  }, [s.taskId, s.tasks, s.items, t]);

  return (
    <div className="cw-root">
      <style>{COWORKER_STYLES}</style>
      <div className={`cw-app${view === "chat" ? "" : " settings"}`}>
        <Rail s={s} t={t} view={view} setView={setView} query={query} setQuery={setQuery} desktop={desktop} />
        {view === "chat" && (
          <>
            <main className="cw-center">
              <div className="cw-chead">
                <h2 title={title}>{title}</h2>
                <span className={`cw-status${s.status.tone === "busy" ? " busy" : s.status.tone === "off" ? " off" : ""}`}><i /><span>{t(s.status.text)}</span></span>
                {desktop && isDesktopApp() && (
                  <button type="button" className="cw-icon-btn" title={t("Back to the bubble")} aria-label={t("Back to the bubble")} onClick={() => void coworkerUi()?.openBubble()}>
                    <Minimize2 size={15} />
                  </button>
                )}
              </div>
              <CoworkerChatView s={s} t={t} desktop={desktop} />
              <CoworkerComposer s={s} t={t} />
            </main>
            <Inspector s={s} t={t} />
          </>
        )}
        {view === "activity" && <ActivityView s={s} t={t} />}
        {view === "settings" && <SettingsView s={s} t={t} desktop={desktop} />}
      </div>
    </div>
  );
}

function Rail({ s, t, view, setView, query, setQuery, desktop }: { s: CoworkerSession; t: (x: string) => string; view: View; setView: (v: View) => void; query: string; setQuery: (q: string) => void; desktop: boolean }) {
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = s.tasks ?? [];
    if (!s.prefs.keepHistory) rows = rows.filter((r) => r.id === s.taskId || r.running);
    rows = rows.filter((r) => !q || r.title.toLowerCase().includes(q));
    const out: { group: string; rows: typeof rows }[] = [];
    for (const r of rows) {
      const g = taskGroup(r.startedAt);
      const last = out[out.length - 1];
      if (last && last.group === g) last.rows.push(r); else out.push({ group: g, rows: [r] });
    }
    return out;
  }, [s.tasks, query, s.prefs.keepHistory, s.taskId]);

  return (
    <aside className="cw-rail">
      <div className="cw-rail-top">
        <div className="cw-brand"><CoworkerMark /><div>{t("Coworker")}<small>{t("Loopcom")}</small></div></div>
        <button type="button" className="cw-newtask" onClick={() => { setView("chat"); s.newTask(); }} disabled={!!s.activeTurnId}>
          <Plus size={15} />{t("New task")}
        </button>
        <label className="cw-search"><Search size={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Search your tasks")} aria-label={t("Search your tasks")} /></label>
      </div>
      <div className="cw-tasks">
        {!s.historyVisible && <div className="cw-group" style={{ textTransform: "none", letterSpacing: 0 }}>{t("Your company has task history turned off.")}</div>}
        {s.historyVisible && !s.prefs.keepHistory && <div className="cw-group" style={{ textTransform: "none", letterSpacing: 0 }}>{t("History is off in Coworker settings.")}</div>}
        {s.tasks === null ? <div className="cw-group"><span className="cw-spin" /></div> : groups.length === 0 ? (
          <div className="cw-group" style={{ textTransform: "none", letterSpacing: 0 }}>{query ? t("No matches.") : t("No tasks yet.")}</div>
        ) : groups.map((g) => (
          <div key={g.group}>
            <div className="cw-group">{t(g.group)}</div>
            {g.rows.map((r) => (
              <button key={r.id} type="button" className="cw-task" aria-current={r.id === s.taskId} onClick={() => { setView("chat"); if (r.id !== s.taskId) void s.openTask(r.id); }} title={r.title}>
                {r.running || (r.id === s.taskId && s.activeTurnId) ? <span className="cw-spin" /> : <span className="cw-ok" style={{ display: "inline-flex", opacity: 0.8 }}><Check size={14} /></span>}
                <span>{r.title}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="cw-rail-nav">
        <button type="button" aria-current={view === "chat"} onClick={() => setView("chat")}><MessageSquare size={15} />{t("Tasks")}</button>
        <button type="button" aria-current={view === "activity"} onClick={() => setView("activity")}><ListChecks size={15} />{t("Everything it did")}</button>
        <button type="button" aria-current={view === "settings"} onClick={() => setView("settings")}><Settings size={15} />{t("Settings")}</button>
        <div className="cw-status" style={{ padding: "8px 8px 2px" }}>
          <Laptop size={13} />
          {desktop || s.linked !== null
            ? (s.linked ? t("On this computer: connected") : desktop ? t("On this computer: not connected") : t("In a web browser"))
            : t("In a web browser")}
        </div>
      </div>
    </aside>
  );
}

function Inspector({ s, t }: { s: CoworkerSession; t: (x: string) => string }) {
  const turn = s.focusTurn;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!s.activeTurnId) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [s.activeTurnId]);
  const changed = changedItems(turn);
  const live = currentResource(turn);
  const running = !!s.activeTurnId;

  const planRows = (() => {
    if (turn?.plan) {
      return turn.plan.steps.map((label, i) => ({
        label,
        state: turn.done || i < turn.plan!.current ? "done" : i === turn.plan!.current ? (turn.question || turn.steps.some((x) => x.state === "waiting") ? "wait now" : "now") : "",
      }));
    }
    if (turn && turn.steps.length) {
      return turn.steps.slice(-6).map((x) => ({ label: x.label, state: x.state === "running" ? "now" : x.state === "waiting" ? "wait now" : "done" }));
    }
    return [{ label: t("Waiting for a task"), state: "done" }];
  })();

  return (
    <aside className="cw-inspector">
      <div className="cw-isec">
        <h4>{t("What it's doing")}</h4>
        <ul className="cw-plan">
          {planRows.map((r, i) => <li key={`${i}-${r.label}`} className={r.state}><span className="cw-pd" />{r.label}</li>)}
        </ul>
      </div>
      <div className="cw-isec">
        <h4>{t("Right now")}</h4>
        <div className="cw-live">
          <div className="cw-live-bar"><i /><i /><i /><span>{live ? live.resource.title : t("Nothing open")}</span></div>
          <div className="cw-live-body">
            {live ? (
              <>
                <div className="cw-live-title">{RESOURCE_ICON[live.resource.kind]}<span>{live.resource.title}</span></div>
                <div className="cw-live-recent">
                  {(turn?.steps ?? []).slice(-4).map((x) => (
                    <div key={x.stepId}>
                      {x.state === "running" ? <span className="cw-spin" style={{ width: 10, height: 10 }} /> : x.state === "waiting" ? <Hand size={11} className="cw-wait" /> : x.state === "done" ? <Check size={11} className="cw-ok" /> : <X size={11} className="cw-bad" />}
                      <span>{x.label}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : <span>{t("When Coworker opens a folder, a web page or a spreadsheet, you'll see it here.")}</span>}
          </div>
        </div>
      </div>
      <div className="cw-isec">
        <h4>{t("This task")}</h4>
        <dl className="cw-kv">
          <dt>{t("Steps done")}</dt><dd>{stepsDone(turn)}</dd>
          <dt>{t("Time")}</dt><dd>{turn ? formatDuration(elapsedMs(turn, now)) : "0s"}</dd>
          <dt>{t("Things changed")}</dt><dd>{changed.length ? changed.length : t("None")}</dd>
          <dt>{t("Asked you")}</dt><dd>{turn?.questionsAsked ?? 0} {(turn?.questionsAsked ?? 0) === 1 ? t("time") : t("times")}</dd>
        </dl>
      </div>
      <div className="cw-isec">
        <h4>{t("Made or changed")}</h4>
        <div className="cw-ilist">
          {changed.length ? changed.map((c) => <span key={c} className="cw-file-chip"><Check size={13} />{c}</span>) : <span style={{ fontSize: 12.5, color: "var(--cw-muted)" }}>{t("Nothing yet.")}</span>}
        </div>
      </div>
      <button type="button" className="cw-stopall" disabled={!running} onClick={() => { cancelOnComputer(); void s.stop(); }}>
        <Square size={13} fill="currentColor" />{t("Stop everything")}
      </button>
    </aside>
  );
}

function ActivityView({ s, t }: { s: CoworkerSession; t: (x: string) => string }) {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const pill = (state: string) => {
    if (state === "done") return <span className="cw-pill ok">{t("Done")}</span>;
    if (state === "denied") return <span className="cw-pill no">{t("Not allowed")}</span>;
    if (state === "cancelled") return <span className="cw-pill ask">{t("Stopped")}</span>;
    if (state === "waiting") return <span className="cw-pill ask">{t("Waiting")}</span>;
    return <span className="cw-pill no">{t("Didn't work")}</span>;
  };
  return (
    <div className="cw-settings">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}><h2>{t("Everything it did")}</h2><p className="cw-lede">{t("Each step Coworker took, newest first — what it did, when, and how it went.")}</p></div>
        <button type="button" className="cw-btn" onClick={() => void s.loadActivityLog()}><RefreshCw size={13} style={{ verticalAlign: -2, marginRight: 6 }} />{t("Refresh")}</button>
      </div>
      <div className="cw-card">
        {s.log === null ? <span className="cw-spin" /> : s.log.length === 0 ? <span style={{ color: "var(--cw-muted)", fontSize: 13 }}>{t("Nothing here yet.")}</span> : (
          <div className="cw-log">
            {s.log.map((e, i) => (
              <div key={`${e.at}-${i}`}>
                <time dateTime={e.at}>{fmt(e.at)}</time>
                <span>{e.label}{e.changed ? <span style={{ color: "var(--cw-muted)" }}> — {e.changed}</span> : null}</span>
                {pill(e.state)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsView({ s, t, desktop }: { s: CoworkerSession; t: (x: string) => string; desktop: boolean }) {
  const [memory, setMemory] = useState(s.prefs.memory);
  const [memoryState, setMemoryState] = useState<"idle" | "saving" | "saved">("idle");
  useEffect(() => { setMemory(s.prefs.memory); }, [s.prefs.memory]);
  const d = s.desktop;
  const profile: AccessProfile = d?.profile ?? "SAFE";

  const guard = async (p: Promise<unknown>) => {
    const ok = await p.then((r) => (typeof r === "boolean" ? r : (r as { ok?: boolean; error?: string })?.ok !== false || (r as { error?: string })?.error === "cancelled")).catch(() => false);
    if (!ok) s.setError(t("Couldn't change that setting. Try again."));
  };

  const accessChoices: { p: AccessProfile; title: string; body: string }[] = [
    { p: "SAFE", title: "Ask me before every change", body: "Looking and reading is fine. Saving, moving, running or sending anything waits for your OK." },
    { p: "TRUSTED", title: "Only ask for big things", body: "Everyday changes happen on its own. Commands, deleting, sending and signing in still ask." },
    { p: "AUTONOMOUS", title: "Just do it", body: "Fewest questions. The things listed below always ask, whatever you pick here." },
  ];

  return (
    <div className="cw-settings">
      <div><h2>{t("Settings")}</h2><p className="cw-lede">{t("Decide how much Coworker does on its own, what it can use, and what it should always remember about your business.")}</p></div>
      {s.error && <div className="cw-error" role="alert">{s.error}</div>}

      <div className="cw-card">
        <h3>{t("How much it can do on its own")}</h3>
        <p>{t("This applies to this computer only.")}</p>
        {accessChoices.map((c) => (
          <label key={c.p} className={`cw-choice${profile === c.p && desktop ? " on" : ""}${desktop ? "" : " disabled"}`}>
            <input type="radio" name="cw-access" checked={desktop && profile === c.p} disabled={!desktop} onChange={() => void guard(s.setAccess(c.p))} />
            <div><b>{t(c.title)}</b><span>{t(c.body)}</span></div>
          </label>
        ))}
        {!desktop && <div className="cw-notice">{t("Open the Loopcom app on your computer to change what it may do there.")}</div>}
        <div>
          <div style={{ fontSize: 12, color: "var(--cw-muted)", marginBottom: 6 }}>{t("Always asks, no matter what:")}</div>
          <div className="cw-never">
            {["Deleting files", "Sending forms or payments on websites", "Sending code to a server", "Passwords & sign-ins", "Installing software or changing system settings", "Anything while you're on a call"].map((x) => <span key={x}>{t(x)}</span>)}
          </div>
        </div>
      </div>

      <div className="cw-card">
        <h3>{t("What it can use")}</h3>
        <div>
          <Row icon={<Folder size={15} />} title={t("Files on this computer")} body={t("Desktop, Documents, Downloads and folders you attach")}>
            <Switch label={t("Files on this computer")} checked={desktop ? !!d?.groups.files : false} disabled={!desktop} onChange={(v) => void guard(s.setGroups({ files: v }))} />
          </Row>
          <Row icon={<Globe size={15} />} title={t("Web browser")} body={t("A separate Loopcom browser window. It never sees your normal Chrome.")}>
            <Switch label={t("Web browser")} checked={desktop ? !!d?.groups.browser : false} disabled={!desktop} onChange={(v) => void guard(s.setGroups({ browser: v }))} />
          </Row>
          <Row icon={<FileSpreadsheet size={15} />} title={t("Spreadsheets")} body={t("Read and make Excel files")}>
            <Switch label={t("Spreadsheets")} checked={desktop ? !!d?.groups.sheets : false} disabled={!desktop} onChange={(v) => void guard(s.setGroups({ sheets: v }))} />
          </Row>
          <Row icon={<GitBranch size={15} />} title={t("Code projects")} body={d && !d.gitInstalled ? t("Git isn't installed on this computer yet.") : t("See changes, history and branches; save checkpoints. Sending code to a server always asks.")}>
            <Switch label={t("Code projects")} checked={desktop ? !!d?.groups.git : false} disabled={!desktop} onChange={(v) => void guard(s.setGroups({ git: v }))} />
          </Row>
          <Row icon={<Phone size={15} />} title={t("Your Loopcom phone system")} body={t("Calls, voicemail, extensions and your account")}>
            <Switch label={t("Your Loopcom phone system")} checked={s.prefs.phone} onChange={(v) => void guard(s.updatePrefs({ phone: v }))} />
          </Row>
          <Row icon={<Mail size={15} />} title={t("Email")} body={t("Reads your email in its browser window. Never sends by itself.")}>
            <Switch
              label={t("Email")}
              checked={s.prefs.email && (!desktop || !!d?.groups.email)}
              onChange={(v) => void guard(Promise.all([s.updatePrefs({ email: v }), desktop ? s.setGroups({ email: v }) : Promise.resolve(true)]).then((r) => r.every(Boolean)))}
            />
          </Row>
        </div>
      </div>

      {desktop && (
        <div className="cw-card">
          <h3>{t("Folders it can use")}</h3>
          <p>{t("Folders and code projects you attached. Remove one to stop the Coworker using it.")}</p>
          <div className="cw-folders">
            {(d?.folders ?? []).length === 0 ? <span style={{ fontSize: 12.5, color: "var(--cw-muted)" }}>{t("No folders attached yet.")}</span> : d!.folders.map((f) => (
              <div key={f.path} className="cw-folder" title={f.path}>
                {f.repo ? <GitBranch size={14} /> : <Folder size={14} />}
                <span>{f.name} <small style={{ color: "var(--cw-muted)" }}>{f.path}</small></span>
                <button type="button" className="cw-icon-btn" aria-label={`${t("Remove")} ${f.name}`} onClick={() => void guard((async () => { await coworkerUi()?.removeFolder(f.path); s.removeFolder(f.path); await s.refreshDesktop(); return true; })())}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <div className="cw-row" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="cw-btn" onClick={() => void s.pickFolder(false)}><FolderPlus size={13} style={{ verticalAlign: -2, marginRight: 6 }} />{t("Attach a folder")}</button>
            <button type="button" className="cw-btn" onClick={() => void s.pickFolder(true)}><GitBranch size={13} style={{ verticalAlign: -2, marginRight: 6 }} />{t("Use a code project")}</button>
          </div>
        </div>
      )}

      <div className="cw-card">
        <h3>{t("Things it should always know")}</h3>
        <p>{t("Write it the way you'd tell a new employee.")}</p>
        <textarea value={memory} maxLength={2000} placeholder={t("We close on Fridays at 2. Invoices go in Documents › Invoices, one folder per month.")} onChange={(e) => { setMemory(e.target.value); setMemoryState("idle"); }} aria-label={t("Things it should always know")} />
        <div className="cw-saverow">
          <span>{memory.length}/2000</span>
          {memoryState === "saved" && <span className="cw-ok">{t("Saved")}</span>}
          <button type="button" className="cw-btn primary" disabled={memoryState === "saving" || memory === s.prefs.memory} onClick={async () => { setMemoryState("saving"); const ok = await s.updatePrefs({ memory }); setMemoryState(ok ? "saved" : "idle"); }}>
            {memoryState === "saving" ? t("Saving…") : t("Save")}
          </button>
        </div>
      </div>

      <div className="cw-card">
        <h3>{t("How it talks to you")}</h3>
        {([["short", "Short and to the point", "Tells you what it did in a couple of lines."], ["detailed", "Walk me through it", "Explains each step and why it did it."]] as const).map(([v, title, body]) => (
          <label key={v} className={`cw-choice${s.prefs.detail === v ? " on" : ""}`}>
            <input type="radio" name="cw-detail" checked={s.prefs.detail === v} onChange={() => void guard(s.updatePrefs({ detail: v }))} />
            <div><b>{t(title)}</b><span>{t(body)}</span></div>
          </label>
        ))}
        <div>
          <Row icon={<ListChecks size={15} />} title={t("Show every step while it works")} body={t("The live list of what it's looking at and doing")}>
            <Switch label={t("Show every step while it works")} checked={s.prefs.showSteps} onChange={(v) => void guard(s.updatePrefs({ showSteps: v }))} />
          </Row>
          <Row icon={<Check size={15} />} title={t("Let me know when a task finishes")} body={t("A red dot on the bubble and a Windows notification")}>
            <Switch label={t("Let me know when a task finishes")} checked={s.prefs.notify} onChange={(v) => void guard(s.updatePrefs({ notify: v }))} />
          </Row>
          <Row icon={<MessageSquare size={15} />} title={t("Send my voice right away")} body={t("When you finish speaking, it sends instead of waiting for you to press Send")}>
            <Switch label={t("Send my voice right away")} checked={s.prefs.autoSendVoice} onChange={(v) => void guard(s.updatePrefs({ autoSendVoice: v }))} />
          </Row>
        </div>
      </div>

      <div className="cw-card">
        <h3>{t("Bubble & history")}</h3>
        <div>
          {desktop && (
            <Row icon={<Laptop size={15} />} title={t("Show the bubble on my screen")} body={t("Drag it anywhere, on any monitor")}>
              <Switch label={t("Show the bubble on my screen")} checked={!!d?.bubble} onChange={(v) => void guard(s.setBubble(v))} />
            </Row>
          )}
          <Row icon={<History size={15} />} title={t("Keep past tasks for 30 days")} body={t("Show your recent tasks in the list")}>
            <Switch label={t("Keep past tasks for 30 days")} checked={s.prefs.keepHistory} onChange={(v) => void guard(s.updatePrefs({ keepHistory: v }))} />
          </Row>
        </div>
      </div>
    </div>
  );
}

function Row({ icon, title, body, children }: { icon: ReactNode; title: string; body: string; children: ReactNode }) {
  return (
    <div className="cw-trow">
      <span className="cw-ti">{icon}</span>
      <div><b>{title}</b><span>{body}</span></div>
      {children}
    </div>
  );
}
