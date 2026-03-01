"use client";

import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

function readRole(): string {
  const token = localStorage.getItem("token");
  if (!token) return "";
  try {
    return JSON.parse(atob(token.split(".")[1])).role || "";
  } catch {
    return "";
  }
}

export default function AdminVoiceDiagnosticsPage() {
  const [role, setRole] = useState("");
  const [summary, setSummary] = useState<any>(null);
  const [tenants, setTenants] = useState<any[]>([]);
  const [turnTenants, setTurnTenants] = useState<any[]>([]);
  const [mediaMetrics, setMediaMetrics] = useState<any>(null);
  const [opsPlan, setOpsPlan] = useState<any>(null);
  const [failedRequiredOnly, setFailedRequiredOnly] = useState(false);
  const [metricsRange, setMetricsRange] = useState<"24h" | "7d">("24h");
  const [globalUrlsInput, setGlobalUrlsInput] = useState("");
  const [globalUsernameInput, setGlobalUsernameInput] = useState("");
  const [globalCredentialInput, setGlobalCredentialInput] = useState("");
  const [globalConfig, setGlobalConfig] = useState<any>(null);
  const [msg, setMsg] = useState("");

  const token = useMemo(() => (typeof window === "undefined" ? "" : localStorage.getItem("token") || ""), []);

  async function load() {
    const [sumRes, tenRes, turnRes, globalRes, metricsRes, opsRes] = await Promise.all([
      fetch(`${apiBase}/admin/voice/diag/summary`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/admin/voice/diag/tenants`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/admin/voice/turn/tenants${failedRequiredOnly ? "?failedRequiredOnly=true" : ""}`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/admin/voice/turn/global`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/admin/voice/media-metrics?range=${metricsRange}`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/admin/sbc/ops-plan`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    setSummary(await sumRes.json().catch(() => null));
    const t = await tenRes.json().catch(() => []);
    setTenants(Array.isArray(t) ? t : []);
    const tt = await turnRes.json().catch(() => []);
    setTurnTenants(Array.isArray(tt) ? tt : []);
    const g = await globalRes.json().catch(() => ({}));
    setGlobalConfig(g?.config || null);
    setGlobalUrlsInput((g?.config?.urls || []).join("\n"));
    setGlobalUsernameInput(g?.config?.username || "");
    setMediaMetrics(await metricsRes.json().catch(() => null));
    setOpsPlan(await opsRes.json().catch(() => null));
  }

  async function saveGlobalTurn() {
    const urls = globalUrlsInput.split("\n").map((x) => x.replace("\r", "").trim()).filter(Boolean);
    const res = await fetch(`${apiBase}/admin/voice/turn/global`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        urls,
        username: globalUsernameInput || undefined,
        ...(globalCredentialInput.trim() ? { credential: globalCredentialInput.trim() } : {})
      })
    });
    const out = await res.json().catch(() => ({}));
    setMsg(res.ok ? "Global TURN config saved." : String(out?.error || "Failed to save global TURN config"));
    setGlobalCredentialInput("");
    await load();
  }

  useEffect(() => {
    const r = readRole();
    setRole(r);
    if (r === "SUPER_ADMIN") load().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (role !== "SUPER_ADMIN") return;
    load().catch(() => undefined);
  }, [failedRequiredOnly, metricsRange]);

  if (role !== "SUPER_ADMIN") return <div className="card"><h1>Voice Diagnostics</h1><p>Insufficient permissions.</p></div>;

  return (
    <div className="card">
      <h1>Admin Voice Diagnostics</h1>
      <p>Cross-tenant reliability summary with TURN/media compliance and SBC ops planning guidance.</p>
      <button onClick={() => load().catch(() => undefined)}>Refresh</button>
      {msg ? <p className="status-chip pending" style={{ borderRadius: 2 }}>{msg}</p> : null}

      <h3>Global TURN Defaults</h3>
      <p>Current scope: {globalConfig?.scope || "none"}, credential: {globalConfig?.hasCredential ? "set" : "not set"}</p>
      <textarea rows={4} style={{ width: "100%" }} placeholder="turn:global-turn.example.com:3478\nturns:global-turn.example.com:5349" value={globalUrlsInput} onChange={(e) => setGlobalUrlsInput(e.target.value)} />
      <input style={{ width: "100%", marginTop: 8 }} placeholder="Global TURN username (optional, masked in reads)" value={globalUsernameInput} onChange={(e) => setGlobalUsernameInput(e.target.value)} />
      <input style={{ width: "100%", marginTop: 8 }} placeholder="Global TURN credential (stored encrypted; never returned)" value={globalCredentialInput} onChange={(e) => setGlobalCredentialInput(e.target.value)} />
      <div style={{ marginTop: 8 }}>
        <button onClick={() => saveGlobalTurn().catch(() => undefined)}>Save Global TURN Config</button>
      </div>

      <h3>Global Summary</h3>
      <table>
        <tbody>
          <tr><td>Sessions (24h)</td><td>{summary?.sessions24h ?? "-"}</td></tr>
          <tr><td>Sessions without TURN (24h)</td><td>{summary?.percentSessionsWithoutTurn24h ?? "-"}%</td></tr>
          <tr><td>WS disconnect rate (1h)</td><td>{summary?.wsDisconnectRatePerSession1h ?? "-"}</td></tr>
          <tr><td>Answer -&gt; Connect ratio (1h)</td><td>{summary?.answerToConnectRatio1h ?? "-"}</td></tr>
          <tr><td>Invite -&gt; Connect latency p95 (24h)</td><td>{summary?.inviteToConnectLatencyP95Ms24h ?? "-"} ms</td></tr>
        </tbody>
      </table>

      <h3>Media Metrics</h3>
      <label>
        <input type="radio" checked={metricsRange === "24h"} onChange={() => setMetricsRange("24h")} /> 24h
      </label>{" "}
      <label>
        <input type="radio" checked={metricsRange === "7d"} onChange={() => setMetricsRange("7d")} /> 7d
      </label>
      <table>
        <tbody>
          <tr><td>Total Media Tests</td><td>{mediaMetrics?.totalMediaTests ?? 0}</td></tr>
          <tr><td>Passed</td><td>{mediaMetrics?.passed ?? 0}</td></tr>
          <tr><td>Failed</td><td>{mediaMetrics?.failed ?? 0}</td></tr>
          <tr><td>Relay True</td><td>{mediaMetrics?.relayTrueCount ?? 0}</td></tr>
          <tr><td>Relay False</td><td>{mediaMetrics?.relayFalseCount ?? 0}</td></tr>
        </tbody>
      </table>
      <p>Top error codes: {(mediaMetrics?.topErrorCodes || []).map((e: any) => `${e.code} (${e.count})`).join(", ") || "none"}</p>

      <h4>Top failing tenants ({metricsRange})</h4>
      <table>
        <thead><tr><th>Tenant</th><th>Tenant ID</th><th>Failures</th></tr></thead>
        <tbody>
          {(mediaMetrics?.tenantsFailingMost || []).map((t: any) => (
            <tr key={t.tenantId}>
              <td>{t.tenantName}</td>
              <td><code>{t.tenantId}</code></td>
              <td>{t.failures}</td>
            </tr>
          ))}
          {!(mediaMetrics?.tenantsFailingMost || []).length ? <tr><td colSpan={3}>No failing tenants in range.</td></tr> : null}
        </tbody>
      </table>

      <h3>TURN + Media Compliance</h3>
      <label>
        <input type="checkbox" checked={failedRequiredOnly} onChange={(e) => setFailedRequiredOnly(e.target.checked)} />{" "}
        Show FAILED/STALE/UNKNOWN + REQUIRED only
      </label>
      <table>
        <thead><tr><th>Tenant</th><th>TURN Required</th><th>TURN Status</th><th>Media Gate</th><th>Media Policy</th><th>Media Status</th><th>Validated/Tested</th><th>Last Error</th></tr></thead>
        <tbody>
          {turnTenants.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td>{t.turnRequiredForMobile ? "yes" : "no"}</td>
              <td>{t.turnValidationStatus}</td>
              <td>{t.mediaReliabilityGateEnabled ? "yes" : "no"}</td>
              <td>{t.mediaPolicy || "TURN_ONLY"}</td>
              <td>{t.mediaTestStatus || "UNKNOWN"}</td>
              <td>{t.turnValidatedAt ? new Date(t.turnValidatedAt).toLocaleString() : "-"} / {t.mediaTestedAt ? new Date(t.mediaTestedAt).toLocaleString() : "-"}</td>
              <td>{t.mediaLastErrorCode || t.turnLastErrorCode || "-"}</td>
            </tr>
          ))}
          {!turnTenants.length ? <tr><td colSpan={8}>No tenant TURN/media rows.</td></tr> : null}
        </tbody>
      </table>

      <h3>SBC Ops Plan (Output Only)</h3>
      <p>Recommended UDP range: <strong>{opsPlan?.recommendation?.udpRange || "35000-35199/udp"}</strong></p>
      <pre style={{ whiteSpace: "pre-wrap", background: "#0f172a", color: "#e2e8f0", padding: 12, borderRadius: 6 }}>{opsPlan?.plan || "Ops plan unavailable"}</pre>

      <h3>Top Failing Tenants (24h)</h3>
      <table>
        <thead><tr><th>Tenant</th><th>Tenant ID</th><th>Failure Events</th></tr></thead>
        <tbody>
          {tenants.map((t) => (
            <tr key={t.tenantId}>
              <td>{t.tenantName}</td>
              <td><code>{t.tenantId}</code></td>
              <td>{t.failureEvents24h}</td>
            </tr>
          ))}
          {!tenants.length ? <tr><td colSpan={3}>No failure hotspots found.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}