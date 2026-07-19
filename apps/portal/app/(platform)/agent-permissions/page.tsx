"use client";
/**
 * Agent Permissions — owner-only. Per-tenant policy control: what the customer's
 * agent may do, channel access, and the "show old chats" toggle. Writes go to
 * /agent-api/admin/policies (owner JWT), versioned + diff-audited server-side.
 */
import { useCallback, useEffect, useState } from "react";

type Grant = { mode: "allowed" | "ask_owner" | "blocked"; limits?: Record<string, number>; businessHoursOnly?: boolean };
type Policy = { tenantId: string; version: number; historyVisible: boolean; channels: string[]; grants: Record<string, Grant>; updatedBy?: string };

const CAPS: { id: string; label: string }[] = [
  { id: "action.A1.temp_forward", label: "Call forwarding" },
  { id: "action.A7.dnd", label: "Do Not Disturb" },
  { id: "action.A3.ivr_switch", label: "IVR switch" },
  { id: "action.A5.vm_pin_reset", label: "Voicemail PIN reset" },
];

function token(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/agent-api${path}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, ...(init?.headers || {}) } });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

export default function AgentPermissionsPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [draft, setDraft] = useState<Policy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api<{ policies: Policy[] }>("/admin/policies");
      setPolicies(d.policies);
      setErr(null);
    } catch {
      setErr("Owners only, or the agent is unreachable.");
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const startEdit = (p?: Policy) => {
    setSaved(false);
    setDraft(p ?? { tenantId, version: 0, historyVisible: false, channels: ["chat"], grants: {} });
  };

  const setGrant = (capId: string, mode: Grant["mode"]) => {
    if (!draft) return;
    setDraft({ ...draft, grants: { ...draft.grants, [capId]: { ...(draft.grants[capId] || {}), mode } } });
  };

  const save = async () => {
    if (!draft || !draft.tenantId) { setErr("Enter a tenant id."); return; }
    try {
      await api("/admin/policies", { method: "POST", body: JSON.stringify({ tenantId: draft.tenantId, historyVisible: draft.historyVisible, channels: draft.channels, grants: draft.grants }) });
      setSaved(true);
      setDraft(null);
      await load();
    } catch {
      setErr("Save failed.");
    }
  };

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700 }}>Agent Permissions</h1>
      <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>Per-tenant control of what each customer&apos;s agent may do. Every change is versioned and audit-logged.</div>
      {err && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{err}</div>}
      {saved && <div style={{ color: "#22c55e", fontSize: 13, marginBottom: 12 }}>Saved ✓</div>}

      {!draft && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="tenant id to configure" style={inp} />
            <button onClick={() => startEdit()} style={btnBlue}>Configure</button>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr><th style={th}>Tenant</th><th style={th}>Version</th><th style={th}>History</th><th style={th}>Channels</th><th style={th}></th></tr></thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.tenantId} style={{ borderBottom: "1px solid rgba(128,128,128,.2)" }}>
                  <td style={td}>{p.tenantId}</td>
                  <td style={td}>v{p.version}</td>
                  <td style={td}>{p.historyVisible ? "ON" : "OFF"}</td>
                  <td style={td}>{(p.channels || []).join(", ")}</td>
                  <td style={{ ...td, textAlign: "right" }}><button onClick={() => startEdit(p)} style={btnGhost}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {draft && (
        <div style={{ border: "1px solid rgba(128,128,128,.3)", borderRadius: 10, padding: 16 }}>
          <div style={{ marginBottom: 12 }}><b>Tenant:</b> {draft.version ? draft.tenantId : <input value={draft.tenantId} onChange={(e) => setDraft({ ...draft, tenantId: e.target.value })} placeholder="tenant id" style={inp} />}</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 12 }}>
            <tbody>
              {CAPS.map((c) => (
                <tr key={c.id} style={{ borderBottom: "1px solid rgba(128,128,128,.15)" }}>
                  <td style={td}>{c.label}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <select value={draft.grants[c.id]?.mode ?? "blocked"} onChange={(e) => setGrant(c.id, e.target.value as Grant["mode"])} style={sel}>
                      <option value="allowed">Allowed (needs approval)</option>
                      <option value="ask_owner">Ask owner</option>
                      <option value="blocked">Blocked</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 13 }}>
            <input type="checkbox" checked={draft.historyVisible} onChange={(e) => setDraft({ ...draft, historyVisible: e.target.checked })} />
            Let this tenant browse their old chats (History)
          </label>
          <button onClick={save} style={btnBlue}>Save policy</button>{" "}
          <button onClick={() => setDraft(null)} style={btnGhost}>Cancel</button>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", fontSize: 11, textTransform: "uppercase", opacity: 0.6, padding: "6px 8px", borderBottom: "1px solid rgba(128,128,128,.3)" };
const td: React.CSSProperties = { padding: "8px" };
const inp: React.CSSProperties = { padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", fontSize: 13, flex: 1 };
const sel: React.CSSProperties = { padding: "6px 10px", borderRadius: 8, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", fontSize: 13 };
const btnBlue: React.CSSProperties = { padding: "8px 16px", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnGhost: React.CSSProperties = { padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 13 };
