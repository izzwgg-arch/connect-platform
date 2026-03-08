"use client";

import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

function readJwtRole(): string {
  const token = localStorage.getItem("token");
  if (!token) return "";
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.role || "";
  } catch {
    return "";
  }
}

export default function AdminSmsProvidersPage() {
  const role = useMemo(() => (typeof window !== "undefined" ? readJwtRole() : ""), []);
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    if (role !== "ADMIN" && role !== "SUPER_ADMIN") return;
    const token = localStorage.getItem("token") || "";
    fetch(`${apiBase}/admin/sms/provider-health`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((j) => setData(j));
  }, [role]);

  if (role !== "ADMIN" && role !== "SUPER_ADMIN") {
    return <div className="card"><h1>SMS Provider Ops</h1><p>Insufficient permissions.</p></div>;
  }

  return (
    <div className="card">
      <h1>SMS Provider Ops Dashboard</h1>
      <p>Provider distribution: TWILIO {data?.providerDistribution?.TWILIO || 0} / VOIPMS {data?.providerDistribution?.VOIPMS || 0}</p>
      <p>Recent failovers: {data?.failoversRecent || 0}</p>

      <h3>Top failing tenants</h3>
      <ul>
        {(data?.topFailingTenants || []).map((t: any) => (
          <li key={t.tenantId}>{t.tenantName} - failed {t.failed}, sent {t.sent}, open circuits {t.openCircuits}</li>
        ))}
      </ul>

      <h3>Tenants with circuits open</h3>
      <ul>
        {(data?.circuitsOpen || []).map((t: any) => (
          <li key={t.tenantId}>{t.tenantName} - open circuits {t.openCircuits}</li>
        ))}
      </ul>

      <h3>Recent locks</h3>
      <ul>
        {(data?.recentLocks || []).map((l: any) => (
          <li key={l.id}>{l.tenantId} - {l.action} - {new Date(l.createdAt).toLocaleString()}</li>
        ))}
      </ul>
    </div>
  );
}
