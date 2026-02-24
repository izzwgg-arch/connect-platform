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

export default function AdminNumbersPage() {
  const role = useMemo(() => (typeof window !== "undefined" ? readJwtRole() : ""), []);
  const [rows, setRows] = useState<any[]>([]);
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");

  async function load() {
    const token = localStorage.getItem("token") || "";
    const q = new URLSearchParams();
    if (provider) q.set("provider", provider);
    if (status) q.set("status", status);
    const res = await fetch(`${apiBase}/admin/numbers?${q.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    setRows(await res.json());
  }

  useEffect(() => {
    if (role === "SUPER_ADMIN") load();
  }, [role, provider, status]);

  if (role !== "SUPER_ADMIN") {
    return <div className="card"><h1>Admin Numbers</h1><p>Insufficient permissions.</p></div>;
  }

  return (
    <div className="card">
      <h1>Admin Numbers</h1>
      <select value={provider} onChange={(e) => setProvider(e.target.value)}>
        <option value="">All Providers</option>
        <option value="TWILIO">TWILIO</option>
        <option value="VOIPMS">VOIPMS</option>
      </select>
      <select value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">All Statuses</option>
        <option value="ACTIVE">ACTIVE</option>
        <option value="RELEASING">RELEASING</option>
        <option value="RELEASED">RELEASED</option>
        <option value="SUSPENDED">SUSPENDED</option>
      </select>
      <table>
        <thead>
          <tr><th>Tenant</th><th>Number</th><th>Provider</th><th>Status</th><th>Orphaned</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.tenantName}</td>
              <td>{r.phoneNumber}</td>
              <td>{r.provider}</td>
              <td>{r.status}</td>
              <td>{r.isOrphaned ? "YES" : "NO"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
