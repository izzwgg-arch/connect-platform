"use client";
/**
 * AI Trainer — owner-only. Every correction a designated trainer taught the
 * agent, with who taught it and exactly when, plus one-click Revoke. Paired
 * with the trainer's activity trail (prompts, button presses, actions and
 * whether each one actually executed) pulled from the agent audit log.
 * Consumes /agent-api/admin/trainer/* + /admin/activity (owner JWT).
 */
import { useCallback, useEffect, useMemo, useState } from "react";

type Lesson = {
  id: string;
  tenantId: string;
  lesson: string;
  rawText: string;
  createdById: string;
  createdByName: string | null;
  sourceConversationId: string | null;
  active: boolean;
  revokedAt: string | null;
  revokedBy: string | null;
  createdAt: string;
};
type Ev = { id: string; ts: string; actor: string; event: string; tenantId?: string | null; payload?: any };

function token() {
  return typeof window === "undefined" ? "" : (localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "");
}
async function get<T>(p: string): Promise<T> {
  const r = await fetch(`/agent-api${p}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
async function post<T>(p: string, body: object): Promise<T> {
  const r = await fetch(`/agent-api${p}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,.3)", borderRadius: 12, padding: 16, marginBottom: 14 };
const btn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 12.5 };
const pill: React.CSSProperties = { padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 600 };

/** Plain-English label + colour for each logged event type. */
function describe(e: Ev): { label: string; detail: string; color: string } {
  const p = e.payload ?? {};
  switch (e.event) {
    case "chat.user_message":
      return { label: "He wrote a message", detail: `${p.chars ?? "?"} characters${p.attachments?.length ? `, ${p.attachments.length} attachment(s)` : ""}`, color: "#8b98a9" };
    case "chat.agent_reply":
      return { label: "Agent replied", detail: p.model ? `model ${p.model}` : "", color: "#8b98a9" };
    case "chat.triage_reply":
      return { label: "Agent handled a request", detail: `${p.intent ?? ""}${p.actionId ? ` · action ${p.actionId}` : ""}`, color: "#3b82f6" };
    case "trainer.lesson_added":
      return { label: "TAUGHT THE AGENT", detail: p.lesson ?? "", color: "#a855f7" };
    case "trainer.lesson_revoked":
      return { label: "Lesson revoked", detail: p.lesson ?? "", color: "#f59e0b" };
    case "chat.ui_event":
      return { label: "Pressed a button", detail: String(p.name ?? ""), color: "#8b98a9" };
    case "action.executed":
      return { label: "ACTION EXECUTED ✔", detail: p.summary ?? p.capabilityId ?? "", color: "#22c55e" };
    case "action.failed":
    case "action.denied":
      return { label: "ACTION DID NOT RUN ✘", detail: p.reason ?? p.summary ?? "", color: "#ef4444" };
    default:
      return { label: e.event, detail: typeof p === "object" ? Object.keys(p).slice(0, 3).join(", ") : "", color: "#8b98a9" };
  }
}

export default function AiTrainerPage() {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const l = await get<{ lessons: Lesson[] }>("/admin/trainer/lessons");
      setLessons(l.lessons);
      try {
        const a = await get<{ events: Ev[] }>("/admin/activity");
        setEvents(a.events ?? []);
      } catch {
        setEvents([]);
      }
      setErr(null);
    } catch {
      setErr("Owners only, or the agent is unreachable.");
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const revoke = async (id: string) => {
    setBusy(id);
    try {
      await post("/admin/trainer/lessons/revoke", { id });
      await load();
    } catch {
      setErr("Could not revoke that lesson.");
    } finally {
      setBusy(null);
    }
  };

  const visible = useMemo(() => lessons.filter((l) => (showRevoked ? true : l.active)), [lessons, showRevoked]);
  const activeCount = lessons.filter((l) => l.active).length;
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700 }}>AI Trainer</h1>
      <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Everything your tester has taught the agent, and everything he did — with the exact date and time. Lessons take effect immediately; revoke any one and the agent stops following it right away.
      </div>
      {err && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{err}</div>}

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <h3 style={{ fontSize: 14, margin: 0 }}>
            Lessons taught <span style={{ ...pill, background: "#1e1b4b", color: "#a855f7", marginLeft: 8 }}>{activeCount} active</span>
          </h3>
          <label style={{ fontSize: 12.5, opacity: 0.8, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} /> show revoked
          </label>
        </div>
        {visible.length === 0 ? (
          <div style={{ opacity: 0.6, fontSize: 13 }}>Nothing taught yet. When the trainer says “add that to your memory” in the assistant, it appears here.</div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {visible.map((l) => (
              <li key={l.id} style={{ padding: "10px 0", borderBottom: "1px solid rgba(128,128,128,.15)", opacity: l.active ? 1 : 0.55 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>{l.lesson}</div>
                    <div style={{ fontSize: 12, opacity: 0.7, marginTop: 3 }}>
                      Taught by {l.createdByName || l.createdById} · {when(l.createdAt)}
                      {!l.active && l.revokedAt ? ` · revoked ${when(l.revokedAt)}` : ""}
                    </div>
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ fontSize: 11.5, opacity: 0.6, cursor: "pointer" }}>his exact words</summary>
                      <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4, whiteSpace: "pre-wrap" }}>{l.rawText}</div>
                    </details>
                  </div>
                  {l.active ? (
                    <button style={btn} disabled={busy === l.id} onClick={() => revoke(l.id)}>
                      {busy === l.id ? "…" : "Revoke"}
                    </button>
                  ) : (
                    <span style={{ ...pill, background: "#3b1417", color: "#ef4444" }}>revoked</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={card}>
        <h3 style={{ fontSize: 14, marginTop: 0, marginBottom: 8 }}>Activity trail</h3>
        <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 8 }}>Every prompt, button press and action — and whether it actually executed. Refreshes every 15 seconds.</div>
        {events.length === 0 ? (
          <div style={{ opacity: 0.6, fontSize: 13 }}>No activity recorded yet.</div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 520, overflowY: "auto" }}>
            {events.map((e) => {
              const d = describe(e);
              return (
                <li key={e.id} style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: "1px solid rgba(128,128,128,.15)", fontSize: 12.5 }}>
                  <span style={{ opacity: 0.6, whiteSpace: "nowrap" }}>{when(e.ts)}</span>
                  <span style={{ color: d.color, fontWeight: 600, whiteSpace: "nowrap" }}>{d.label}</span>
                  <span style={{ opacity: 0.75 }}>{d.detail}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
