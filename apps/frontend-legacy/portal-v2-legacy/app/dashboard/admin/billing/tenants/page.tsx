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

export default function AdminBillingTenantsPage() {
  const role = useMemo(() => (typeof window !== "undefined" ? readJwtRole() : ""), []);
  const [rows, setRows] = useState<any[]>([]);
  const [message, setMessage] = useState("");

  async function load() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/billing/tenants`, { headers: { Authorization: `Bearer ${token}` } });
    setRows(await res.json());
  }

  async function overrideStatus(tenantId: string, status: string) {
    const reason = prompt("Override reason", "Manual billing override") || "Manual billing override";
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/billing/tenants/${tenantId}/override-status`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status, reason })
    });
    setMessage(JSON.stringify(await res.json(), null, 2));
    await load();
  }

  useEffect(() => {
    if (role === "SUPER_ADMIN") load();
  }, [role]);

  if (role !== "SUPER_ADMIN") {
    return <div className="card"><h1>Admin Billing</h1><p>Insufficient permissions.</p></div>;
  }

  return (
    <div className="card">
      <h1>Admin Billing: Tenants</h1>
      <table>
        <thead>
          <tr><th>Tenant</th><th>Subscription</th><th>Last Payment</th><th>Suspended</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tenantId}>
              <td>{r.tenantName}</td>
              <td>{r.subscription?.status || "NONE"} ({r.subscription?.planCode || "-"})</td>
              <td>{r.subscription?.lastPaymentStatus || "-"}</td>
              <td>{r.smsSuspended ? "YES" : "NO"}</td>
              <td>
                <button onClick={() => overrideStatus(r.tenantId, "ACTIVE")}>Set ACTIVE</button>
                <button onClick={() => overrideStatus(r.tenantId, "PAST_DUE")}>Set PAST_DUE</button>
                <button onClick={() => overrideStatus(r.tenantId, "CANCELED")}>Set CANCELED</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {message ? <pre>{message}</pre> : null}
    </div>
  );
}
