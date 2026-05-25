"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, getPortalApiBaseUrl } from "../../../../../services/apiClient";

export default function AdminOnboardingDetailPage({ params }: { params: { id: string } }) {
  const id = params.id;
  const [row, setRow] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function run() {
      try {
        const r = await apiGet<any>(`/admin/onboarding/submissions/${encodeURIComponent(id)}`);
        setRow(r);
      } catch (e: any) {
        setError(e?.message || String(e));
      }
    }
    run();
  }, [id]);

  function copy(text: string) { try { navigator.clipboard?.writeText(text); } catch {} }

  const apiBase = useMemo(() => getPortalApiBaseUrl(), []);

  if (error) return <div className="state-box error">{error}</div>;
  if (!row) return <div className="state-box">Loading…</div>;

  const publicUrl = row.publicUrl ? (new URL(row.publicUrl, window.location.origin)).toString() : null;

  return (
    <div className="stack">
      <h1>Onboarding Detail</h1>

      <div className="card">
        <div><b>Company:</b> {row.companyName || ""}</div>
        <div><b>Contact:</b> {(row.contactFirstName || "") + " " + (row.contactLastName || "")}</div>
        <div><b>Main Email:</b> {row.mainEmail || ""}</div>
        <div><b>Status:</b> {row.status}</div>
        <div><b>Submitted:</b> {row.submittedAt || "—"}</div>
        <div><b>Public Link:</b> {publicUrl ? <a href={publicUrl} target="_blank" rel="noreferrer">{row.publicUrl}</a> : "—"} {publicUrl ? <button onClick={() => copy(publicUrl)} style={{ marginLeft: 8 }}>Copy</button> : null}</div>
        <div><b>CSV:</b> <a href={`${apiBase}/admin/onboarding/submissions/${encodeURIComponent(row.id)}/vitalpbx.csv`} target="_blank" rel="noreferrer">Download VitalPBX CSV</a></div>
      </div>

      <h2>Requested Extensions</h2>
      <ul>
        {(row.requestedExtensions || []).map((e: any) => (
          <li key={e.id}>{e.extNumber} — {e.displayName || "(no name)"} — {e.email || ""}</li>
        ))}
      </ul>

      <h2>Files</h2>
      <ul>
        {(row.uploadedFiles || []).length === 0 ? <li>None</li> : (row.uploadedFiles || []).map((f: any) => (
          <li key={f.id}>{f.filename} ({f.sizeBytes} B)</li>
        ))}
      </ul>

      <h2>Events</h2>
      <ul>
        {(row.events || []).map((ev: any) => (
          <li key={ev.id}>{ev.createdAt} — {ev.type} — {ev.message || ""}</li>
        ))}
      </ul>
    </div>
  );
}
