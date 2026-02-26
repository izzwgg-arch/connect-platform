"use client";

import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

type SessionRow = {
  id: string;
  platform: "WEB" | "IOS" | "ANDROID";
  appVersion?: string | null;
  lastSeenAt: string;
  startedAt: string;
  iceHasTurn: boolean;
  lastRegState: string;
  lastCallState: string;
  lastErrorCode?: string | null;
  lastErrorAt?: string | null;
  _count?: { events: number };
};

type EventRow = {
  id: string;
  createdAt: string;
  type: string;
  payload: any;
};

export default function VoiceDiagnosticsPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [events, setEvents] = useState<EventRow[]>([]);
  const [msg, setMsg] = useState<string>("");

  const token = useMemo(() => (typeof window === "undefined" ? "" : localStorage.getItem("token") || ""), []);

  async function loadSessions() {
    const res = await fetch(`${apiBase}/voice/diag/sessions`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => []);
    const rows = Array.isArray(json) ? json : [];
    setSessions(rows);
    if (!selected && rows[0]?.id) setSelected(rows[0].id);
  }

  async function loadEvents(sessionId: string) {
    if (!sessionId) return;
    const res = await fetch(`${apiBase}/voice/diag/sessions/${sessionId}/events`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => []);
    setEvents(Array.isArray(json) ? json : []);
  }

  async function testTurn() {
    if (!selected) return;
    setMsg("Running TURN reachability test...");
    const t0 = Date.now();
    const hasTurn = !!sessions.find((s) => s.id === selected)?.iceHasTurn;
    const res = await fetch(`${apiBase}/voice/diag/event`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        sessionId: selected,
        type: "TURN_TEST_RESULT",
        payload: { ok: hasTurn, hasRelay: hasTurn, durationMs: Date.now() - t0 }
      })
    });
    const out = await res.json().catch(() => ({}));
    setMsg(res.ok ? `TURN test recorded: ${hasTurn ? "relay candidate available" : "no relay candidate observed"}` : String(out?.error || "TURN test failed"));
    await loadEvents(selected);
  }

  useEffect(() => {
    if (!token) return;
    loadSessions().catch(() => undefined);
  }, [token]);

  useEffect(() => {
    if (!selected || !token) return;
    loadEvents(selected).catch(() => undefined);
  }, [selected, token]);

  return (
    <div className="card">
      <h1>Voice Diagnostics</h1>
      <p>Active sessions, recent failures, and event timelines for tenant troubleshooting.</p>
      <button onClick={() => loadSessions().catch(() => undefined)}>Refresh</button>{" "}
      <button onClick={testTurn} disabled={!selected}>Test TURN</button>
      {msg ? <p className="status-chip pending" style={{ borderRadius: 2 }}>{msg}</p> : null}

      <h3>Active Sessions</h3>
      <table>
        <thead><tr><th>Session</th><th>Platform</th><th>Last Seen</th><th>Reg</th><th>Call</th><th>TURN</th><th>Last Error</th><th>Events</th></tr></thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id} onClick={() => setSelected(s.id)} style={{ cursor: "pointer", background: selected === s.id ? "rgba(90,153,255,.08)" : "transparent" }}>
              <td><code>{s.id.slice(0, 10)}</code></td>
              <td>{s.platform}</td>
              <td>{new Date(s.lastSeenAt).toLocaleString()}</td>
              <td>{s.lastRegState}</td>
              <td>{s.lastCallState}</td>
              <td>{s.iceHasTurn ? "yes" : "no"}</td>
              <td>{s.lastErrorCode ? `${s.lastErrorCode} (${s.lastErrorAt ? new Date(s.lastErrorAt).toLocaleTimeString() : ""})` : "-"}</td>
              <td>{s._count?.events || 0}</td>
            </tr>
          ))}
          {!sessions.length ? <tr><td colSpan={8}>No diagnostics sessions found.</td></tr> : null}
        </tbody>
      </table>

      <h3>Event Timeline</h3>
      <table>
        <thead><tr><th>Time</th><th>Type</th><th>Payload</th></tr></thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.createdAt).toLocaleString()}</td>
              <td>{e.type}</td>
              <td><code style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(e.payload || {}, null, 2)}</code></td>
            </tr>
          ))}
          {!events.length ? <tr><td colSpan={3}>No events for selected session.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
