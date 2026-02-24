"use client";

import { useEffect, useMemo, useState } from "react";

type Campaign = {
  id: string;
  tenantId: string;
  name: string;
  status: string;
  holdReason?: string | null;
  riskScore: number;
  createdAt: string;
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

export default function AdminCampaignApprovalsPage() {
  const role = useMemo(() => (typeof window !== "undefined" ? readJwtRole() : ""), []);
  const [rows, setRows] = useState<Campaign[]>([]);
  const [reason, setReason] = useState("");

  async function load() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/sms/campaigns?status=NEEDS_APPROVAL`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const json = await res.json();
    setRows(Array.isArray(json) ? json : []);
  }

  useEffect(() => {
    if (role === "ADMIN") load();
  }, [role]);

  async function approve(id: string) {
    const token = localStorage.getItem("token") || "";
    await fetch(`${apiBase}/admin/sms/campaigns/${id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    await load();
  }

  async function reject(id: string) {
    const token = localStorage.getItem("token") || "";
    await fetch(`${apiBase}/admin/sms/campaigns/${id}/reject`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ reason: reason || "Rejected by admin" })
    });
    await load();
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
      <h1>Campaign Approval Queue</h1>
      <p>Campaigns held by compliance, risk, or tenant guardrails appear here.</p>
      <label>
        Reject reason:
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason to save on campaign" />
      </label>
      <ul>
        {rows.map((c) => (
          <li key={c.id} style={{ marginBottom: 16 }}>
            <strong>{c.name}</strong> ({c.status})
            <div>Tenant: {c.tenantId}</div>
            <div>Risk score: {c.riskScore}</div>
            <div>Hold reason: {c.holdReason || "n/a"}</div>
            <button onClick={() => approve(c.id)}>Approve + Queue</button>
            <button onClick={() => reject(c.id)}>Reject</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
