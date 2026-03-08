"use client";

import { useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function VoiceCallRecordingsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/voice/pbx/call-recordings?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({ rows: [] }));
    if (!res.ok) setError(json?.error || "Failed to load recordings.");
    else setError("");
    setRows(Array.isArray(json?.rows) ? json.rows : []);
  }

  useEffect(() => {
    load().catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="card">
      <h1>Call Recordings</h1>
      <div className="row">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by number or metadata" />
        <button onClick={load}>Search</button>
      </div>
      {error ? <p>{error}</p> : null}
      {rows.length === 0 ? <p>No call recordings found.</p> : null}
      {rows.map((r, i) => (
        <div key={String(r?.id || i)} className="card">
          <p><strong>{String(r?.from || r?.caller || "Unknown caller")}</strong> -> {String(r?.to || r?.callee || "-")}</p>
          <audio controls src={String(r?.streamUrl || r?.url || "")} />
          <p><a href={String(r?.downloadUrl || r?.url || "#")}>Download</a></p>
        </div>
      ))}
    </div>
  );
}
