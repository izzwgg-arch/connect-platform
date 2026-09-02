"use client";
/**
 * The Coworker's hands, as the person sees them: the four-question approval card
 * (what / where / why / can it be undone), the running/finished state, and the
 * Permissions view (Safe / Trusted).
 *
 * ⛔ THE CARD ONLY EVER SHOWS A TASK THE API HANDED BACK, AND THE DESKTOP ONLY EVER
 * RUNS THE TASK THE APPROVE ROUTE HANDED BACK. Nothing here composes a task; the
 * page is the hosted portal, so anything it could compose a compromised server
 * could compose too. The renderer's whole authority is a button press.
 *
 * ⛔ Mounted ONLY inside the docked Coworker popover (/desktop/coworker). It asks
 * `/coworker/tasks/pending` after each assistant reply and when the panel opens —
 * never on a timer (the voicemail-flood lesson: a poll on every page for every
 * customer forever is how an office bans itself).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FolderOpen, Loader2, ShieldCheck, X } from "lucide-react";
import { apiGet, apiPost } from "../services/apiClient";

export type CoworkerTaskShape =
  | { kind: "folder_summary"; folder: "downloads" | "desktop" | "documents"; reason: string }
  | { kind: "organize_folder"; folder: "downloads" | "desktop" | "documents"; reason: string }
  | { kind: "system_snapshot"; reason: string };

export type PendingCoworkerTask = {
  id: string;
  task: CoworkerTaskShape;
  card: { title: string; what: string; where: string; why: string; reversible: string; risk: string; readOnly: boolean; action: string };
  verdict: "allow" | "ask";
  createdAt: string;
  expiresAt: string;
};

type LocalVerdict = { verdict: "allow" | "ask" | "deny"; code: string; message: string };
type RunResult = { ok: boolean; summary: string; details?: string[]; code?: string };
type Bridge = {
  decideTask?: (task: CoworkerTaskShape) => Promise<{ ok: true; verdict: LocalVerdict } | { ok: false; refused: string }>;
  runTask?: (payload: { id: string; task: CoworkerTaskShape }) => Promise<{ ok: true; result: RunResult } | { ok: false; refused: string }>;
};
function bridge(): Bridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { coworkerWidget?: Bridge };
  return w.coworkerWidget && typeof w.coworkerWidget.runTask === "function" ? w.coworkerWidget : null;
}

export function usePendingCoworkerTasks(enabled: boolean) {
  const [tasks, setTasks] = useState<PendingCoworkerTask[]>([]);
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await apiGet<{ tasks: PendingCoworkerTask[] }>("/coworker/tasks/pending");
      setTasks(Array.isArray(r?.tasks) ? r.tasks : []);
    } catch {
      /* a failed poll leaves the last known list; nothing here may throw into the chat */
    } finally {
      inFlight.current = false;
    }
  }, [enabled]);
  const drop = useCallback((id: string) => setTasks((t) => t.filter((x) => x.id !== id)), []);
  return { tasks, refresh, drop };
}

type Phase = { state: "idle" } | { state: "running" } | { state: "done"; result: RunResult } | { state: "refused"; message: string };

/** Local refusals, in the person's words. */
function refusalText(code: string): string {
  switch (code) {
    case "busy": return "The Coworker is still finishing another task — try again in a moment.";
    case "rate_limited": return "The Coworker has done a lot in the last hour and is pausing. Try again later.";
    case "too_soon_for_this_folder": return "That folder was organized less than a minute ago. Give it a moment before doing it again.";
    case "call_in_progress": return "You are on a call. The Coworker will do this once the call is over.";
    case "no_desktop": return "This can only run inside the Loopcom app on your computer.";
    case "task_expired": return "That request is too old to run now — ask the Coworker again.";
    case "task_already_answered": return "That request was already answered.";
    default: return "The Coworker could not run that on this computer.";
  }
}

