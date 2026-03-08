"use client";

import { useEffect, useMemo, useState } from "react";

type TenantRow = {
  id: string;
  name: string;
  isApproved: boolean;
  dailySmsCap: number;
  perSecondRate: number;
  firstCampaignRequiresApproval: boolean;
  stats: { users: number; campaigns: number };
};

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

export default function AdminTenantsPage() {
  const role = useMemo(() => (typeof window !== "undefined" ? readJwtRole() : ""), []);
  const [rows, setRows] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/tenants`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    setRows(Array.isArray(json) ? json : []);
    setLoading(false);
  }

  useEffect(() => {
    if (role === "ADMIN") load();
  }, [role]);

  async function patchTenant(id: string, data: Partial<TenantRow>) {
    setSavingId(id);
    const token = localStorage.getItem("token") || "";
    await fetch(`${apiBase}/admin/tenants/${id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(data)
    });
    await load();
    setSavingId(null);
  }

  if (role !== "ADMIN") {
    return (
      <div className="card">
        <h1>Admin Access Required</h1>
        <p>This page is available to ADMIN role users only.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h1>Tenant Safety Controls</h1>
      {loading && <p>Loading tenants...</p>}
      <ul>
        {rows.map((t) => (
          <li key={t.id} style={{ marginBottom: 16 }}>
            <strong>{t.name}</strong>
            <div>Users: {t.stats.users} | Campaigns: {t.stats.campaigns}</div>
            <label>
              <input
                type="checkbox"
                checked={t.isApproved}
                onChange={(e) => patchTenant(t.id, { isApproved: e.target.checked })}
                disabled={savingId === t.id}
              />
              Approved for outbound SMS
            </label>
            <div>
              Daily SMS cap:
              <input
                type="number"
                defaultValue={t.dailySmsCap}
                onBlur={(e) => patchTenant(t.id, { dailySmsCap: Number(e.target.value) })}
                disabled={savingId === t.id}
              />
            </div>
            <div>
              Per-second rate:
              <input
                type="number"
                step="0.1"
                defaultValue={t.perSecondRate}
                onBlur={(e) => patchTenant(t.id, { perSecondRate: Number(e.target.value) })}
                disabled={savingId === t.id}
              />
            </div>
            <label>
              <input
                type="checkbox"
                checked={t.firstCampaignRequiresApproval}
                onChange={(e) => patchTenant(t.id, { firstCampaignRequiresApproval: e.target.checked })}
                disabled={savingId === t.id}
              />
              First campaign requires approval
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
