"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function SmsCampaignsListPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [error, setError] = useState("");

  async function load() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/sms/campaigns`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => []);
    if (!Array.isArray(json)) {
      setError("Failed to load campaigns");
      return;
    }
    setRows(json);
  }

  useEffect(() => {
    load().catch(() => setError("Failed to load campaigns"));
  }, []);

  return (
    <div className="card">
      <h1>SMS Campaigns</h1>
      <p><Link href="/dashboard/sms/campaigns/new">Create campaign draft</Link></p>
      {error ? <p className="status-chip failed" style={{ borderRadius: 2 }}>{error}</p> : null}
      <table>
        <thead>
          <tr><th>Name</th><th>Status</th><th>Created</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.status}</td>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
              <td><Link href={`/dashboard/sms/campaigns/${r.id}`}>Open</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
