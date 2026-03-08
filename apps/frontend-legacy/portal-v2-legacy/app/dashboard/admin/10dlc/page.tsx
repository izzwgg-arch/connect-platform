"use client";

import { useEffect, useMemo, useState } from "react";

type Submission = {
  id: string;
  legalName: string;
  status: string;
  supportEmail: string;
  createdAt: string;
  internalNotes?: string | null;
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

export default function AdminTenDlcPage() {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [selected, setSelected] = useState<Submission | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [note, setNote] = useState("");
  const role = useMemo(() => (typeof window !== "undefined" ? readJwtRole() : ""), []);

  async function load() {
    const token = localStorage.getItem("token") || "";
    const q = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
    const res = await fetch(`${apiBase}/admin/ten-dlc/submissions${q}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    setSubmissions(Array.isArray(json) ? json : []);
  }

  useEffect(() => { if (role === "ADMIN") load(); }, [role, statusFilter]);

  async function loadDetail(id: string) {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/ten-dlc/submissions/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    setSelected(json);
  }

  async function changeStatus(status: "NEEDS_INFO" | "APPROVED" | "REJECTED") {
    if (!selected) return;
    const token = localStorage.getItem("token") || "";
    await fetch(`${apiBase}/admin/ten-dlc/submissions/${selected.id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status, note })
    });
    await load();
    await loadDetail(selected.id);
  }

  if (role !== "ADMIN") {
    return <div className="card"><h1>Admin Access Required</h1><p>This page is available to ADMIN role users only.</p></div>;
  }

  return (
    <div className="card">
      <h1>10DLC Admin Review</h1>
      <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
        <option value="">All statuses</option>
        <option value="SUBMITTED">SUBMITTED</option>
        <option value="NEEDS_INFO">NEEDS_INFO</option>
        <option value="APPROVED">APPROVED</option>
        <option value="REJECTED">REJECTED</option>
      </select>
      <ul>
        {submissions.map((s) => (
          <li key={s.id}>
            <button onClick={() => loadDetail(s.id)}>{s.legalName} ??? {s.status}</button>
          </li>
        ))}
      </ul>

      {selected && (
        <div>
          <h2>Submission Detail</h2>
          <pre>{JSON.stringify(selected, null, 2)}</pre>
          <textarea placeholder="Internal review note" value={note} onChange={(e) => setNote(e.target.value)} />
          <div>
            <button onClick={() => changeStatus("NEEDS_INFO")}>Mark NEEDS_INFO</button>
            <button onClick={() => changeStatus("APPROVED")}>Mark APPROVED</button>
            <button onClick={() => changeStatus("REJECTED")}>Mark REJECTED</button>
          </div>
        </div>
      )}
    </div>
  );
}
