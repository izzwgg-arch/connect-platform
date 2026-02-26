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
  const token = useMemo(() => (typeof window === "undefined" ? "" : localStorage.getItem("token") || ""), []);

  async function load() {
    const [sumRes, tenRes] = await Promise.all([
      fetch(`${apiBase}/admin/voice/diag/summary`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/admin/voice/diag/tenants`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    setSummary(await sumRes.json().catch(() => null));
    const t = await tenRes.json().catch(() => []);
    setTenants(Array.isArray(t) ? t : []);
  }

  useEffect(() => {
    const r = readRole();
    setRole(r);
    if (r === "SUPER_ADMIN") load().catch(() => undefined);
  }, []);

  if (role !== "SUPER_ADMIN") return <div className="card"><h1>Voice Diagnostics</h1><p>Insufficient permissions.</p></div>;

  return (
    <div className="card">
      <h1>Admin Voice Diagnostics</h1>
      <p>Cross-tenant reliability summary with failure hotspots.</p>
      <button onClick={() => load().catch(() => undefined)}>Refresh</button>

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