export function CoworkerTaskCard({ task, onDone, onDismissed, sayInChat }: {
  task: PendingCoworkerTask;
  onDone: (id: string) => void;
  onDismissed: (id: string) => void;
  sayInChat: (text: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const [local, setLocal] = useState<LocalVerdict | null>(null);
  const [showList, setShowList] = useState(false);

  // Ask the desktop what IT thinks before the person decides: a call in progress
  // or the Safe profile changes the wording under the button.
  useEffect(() => {
    let alive = true;
    const b = bridge();
    if (!b?.decideTask) return;
    b.decideTask(task.task).then((r) => { if (alive && r.ok) setLocal(r.verdict); }).catch(() => {});
    return () => { alive = false; };
  }, [task.id, task.task]);

  const run = useCallback(async () => {
    const b = bridge();
    if (!b?.runTask) { setPhase({ state: "refused", message: refusalText("no_desktop") }); return; }
    setPhase({ state: "running" });
    let approved: { ok: boolean; id: string; task: CoworkerTaskShape };
    try {
      approved = await apiPost<{ ok: boolean; id: string; task: CoworkerTaskShape }>(`/coworker/tasks/${encodeURIComponent(task.id)}/approve`, {});
    } catch (e) {
      const code = (e as { body?: { error?: string } })?.body?.error ?? "";
      setPhase({ state: "refused", message: refusalText(code) });
      onDismissed(task.id);
      return;
    }
    // ⛔ The desktop runs the task the API returned — the one the person approved —
    // not the copy this component holds.
    const r = await b.runTask({ id: approved.id, task: approved.task }).catch(() => ({ ok: false as const, refused: "task_failed" }));
    const result: RunResult = r.ok ? r.result : { ok: false, summary: refusalText(r.refused), code: r.refused };
    try {
      await apiPost(`/coworker/tasks/${encodeURIComponent(task.id)}/result`, { ok: result.ok, summary: result.summary, details: result.details ?? [], ...(result.code ? { code: result.code } : {}) });
    } catch { /* the record is best-effort; the person still gets told below */ }
    setPhase({ state: "done", result });
    sayInChat(result.ok ? `✅ ${result.summary}` : `⚠️ ${result.summary}`);
    onDone(task.id);
  }, [task, onDone, onDismissed, sayInChat]);

  const dismiss = useCallback(async () => {
    try { await apiPost(`/coworker/tasks/${encodeURIComponent(task.id)}/dismiss`, {}); } catch { /* already gone is fine */ }
    onDismissed(task.id);
  }, [task.id, onDismissed]);

  if (phase.state === "done") {
    return (
      <div className={`fa-cw-card fa-cw-done ${phase.result.ok ? "" : "fa-cw-failed"}`}>
        <div className="fa-cw-top"><span className="fa-cw-ico">{phase.result.ok ? <Check size={14} /> : <X size={14} />}</span><b>{phase.result.ok ? "Done" : "Not done"}</b></div>
        <p>{phase.result.summary}</p>
        {phase.result.details && phase.result.details.length > 0 && (
          <ul className="fa-cw-list">{phase.result.details.map((d, i) => <li key={i}>{d}</li>)}</ul>
        )}
      </div>
    );
  }
  if (phase.state === "refused") {
    return (
      <div className="fa-cw-card fa-cw-failed">
        <div className="fa-cw-top"><span className="fa-cw-ico"><X size={14} /></span><b>Not run</b></div>
        <p>{phase.message}</p>
      </div>
    );
  }

  const running = phase.state === "running";
  return (
    <div className="fa-cw-card" role="group" aria-label="Task approval">
      <div className="fa-cw-top">
        <span className="fa-cw-ico"><FolderOpen size={14} /></span>
        <b>{task.card.title}</b>
        {task.card.readOnly ? <span className="fa-cw-pill fa-cw-pill-ok">Read only</span> : <span className="fa-cw-pill">Moves files</span>}
      </div>
      <dl className="fa-cw-dl">
        <dt>What</dt><dd>{task.card.what}</dd>
        <dt>Where</dt><dd>{task.card.where}</dd>
        <dt>Why</dt><dd>{task.card.why}</dd>
        <dt>Undo</dt><dd>{task.card.reversible}</dd>
      </dl>
      {local && local.verdict !== "allow" && <p className="fa-cw-note">{local.message}</p>}
      {showList && task.task.kind === "organize_folder" && (
        <p className="fa-cw-note">Loose files in that folder go into subfolders named Images, Documents, Spreadsheets, PDFs, Presentations, Installers, Archives, Videos, Audio or Other. Folders, shortcuts and files still downloading are left alone. Nothing is deleted.</p>
      )}
      <div className="fa-cw-actions">
        <button className="fa-cw-btn fa-cw-primary" onClick={run} disabled={running}>
          {running ? <><Loader2 size={14} className="fa-cw-spin" /> Working…</> : task.card.action}
        </button>
        {task.task.kind === "organize_folder" && !showList && (
          <button className="fa-cw-btn" onClick={() => setShowList(true)} disabled={running}>Show me what moves</button>
        )}
        <button className="fa-cw-btn" onClick={dismiss} disabled={running}>No</button>
      </div>
    </div>
  );
}

/** The Permissions view: Safe (asks before any change) vs Trusted (moves without asking). */
export function CoworkerPermissionsView({ onBack }: { onBack: () => void }) {
  const [profile, setProfile] = useState<"SAFE" | "TRUSTED">("SAFE");
  const [saving, setSaving] = useState(false);
  const desk = () => (typeof window === "undefined" ? null : (window as unknown as { connectDesktop?: { window?: { getSettings?: () => Promise<{ coworkerPermissions?: "SAFE" | "TRUSTED" }>; updateSettings?: (p: { coworkerPermissions: "SAFE" | "TRUSTED" }) => Promise<unknown> } } }).connectDesktop?.window ?? null);
  useEffect(() => {
    desk()?.getSettings?.().then((s) => setProfile(s?.coworkerPermissions === "TRUSTED" ? "TRUSTED" : "SAFE")).catch(() => {});
  }, []);
  const choose = async (p: "SAFE" | "TRUSTED") => {
    setSaving(true);
    setProfile(p);
    try { await desk()?.updateSettings?.({ coworkerPermissions: p }); } catch { /* stays as shown; the desktop re-reads at run time */ } finally { setSaving(false); }
  };
  const rows: { thing: string; safe: string; trusted: string; never: boolean }[] = [
    { thing: "Read a folder (count files, sizes)", safe: "Allowed", trusted: "Allowed", never: false },
    { thing: "Read Windows version, uptime, memory", safe: "Allowed", trusted: "Allowed", never: false },
    { thing: "Move loose files into subfolders (never deletes)", safe: "Asks first", trusted: "Allowed", never: false },
    { thing: "Delete anything", safe: "Never", trusted: "Never", never: true },
    { thing: "Run a program or a command", safe: "Never", trusted: "Never", never: true },
    { thing: "Send a file anywhere", safe: "Never", trusted: "Never", never: true },
    { thing: "Touch a folder outside Downloads, Desktop, Documents", safe: "Never", trusted: "Never", never: true },
    { thing: "Read a password, a card, a key", safe: "Never", trusted: "Never", never: true },
  ];
  return (
    <div className="fa-cw-perms">
      <div className="fa-cw-top"><span className="fa-cw-ico"><ShieldCheck size={14} /></span><b>What the Coworker may do on this computer</b></div>
      <div className="fa-cw-profiles">
        <label className={profile === "SAFE" ? "on" : ""}>
          <input type="radio" name="cw-profile" checked={profile === "SAFE"} onChange={() => choose("SAFE")} disabled={saving} />
          <b>Safe</b><small>Reads freely. Asks before it moves anything.</small>
        </label>
        <label className={profile === "TRUSTED" ? "on" : ""}>
          <input type="radio" name="cw-profile" checked={profile === "TRUSTED"} onChange={() => choose("TRUSTED")} disabled={saving} />
          <b>Trusted</b><small>Moves files in your own folders without asking. Still never deletes.</small>
        </label>
      </div>
      <table className="fa-cw-table">
        <thead><tr><th>Action</th><th>Safe</th><th>Trusted</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.thing} className={r.never ? "fa-cw-never" : ""}><td>{r.thing}</td><td>{r.safe}</td><td>{r.trusted}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="fa-cw-note">The "Never" rows are not settings — no profile, no chat message and no update can switch them on. Everything else runs only while this window is open, on this computer, and is written to your task history.</p>
      <div className="fa-cw-actions"><button className="fa-cw-btn" onClick={onBack}>Back to chat</button></div>
    </div>
  );
}

export const COWORKER_TASK_STYLES = `
.fa-cw-card { border: 1px solid var(--border, #23344f); background: var(--panel-2, #0f1a2c); border-radius: 12px; padding: 12px; margin: 6px 0 10px; font-size: 13px; }
.fa-cw-card p { margin: 6px 0 0; color: var(--text, #e6edf7); }
.fa-cw-failed { border-color: color-mix(in srgb, var(--danger, #f06060) 50%, var(--border, #23344f)); }
.fa-cw-top { display: flex; align-items: center; gap: 8px; }
.fa-cw-top b { flex: 1; min-width: 0; }
.fa-cw-ico { width: 24px; height: 24px; border-radius: 8px; background: var(--accent, #22a8ff); color: #04121d; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.fa-cw-pill { font-size: 10px; letter-spacing: .04em; text-transform: uppercase; padding: 2px 6px; border-radius: 999px; border: 1px solid var(--border, #23344f); color: var(--text-dim, #8b9ab2); }
.fa-cw-pill-ok { color: var(--success, #34c27b); border-color: color-mix(in srgb, var(--success, #34c27b) 50%, transparent); }
.fa-cw-dl { display: grid; grid-template-columns: 52px 1fr; gap: 4px 8px; margin: 10px 0 0; }
.fa-cw-dl dt { color: var(--text-dim, #8b9ab2); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; padding-top: 2px; }
.fa-cw-dl dd { margin: 0; }
.fa-cw-note { color: var(--text-dim, #8b9ab2); font-size: 12px; }
.fa-cw-list { margin: 6px 0 0; padding-left: 18px; color: var(--text-dim, #8b9ab2); }
.fa-cw-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.fa-cw-btn { border: 1px solid var(--border, #23344f); background: var(--panel, #16233a); color: var(--text, #e6edf7); border-radius: 8px; padding: 6px 10px; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.fa-cw-btn:disabled { opacity: .6; cursor: default; }
.fa-cw-primary { background: var(--accent, #22a8ff); color: #04121d; border-color: transparent; font-weight: 600; }
.fa-cw-spin { animation: fa-cw-spin 1s linear infinite; }
@keyframes fa-cw-spin { to { transform: rotate(360deg); } }
.fa-cw-perms { padding: 14px; font-size: 13px; }
.fa-cw-profiles { display: grid; gap: 8px; margin: 12px 0; }
.fa-cw-profiles label { display: grid; grid-template-columns: 18px 1fr; grid-template-rows: auto auto; column-gap: 8px; align-items: center; padding: 10px; border: 1px solid var(--border, #23344f); border-radius: 10px; cursor: pointer; }
.fa-cw-profiles label.on { border-color: var(--accent, #22a8ff); }
.fa-cw-profiles input { grid-row: 1 / span 2; }
.fa-cw-profiles small { color: var(--text-dim, #8b9ab2); }
.fa-cw-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.fa-cw-table th, .fa-cw-table td { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--border, #23344f); }
.fa-cw-table th { color: var(--text-dim, #8b9ab2); font-weight: 500; }
.fa-cw-never td { color: var(--text-dim, #8b9ab2); }
`;
