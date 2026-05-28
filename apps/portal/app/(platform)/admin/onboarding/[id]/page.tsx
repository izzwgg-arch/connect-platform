"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, getPortalApiBaseUrl } from "../../../../../services/apiClient";

async function downloadCsv(apiBase: string, id: string) {
  const token =
    localStorage.getItem("token") ||
    localStorage.getItem("cc-token") ||
    localStorage.getItem("authToken") ||
    "";
  const res = await fetch(
    `${apiBase}/admin/onboarding/submissions/${encodeURIComponent(id)}/vitalpbx.csv`,
    { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) }, cache: "no-store" },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") || "";
  const match = disposition.match(/filename[^;=\n]*=\s*(?:UTF-8'')?["']?([^"'\n;]+)["']?/i);
  const filename = match?.[1]?.trim() || "vitalpbx_extensions.csv";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function AdminOnboardingDetailPage({ params }: { params: { id: string } }) {
  const id = params.id;
  const [row, setRow] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [csvDownloading, setCsvDownloading] = useState(false);

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
        <div><b>CSV:</b>{" "}
          <button
            disabled={csvDownloading}
            onClick={async () => {
              setCsvError(null);
              setCsvDownloading(true);
              try { await downloadCsv(apiBase, row.id); }
              catch (e: any) { setCsvError(e?.message || "Download failed"); }
              finally { setCsvDownloading(false); }
            }}
          >
            {csvDownloading ? "Downloading…" : "Download VitalPBX CSV"}
          </button>
          {csvError && <span style={{ color: "red", marginLeft: 8 }}>{csvError}</span>}
        </div>
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
