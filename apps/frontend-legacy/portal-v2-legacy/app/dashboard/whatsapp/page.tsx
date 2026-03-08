"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

function badgeClass(status: string) {
  const s = String(status || "").toUpperCase();
  if (s === "FAILED") return "failed";
  if (s === "DELIVERED" || s === "SENT" || s === "INBOUND") return "live";
  return "pending";
}

export default function WhatsAppOpsPage() {
  const [status, setStatus] = useState<any>(null);
  const [threads, setThreads] = useState<any[]>([]);
  const [recent, setRecent] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    const token = localStorage.getItem("token") || "";
    const q = query.trim() ? `&q=${encodeURIComponent(query.trim())}` : "";
    const s = filterStatus ? `&status=${encodeURIComponent(filterStatus)}` : "";
    const [statusRes, threadRes, recentRes] = await Promise.all([
      fetch(`${apiBase}/whatsapp/status`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/whatsapp/threads?limit=100${q}${s}`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/whatsapp/messages/recent?limit=50`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    const statusJson = await statusRes.json().catch(() => null);
    const threadJson = await threadRes.json().catch(() => []);
    const recentJson = await recentRes.json().catch(() => []);
    setStatus(statusJson);
    setThreads(Array.isArray(threadJson) ? threadJson : []);
    setRecent(Array.isArray(recentJson) ? recentJson : []);
    if (!statusRes.ok || !threadRes.ok || !recentRes.ok) setError("Failed to load WhatsApp operations data.");
    setLoading(false);
  }

  useEffect(() => {
    load().catch(() => {
      setError("Failed to load WhatsApp operations data.");
      setLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emptyState = useMemo(() => !loading && (!threads.length && !recent.length), [loading, threads.length, recent.length]);

  return (
    <div className="card">
      <h1>WhatsApp Operations</h1>
      <p>Visibility for provider health, threads, and delivery status history.</p>

      <div style={{ marginBottom: 12 }}>
        <p>
          Provider enabled: <strong>{status?.enabled ? "Yes" : "No"}</strong> | Active provider: <strong>{status?.activeProvider || "None"}</strong>
        </p>
        <p>
          Webhook last seen: <strong>{status?.webhookLastSeenAt ? new Date(status.webhookLastSeenAt).toLocaleString() : "Never"}</strong>
        </p>
        {!status?.enabled ? (
          <p className="status-chip pending" style={{ borderRadius: 2 }}>
            Provider not enabled. <Link href="/dashboard/settings/providers/whatsapp">Configure WhatsApp Provider</Link>
          </p>
        ) : null}
      </div>

      <div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by number/contact" />
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="FAILED">FAILED</option>
          <option value="QUEUED">QUEUED</option>
          <option value="SENT">SENT</option>
          <option value="DELIVERED">DELIVERED</option>
          <option value="INBOUND">INBOUND</option>
        </select>
        <button onClick={() => load().catch(() => setError("Failed to refresh."))} disabled={loading}>{loading ? "Loading..." : "Refresh"}</button>
      </div>

      {error ? <p className="status-chip failed" style={{ borderRadius: 2 }}>{error}</p> : null}
      {emptyState ? (
        <div>
          <p>No WhatsApp threads/messages yet.</p>
          <p><Link href="/dashboard/settings/providers/whatsapp">Configure provider</Link> and send a test message to start thread history.</p>
        </div>
      ) : null}

      <h2>Threads</h2>
      <table>
        <thead>
          <tr><th>Contact</th><th>Customer</th><th>Provider</th><th>Status</th><th>Last message</th><th>Updated</th><th /></tr>
        </thead>
        <tbody>
          {threads.map((t) => (
            <tr key={t.id}>
              <td>{t.contactName || t.contactNumberMasked || "-"}</td>
              <td>{t.customerId ? <Link href={`/dashboard/customers/${t.customerId}`}>{t.customerName || "Open"}</Link> : "-"}</td>
              <td>{t.providerType}</td>
              <td><span className={`status-chip ${badgeClass(t.lastStatus)}`} style={{ borderRadius: 2 }}>{t.lastStatus || "UNKNOWN"}</span></td>
              <td>{t.lastMessagePreview || "-"}</td>
              <td>{t.lastMessageAt ? new Date(t.lastMessageAt).toLocaleString() : "-"}</td>
              <td><Link href={`/dashboard/whatsapp/${t.id}`}>Open</Link></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Recent Messages</h2>
      <table>
        <thead>
          <tr><th>Direction</th><th>Status</th><th>From</th><th>To</th><th>Preview</th><th>Time</th></tr>
        </thead>
        <tbody>
          {recent.map((m) => (
            <tr key={m.id}>
              <td>{m.direction}</td>
              <td><span className={`status-chip ${badgeClass(m.status)}`} style={{ borderRadius: 2 }}>{m.status}</span></td>
              <td>{m.fromNumber}</td>
              <td>{m.toNumber}</td>
              <td>{m.bodyPreview || ""}</td>
              <td>{m.createdAt ? new Date(m.createdAt).toLocaleString() : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {Array.isArray(status?.recentFailures) && status.recentFailures.length > 0 ? (
        <>
          <h2>Recent webhook/status failures</h2>
          <ul>
            {status.recentFailures.map((f: any) => (
              <li key={f.id}>
                {f.status} {f.errorCode ? `(${f.errorCode})` : ""} - {f.createdAt ? new Date(f.createdAt).toLocaleString() : ""}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
