"use client";

import { useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function VoiceCallsPage() {
  const [rows, setRows] = useState<any[]>([]);

  async function load() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/voice/calls`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    setRows(Array.isArray(json) ? json : []);
  }

  useEffect(() => {
    load().catch(() => undefined);
  }, []);

  return (
    <div className="card">
      <h1>Voice Call Logs</h1>
      <table>
        <thead><tr><th>Started</th><th>Direction</th><th>From</th><th>To</th><th>Duration</th><th>Disposition</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.startedAt).toLocaleString()}</td>
              <td>{r.direction}</td>
              <td>{r.fromNumber}</td>
              <td>{r.toNumber}</td>
              <td>{r.durationSec}s</td>
              <td>{r.disposition || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
