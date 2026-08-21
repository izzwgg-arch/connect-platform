"use client";

/**
 * Ground Rules + the Watchman — Phase 5a/5b of the support console.
 *
 * Izzy writes three plain-English lists (allowed / never / ask first). Every
 * save is a new version, so the history below IS the audit trail. The "what
 * would happen?" box runs the same classifier the execution engine will call,
 * so a rule can be tested before it is trusted.
 */
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../../../../services/apiClient";

type Rules = { allowed: string; never: string; askFirst: string };
type HistoryRow = { version: number; note: string | null; updatedBy: string; createdAt: string };
type RulesPayload = {
  rules: Rules;
  version: number;
  isDefault: boolean;
  maxBlockChars: number;
  history: HistoryRow[];
  renderedForAgent: string;
};
type Verdict = { decision: "allowed" | "ask_first" | "never"; matchedRule: string | null; reason: string };
type WatchCheck = { id: string; label: string; status: "ok" | "warn" | "bad" | "unknown"; detail: string };
type Watchman = { checkedAt: string; safeToWork: boolean; blockers: string[]; checks: WatchCheck[] };

function errorText(e: unknown): string {
  const body = (e as { body?: { message?: string; error?: string } })?.body;
  return body?.message || (e as Error)?.message || "Something went wrong.";
}

const DECISION_LABEL: Record<Verdict["decision"], { text: string; cls: string }> = {
  allowed: { text: "Allowed — the agent would just do it", cls: "sd-chip-ok" },
  ask_first: { text: "Asks you first", cls: "sd-chip-warn" },
  never: { text: "Refused — never", cls: "sd-chip-bad" },
};

export default function SupportRules() {
  const [data, setData] = useState<RulesPayload | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [draft, setDraft] = useState<Rules>({ allowed: "", never: "", askFirst: "" });
  const [note, setNote] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState("");
  const [testAction, setTestAction] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [watch, setWatch] = useState<Watchman | null>(null);
  const [showRendered, setShowRendered] = useState(false);

  const load = useCallback(async () => {
    try {
      const out = await apiGet<RulesPayload>("/admin/support/ground-rules");
      setData(out);
      setDraft(out.rules);
      setDirty(false);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  const loadWatch = useCallback(async () => {
    try {
      setWatch(await apiGet<Watchman>("/admin/support/watchman"));
    } catch {
      setWatch(null);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadWatch();
    const t = window.setInterval(() => void loadWatch(), 60_000);
    return () => window.clearInterval(t);
  }, [load, loadWatch]);

  function edit(key: keyof Rules, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
    setSaved("");
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const out = await apiPost<{ version: number }>("/admin/support/ground-rules", { ...draft, note: note.trim() || undefined });
      setSaved(`Saved as version ${out.version}.`);
      setNote("");
      await load();
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  async function runCheck() {
    if (!testAction.trim()) return;
    try {
      const out = await apiPost<{ verdict: Verdict }>("/admin/support/ground-rules/check", { action: testAction.trim() });
      setVerdict(out.verdict);
    } catch (e) {
      setSaveError(errorText(e));
    }
  }

  if (state === "loading") return <div className="sd-state">Loading the ground rules…</div>;
  if (state === "error" || !data) return <div className="sd-state sd-state-bad">Couldn&apos;t load the ground rules.</div>;

  return (
    <div className="sd-rules">
      {/* The Watchman strip — what the agent checks before it does anything. */}
      <div className={"sd-watch " + (watch ? (watch.safeToWork ? "ok" : "bad") : "")}>
        <div className="sd-watch-head">
          <b>{watch ? (watch.safeToWork ? "✓ Everything checks out" : "⏸ The agent should not be working right now") : "Checking…"}</b>
          {watch ? <span className="sd-dim">checked {new Date(watch.checkedAt).toLocaleTimeString()}</span> : null}
          <button className="sd-btn" onClick={() => void loadWatch()}>Check again</button>
        </div>
        <div className="sd-watch-grid">
          {(watch?.checks ?? []).map((c) => (
            <div key={c.id} className={"sd-watch-item sd-w-" + c.status}>
              <span className="sd-watch-label">{c.label}</span>
              <span className="sd-dim">{c.detail}</span>
            </div>
          ))}
        </div>
        {watch && watch.blockers.length ? (
          <ul className="sd-watch-blockers">
            {watch.blockers.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        ) : null}
      </div>

      <div className="sd-detail-head">
        <h2>Ground rules {data.isDefault ? <span className="sd-chip sd-chip-warn">using the safe defaults</span> : <span className="sd-chip sd-chip-dim">version {data.version}</span>}</h2>
        <div className="sd-meta">
          Write them in plain English, one rule per line. The agent is given these before every job — and the
          &ldquo;never&rdquo; and &ldquo;ask first&rdquo; lists are enforced in code too, so a refusal holds even if the
          agent is talked into something.
        </div>
      </div>

      <div className="sd-rule-cols">
        <div className="sd-rule-col allow">
          <h5>✓ Allowed — no asking</h5>
          <textarea value={draft.allowed} maxLength={data.maxBlockChars} onChange={(e) => edit("allowed", e.target.value)} rows={9} />
        </div>
        <div className="sd-rule-col deny">
          <h5>✕ Never — even if asked</h5>
          <textarea value={draft.never} maxLength={data.maxBlockChars} onChange={(e) => edit("never", e.target.value)} rows={9} />
        </div>
        <div className="sd-rule-col ask">
          <h5>⏸ Ask me first</h5>
          <textarea value={draft.askFirst} maxLength={data.maxBlockChars} onChange={(e) => edit("askFirst", e.target.value)} rows={9} />
        </div>
      </div>

      <div className="sd-rule-actions">
        <input
          className="sd-rule-note"
          value={note}
          placeholder="What changed? (optional, shown in the history)"
          onChange={(e) => setNote(e.target.value)}
        />
        <button className="sd-btn sd-btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save as a new version"}
        </button>
        <button className="sd-btn" onClick={() => setShowRendered((v) => !v)}>
          {showRendered ? "Hide" : "See what the agent is told"}
        </button>
      </div>
      {saved ? <div className="sd-banner sd-banner-ok">{saved}</div> : null}
      {saveError ? <div className="sd-banner sd-banner-bad">{saveError}</div> : null}
      {showRendered ? <pre className="sd-rendered">{data.renderedForAgent}</pre> : null}

      <div className="sd-rule-test">
        <h5>Try a rule before you trust it</h5>
        <div className="sd-composer">
          <input
            value={testAction}
            placeholder="e.g. restart the worker container"
            onChange={(e) => setTestAction(e.target.value)}
            onKeyDown={(e) => (e.key === "Enter" ? void runCheck() : null)}
          />
          <button className="sd-btn" onClick={() => void runCheck()}>What would happen?</button>
        </div>
        {verdict ? (
          <div className="sd-verdict">
            <span className={"sd-chip " + DECISION_LABEL[verdict.decision].cls}>{DECISION_LABEL[verdict.decision].text}</span>
            <span className="sd-dim">{verdict.reason}</span>
          </div>
        ) : null}
      </div>

      {data.history.length ? (
        <div className="sd-rule-history">
          <h5>History</h5>
          {data.history.map((h) => (
            <div className="sd-kv" key={h.version}>
              <span>Version {h.version}{h.note ? ` — ${h.note}` : ""}</span>
              <b>{new Date(h.createdAt).toLocaleString()}</b>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
