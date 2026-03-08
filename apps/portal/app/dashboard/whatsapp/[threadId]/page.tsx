"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

function badgeClass(status: string) {
  const s = String(status || "").toUpperCase();
  if (s === "FAILED") return "failed";
  if (s === "DELIVERED" || s === "SENT" || s === "INBOUND") return "live";
  return "pending";
}

export default function WhatsAppThreadPage() {
  const params = useParams<{ threadId: string }>();
  const threadId = params?.threadId;
  const [thread, setThread] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");

  async function load() {
    if (!threadId) return;
    const token = localStorage.getItem("token") || "";
    const [threadRes, statusRes] = await Promise.all([
      fetch(`${apiBase}/whatsapp/threads/${threadId}`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/whatsapp/status`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    const threadJson = await threadRes.json().catch(() => null);
    const statusJson = await statusRes.json().catch(() => null);
    setThread(threadJson);
    setStatus(statusJson);
    if (!threadRes.ok) setError("Thread not found or unavailable.");
  }

  useEffect(() => {
    load().catch(() => setError("Failed to load thread."));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  async function sendReply() {
    if (!threadId) return;
    if (!message.trim()) {
      setError("Message is required.");
      return;
    }
    setLoading(true);
    setError("");
    setToast("");
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/whatsapp/threads/${threadId}/send`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: message.trim() })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(String(json?.error || "Send failed"));
      setLoading(false);
      return;
    }
    setMessage("");
    setToast(json?.simulated ? "Reply queued (simulated)." : "Reply queued.");
    await load();
    setLoading(false);
  }

  const providerEnabled = !!status?.enabled;

  return (
    <div className="card">
      <p><Link href="/dashboard/whatsapp">Back to WhatsApp Operations</Link></p>
      <h1>WhatsApp Thread</h1>
      <p>
        Contact: <strong>{thread?.contactName || thread?.contactNumberMasked || "-"}</strong> | Provider: <strong>{thread?.providerType || status?.activeProvider || "-"}</strong>
      </p>
      <p>
        Current status: <span className={`status-chip ${badgeClass(thread?.lastStatus || "")}`} style={{ borderRadius: 2 }}>{thread?.lastStatus || "UNKNOWN"}</span>
      </p>
      {!providerEnabled ? (
        <p className="status-chip pending" style={{ borderRadius: 2 }}>
          Provider disabled. Configure or enable provider at <Link href="/dashboard/settings/providers/whatsapp">WhatsApp Provider Settings</Link>.
        </p>
      ) : null}

      {error ? <p className="status-chip failed" style={{ borderRadius: 2 }}>{error}</p> : null}
      {toast ? <p className="status-chip live" style={{ borderRadius: 2 }}>{toast}</p> : null}

      <h2>Timeline</h2>
      {!Array.isArray(thread?.messages) || thread.messages.length === 0 ? (
        <p>No messages in this thread yet.</p>
      ) : (
        <ul>
          {thread.messages.map((m: any) => (
            <li key={m.id} style={{ marginBottom: 10 }}>
              <div>
                <strong>{m.direction}</strong> - <span className={`status-chip ${badgeClass(m.status)}`} style={{ borderRadius: 2 }}>{m.status}</span>
              </div>
              <div>{m.body}</div>
              <small>{m.createdAt ? new Date(m.createdAt).toLocaleString() : "-"}</small>
              {m.errorCode ? <small> | Error: {m.errorCode}</small> : null}
            </li>
          ))}
        </ul>
      )}

      <h2>Reply</h2>
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Type reply message..." />
      <button onClick={sendReply} disabled={loading || !providerEnabled || !thread}>
        {loading ? "Sending..." : "Send Reply"}
      </button>
    </div>
  );
}
