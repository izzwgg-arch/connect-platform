"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { mapCampaignBadgeStatus } from "./utils";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function SmsCampaignsListPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/sms/campaigns`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => []);
    if (!Array.isArray(json)) {
      setError("Failed to load campaigns");
      setLoading(false);
      return;
    }
    setRows(json);
    setLoading(false);
  }

  useEffect(() => {
    load().catch(() => setError("Failed to load campaigns"));
  }, []);

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      const status = mapCampaignBadgeStatus(String(row.uiStatus || row.status || ""));
      if (statusFilter !== "ALL" && status !== statusFilter) return false;
      if (search.trim() && !String(row.name || "").toLowerCase().includes(search.trim().toLowerCase())) return false;
      return true;
    });
  }, [rows, statusFilter, search]);

  return (
    <div className="card">
      <h1>SMS Campaigns</h1>
      <p><Link href="/dashboard/sms/campaigns/new">Create Campaign</Link></p>
      <div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="ALL">All statuses</option>
          <option value="DRAFT">DRAFT</option>
          <option value="READY">READY</option>
          <option value="SENDING">SENDING</option>
          <option value="SENT">SENT</option>
          <option value="FAILED">FAILED</option>
          <option value="BLOCKED">BLOCKED</option>
        </select>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by campaign name" />
      </div>
      {error ? <p className="status-chip failed" style={{ borderRadius: 2 }}>{error}</p> : null}
      {loading ? <p>Loading campaigns...</p> : null}
      {!loading && filteredRows.length === 0 ? <p>No campaigns found. <Link href="/dashboard/sms/campaigns/new">Create Campaign</Link></p> : null}
      <table>
        <thead>
          <tr><th>Name</th><th>Status</th><th>Created</th><th>Sent</th><th>Failed</th><th /></tr>
        </thead>
        <tbody>
          {filteredRows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td><span className={`status-chip ${mapCampaignBadgeStatus(String(r.uiStatus || r.status || "")) === "FAILED" || mapCampaignBadgeStatus(String(r.uiStatus || r.status || "")) === "BLOCKED" ? "failed" : mapCampaignBadgeStatus(String(r.uiStatus || r.status || "")) === "SENT" ? "live" : "pending"}`}>{mapCampaignBadgeStatus(String(r.uiStatus || r.status || ""))}</span></td>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
              <td>{Number(r.sentCount || 0)}</td>
              <td>{Number(r.failedCount || 0)}</td>
              <td><Link href={`/dashboard/sms/campaigns/${r.id}`}>Open</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
