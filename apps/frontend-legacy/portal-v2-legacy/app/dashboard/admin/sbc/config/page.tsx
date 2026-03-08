"use client";

import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

type SbcConfig = {
  id: string;
  mode: "LOCAL" | "REMOTE";
  remoteUpstreamHost: string | null;
  remoteUpstreamPort: number;
  updatedAt: string;
  updatedByUserId: string | null;
};

function readRole(): string {
  const token = localStorage.getItem("token");
  if (!token) return "";
  try {
    return JSON.parse(atob(token.split(".")[1])).role || "";
  } catch {
    return "";
  }
}

export default function AdminSbcConfigPage() {
  const [role, setRole] = useState("");
  const token = useMemo(() => (typeof window === "undefined" ? "" : localStorage.getItem("token") || ""), []);

  const [config, setConfig] = useState<SbcConfig | null>(null);
  const [readiness, setReadiness] = useState<any>(null);
  const [activeUpstream, setActiveUpstream] = useState("");

  const [mode, setMode] = useState<"LOCAL" | "REMOTE">("LOCAL");
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState("7443");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  async function loadConfig() {
    const res = await fetch(`${apiBase}/admin/sbc/config`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      setMsg(String(json?.error || "Failed to load SBC config"));
      return;
    }
    setConfig(json.config);
    setReadiness(json.readiness || null);
    setActiveUpstream(String(json.activeUpstream || ""));
    setMode(json.config?.mode || "LOCAL");
    setRemoteHost(String(json.config?.remoteUpstreamHost || ""));
    setRemotePort(String(json.config?.remoteUpstreamPort || 7443));
  }

  async function loadReadiness() {
    const res = await fetch(`${apiBase}/admin/sbc/readiness`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null);
    if (json?.ok) setReadiness(json);
  }

  async function saveConfig() {
    setSaving(true);
    setMsg("");
    try {
      const payload: any = {
        mode,
        remoteUpstreamPort: Number(remotePort || "7443")
      };
      if (mode === "REMOTE") payload.remoteUpstreamHost = remoteHost.trim();

      const res = await fetch(`${apiBase}/admin/sbc/config`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) {
        setMsg(String(json?.error || "Failed to apply SBC config"));
        return;
      }

      setMsg("SBC config applied successfully.");
      setConfig(json.config);
      setReadiness(json.readiness || null);
      setActiveUpstream(String(json.activeUpstream || ""));
      setMode(json.config?.mode || "LOCAL");
      setRemoteHost(String(json.config?.remoteUpstreamHost || ""));
      setRemotePort(String(json.config?.remoteUpstreamPort || 7443));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    const r = readRole();
    setRole(r);
    if (r !== "SUPER_ADMIN") return;
    loadConfig().catch(() => undefined);
    loadReadiness().catch(() => undefined);
  }, []);

  if (role !== "SUPER_ADMIN") {
    return <div className="card"><h1>SBC Upstream Config</h1><p>Insufficient permissions.</p></div>;
  }

  return (
    <div className="card">
      <h1>SBC Upstream Config</h1>
      <p>Switch `/sip` between LOCAL and REMOTE SBC targets with safe apply checks.</p>

      <button onClick={() => { loadConfig().catch(() => undefined); loadReadiness().catch(() => undefined); }}>Refresh</button>
      {msg ? <p className="status-chip pending" style={{ borderRadius: 2 }}>{msg}</p> : null}

      <h3>Current Active Upstream</h3>
      <p><strong>{activeUpstream || "unknown"}</strong></p>
      {config ? <p>Last updated: {config.updatedAt ? new Date(config.updatedAt).toLocaleString() : "n/a"}</p> : null}

      <h3>Mode</h3>
      <select value={mode} onChange={(e) => setMode(e.target.value as "LOCAL" | "REMOTE")}>
        <option value="LOCAL">LOCAL (127.0.0.1:7443)</option>
        <option value="REMOTE">REMOTE (external SBC host)</option>
      </select>

      {mode === "REMOTE" ? (
        <div style={{ marginTop: 8 }}>
          <label style={{ display: "block", marginBottom: 8 }}>
            Remote host
            <input value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder="sbc1.connectcomunications.com" style={{ marginLeft: 8, minWidth: 320 }} />
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            Remote port
            <input value={remotePort} onChange={(e) => setRemotePort(e.target.value)} type="number" min={1} max={65535} style={{ marginLeft: 8, width: 120 }} />
          </label>
          <p className="status-chip failed" style={{ borderRadius: 2 }}>
            REMOTE requires the other server to run kamailio on 7443 and be reachable from this server.
          </p>
        </div>
      ) : null}

      <button onClick={() => saveConfig().catch(() => undefined)} disabled={saving}>
        {saving ? "Applying..." : "Save / Apply"}
      </button>

      <h3>Readiness Probes</h3>
      <table>
        <tbody>
          <tr><td>Mode</td><td>{readiness?.mode || config?.mode || "UNKNOWN"}</td></tr>
          <tr><td>nginxSipProxy</td><td>{readiness?.probes?.nginxSipProxy || "UNKNOWN"}</td></tr>
          <tr><td>kamailioUp</td><td>{readiness?.probes?.kamailioUp || "UNKNOWN"}</td></tr>
          <tr><td>rtpengineUp</td><td>{readiness?.probes?.rtpengineUp || "UNKNOWN"}</td></tr>
          <tr><td>rtpengineControlReachableFromKamailio</td><td>{readiness?.probes?.rtpengineControlReachableFromKamailio || "UNKNOWN"}</td></tr>
          <tr><td>pbxReachableFromKamailio</td><td>{readiness?.probes?.pbxReachableFromKamailio || "UNKNOWN"}</td></tr>
          <tr><td>remoteUpstreamReachable</td><td>{readiness?.probes?.remoteUpstreamReachable || "UNKNOWN"}</td></tr>
        </tbody>
      </table>
    </div>
  );
}