"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, getPortalApiBaseUrl } from "../../../../../services/apiClient";

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
  const [csvRegenerating, setCsvRegenerating] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  async function reload() {
    try {
      const r = await apiGet<any>(`/admin/onboarding/submissions/${encodeURIComponent(id)}`);
      setRow(r);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function retrySetup() {
    setRetryError(null);
    setRetryNotice(null);
    setRetrying(true);
    try {
      await apiPost<any>(`/admin/onboarding/submissions/${encodeURIComponent(id)}/retry-setup`);
      setRetryNotice("Retry started — the setup pipeline is running again. Check the events below for progress.");
      await reload();
    } catch (e: any) {
      setRetryError(e?.message || "Retry failed");
    } finally {
      setRetrying(false);
    }
  }

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
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <b>CSV:</b>
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
          <button
            disabled={csvRegenerating}
            onClick={async () => {
              setCsvError(null);
              setCsvRegenerating(true);
              try { await downloadCsv(apiBase, row.id); }
              catch (e: any) { setCsvError(e?.message || "Regenerate failed"); }
              finally { setCsvRegenerating(false); }
            }}
          >
            {csvRegenerating ? "Regenerating…" : "Regenerate CSV"}
          </button>
          {csvError && <span style={{ color: "red" }}>{csvError}</span>}
        </div>
      </div>

      <h2>Phone System Setup</h2>
      <div className="card">
        <div><b>Paid:</b> {row.paidAt ? `${row.paidAt}${row.paidAmountCents ? ` ($${(row.paidAmountCents / 100).toFixed(2)})` : ""}` : "not paid"}</div>
        <div><b>Number:</b> {row.provisionedDid || "—"} {row.numberStatus ? `(${row.numberStatus})` : ""}</div>
        <div><b>Build status:</b> {row.pbxSetupStatus || "not started"}</div>
        {row.setupError ? <div style={{ color: "red" }}><b>Setup error:</b> {row.setupError}</div> : null}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <button disabled={retrying} onClick={retrySetup}>
            {retrying ? "Retrying…" : "Retry setup"}
          </button>
          {retryNotice && <span style={{ color: "green" }}>{retryNotice}</span>}
          {retryError && <span style={{ color: "red" }}>{retryError}</span>}
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
