"use client";

import { useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function VoiceRecordingsPage() {
  const [rows, setRows] = useState<any[]>([]);

  useEffect(() => {
    const token = localStorage.getItem("token") || "";
    fetch(`${apiBase}/voice/pbx/resources/ivr`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((json) => setRows(Array.isArray(json?.rows) ? json.rows : []))
      .catch(() => setRows([]));
  }, []);

  return (
    <div className="card">
      <h1>IVR Recordings</h1>
      <p>Review IVR resources and recording-linked IVR definitions.</p>
      {rows.length === 0 ? <p>No recording-linked IVR resources found.</p> : rows.map((r, i) => <pre key={String(r?.id || i)}>{JSON.stringify(r, null, 2)}</pre>)}
    </div>
  );
}
