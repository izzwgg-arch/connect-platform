"use client";
/**
 * Agent Activity — owner-only. Live counts + audit feed + Watchman incidents.
 * Consumes /agent-api/admin/activity + /admin/incidents (owner JWT).
 */
import { useCallback, useEffect, useState } from "react";

type Ev = { id: string; ts: string; actor: string; event: string; tenantId?: string | null };
type Counts = { conversationsToday: number; actionsExecuted: number; pendingApprovals: number; openIncidents: number; diagReports: number };
type Incident = { id: string; type: string; severity: string; status: string; createdAt: string };

function token() { return typeof window === "undefined" ? "" : (localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || ""); }
async function api<T>(p: string): Promise<T> {
  const r = await fetch(`/agent-api${p}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

const sevColor: Record<string, string> = { critical: "#ef4444", warning: "#f59e0b", info: "#8b98a9" };

export default function AgentActivityPage() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const a = await api<{ counts: Counts; events: Ev[] }>("/admin/activity");
      const inc = await api<{ incidents: Incident[] }>("/admin/incidents");
      setCounts(a.counts); setEvents(a.events); setIncidents(inc.incidents); setErr(null);
    } catch { setErr("Owners only, or the agent is unreachable."); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

  const kpi = (label: string, value: number | string, color?: string) => (
    <div style={{ flex: 1, minWidth: 130, border: "1px solid rgba(128,128,128,.3)", borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, opacity: 0.7 }}>{label}</div>
    </div>
  );

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700 }}>Agent Activity</h1>
      <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>Everything the agent does, live. Auto-refreshes every 10s.</div>
      {err && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{err}</div>}
      {counts && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
          {kpi("Conversations today", counts.conversationsToday)}
          {kpi("Actions executed", counts.actionsExecuted)}
          {kpi("Pending approvals", counts.pendingApprovals, counts.pendingApprovals ? "#f59e0b" : undefined)}
          {kpi("Open incidents", counts.openIncidents, counts.openIncidents ? "#ef4444" : "#22c55e")}
          {kpi("Diagnoses today", counts.diagReports)}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid rgba(128,128,128,.3)", borderRadius: 10, padding: 12 }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>Live feed</h3>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 460, overflowY: "auto" }}>
            {events.map((e) => (
              <li key={e.id} style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: "1px solid rgba(128,128,128,.15)", fontSize: 12.5 }}>
                <span style={{ opacity: 0.6, whiteSpace: "nowrap" }}>{new Date(e.ts).toLocaleTimeString()}</span>
                <span><b>{e.event}</b>{e.tenantId ? ` · ${e.tenantId}` : ""} <span style={{ opacity: 0.6 }}>({e.actor})</span></span>
              </li>
            ))}
          </ul>
        </div>
        <div style={{ border: "1px solid rgba(128,128,128,.3)", borderRadius: 10, padding: 12 }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>Watchman — security & health</h3>
          {incidents.length === 0 ? (
            <div style={{ opacity: 0.6, fontSize: 13, color: "#22c55e" }}>No open incidents. All clear.</div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 460, overflowY: "auto" }}>
              {incidents.map((i) => (
                <li key={i.id} style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: "1px solid rgba(128,128,128,.15)", fontSize: 12.5 }}>
                  <span style={{ width: 6, borderRadius: 3, background: sevColor[i.severity] ?? "#8b98a9", flexShrink: 0 }} />
                  <span><b>{i.type}</b> <span style={{ opacity: 0.6 }}>· {i.severity} · {i.status}</span><br /><span style={{ opacity: 0.6 }}>{new Date(i.createdAt).toLocaleString()}</span></span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
