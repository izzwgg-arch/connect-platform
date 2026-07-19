"use client";
/**
 * Agent Approvals — owner-only. Lists pending agent actions with one-tap
 * approve/deny, plus recently decided. Talks to /agent-api/admin + decide.
 * Authorization is enforced server-side by the agent (owner JWT); this page
 * simply won't return data for non-owners.
 */
import { useCallback, useEffect, useState } from "react";

type Action = {
  id: string;
  tenantId: string;
  capabilityId: string;
  summary: string;
  status: string;
  requestedBy: string;
  createdAt: string;
};

function token(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/agent-api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

export default function AgentApprovalsPage() {
  const [pending, setPending] = useState<Action[]>([]);
  const [recent, setRecent] = useState<Action[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ pending: Action[]; recent: Action[] }>("/admin/approvals");
      setPending(data.pending);
      setRecent(data.recent);
      setErr(null);
    } catch {
      setErr("This page is available to owners only, or the agent is unreachable.");
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const decide = useCallback(
    async (actionId: string, decision: "approve" | "deny") => {
      setBusy(actionId);
      try {
        await api("/actions/decide", { method: "POST", body: JSON.stringify({ actionId, decision }) });
        await load();
      } catch {
        setErr("Decision failed — try again.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700 }}>Agent Approvals</h1>
      <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>Every PBX change the agent proposes waits here. Same items arrive by email with one-tap links.</div>
      {err && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{err}</div>}

      <h3 style={{ fontSize: 14, marginBottom: 8 }}>Pending ({pending.length})</h3>
      {pending.length === 0 && <div style={{ opacity: 0.6, fontSize: 13, marginBottom: 16 }}>Nothing waiting.</div>}
      {pending.map((a) => (
        <div key={a.id} style={{ border: "1px solid rgba(245,158,11,.5)", borderRadius: 10, padding: 12, marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <b>{a.summary}</b>
            <span style={{ fontSize: 12, opacity: 0.7 }}>{a.capabilityId} · {a.tenantId}</span>
          </div>
          <div style={{ fontSize: 12, opacity: 0.7, margin: "6px 0" }}>Requested by {a.requestedBy} · {new Date(a.createdAt).toLocaleString()}</div>
          <button disabled={busy === a.id} onClick={() => decide(a.id, "approve")} style={{ ...btn, background: "#22c55e", color: "#04150a" }}>✓ Approve</button>{" "}
          <button disabled={busy === a.id} onClick={() => decide(a.id, "deny")} style={{ ...btn, color: "#ef4444", border: "1px solid #ef4444" }}>✕ Deny</button>
        </div>
      ))}

      <h3 style={{ fontSize: 14, margin: "18px 0 8px" }}>Recently decided</h3>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <tbody>
          {recent.map((a) => (
            <tr key={a.id} style={{ borderBottom: "1px solid rgba(128,128,128,.2)" }}>
              <td style={{ padding: "6px 8px" }}>{a.summary}</td>
              <td style={{ padding: "6px 8px", opacity: 0.7 }}>{a.tenantId}</td>
              <td style={{ padding: "6px 8px", textAlign: "right" }}>{a.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const btn: React.CSSProperties = { padding: "6px 14px", borderRadius: 8, border: "1px solid transparent", background: "transparent", cursor: "pointer", fontSize: 13, fontWeight: 600 };
