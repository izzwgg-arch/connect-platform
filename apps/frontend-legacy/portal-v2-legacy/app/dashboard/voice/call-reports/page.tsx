"use client";

import { useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function VoiceCallReportsPage() {
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState("");

  async function load() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/voice/pbx/call-reports`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) setError(json?.error || "Failed to load report.");
    else setError("");
    setReport(json?.report || null);
  }

  useEffect(() => {
    load().catch(() => undefined);
  }, []);

  return (
    <div className="card">
      <h1>Call Reports</h1>
      {error ? <p>{error}</p> : null}
      {!report ? <p>No report data available.</p> : (
        <table>
          <tbody>
            <tr><th>Answered</th><td>{Number(report.answered || 0)}</td></tr>
            <tr><th>Missed</th><td>{Number(report.missed || 0)}</td></tr>
            <tr><th>Inbound</th><td>{Number(report.inbound || 0)}</td></tr>
            <tr><th>Outbound</th><td>{Number(report.outbound || 0)}</td></tr>
            <tr><th>Avg Duration (sec)</th><td>{Number(report.avgDurationSec || 0)}</td></tr>
          </tbody>
        </table>
      )}
      {report?.byExtension ? <pre>{JSON.stringify(report.byExtension, null, 2)}</pre> : null}
      {report?.byQueue ? <pre>{JSON.stringify(report.byQueue, null, 2)}</pre> : null}
    </div>
  );
}
