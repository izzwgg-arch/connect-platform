"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, getPortalApiBaseUrl } from "../../../../services/apiClient";

export default function AdminOnboardingListPage() {
  const [companyName, setCompanyName] = useState("");
  const [mainEmail, setMainEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<any[]>([]);

  async function refresh() {
    try {
      const res = await apiGet<{ submissions: any[] }>("/admin/onboarding/submissions");
      setRows(res.submissions || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function createLink() {
    setCreating(true);
    setError(null);
    try {
      await apiPost("/admin/onboarding/public-links", {
        companyName: companyName || undefined,
        mainEmail: mainEmail || undefined,
      });
      setCompanyName("");
      setMainEmail("");
      await refresh();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setCreating(false);
    }
  }

  function copy(text: string) {
    try { navigator.clipboard?.writeText(text); } catch {}
  }

  const apiBase = useMemo(() => getPortalApiBaseUrl(), []);

  return (
    <div className="stack">
      <h1>Onboarding Links</h1>
      <div className="row">
        <input placeholder="Company (optional)" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
        <input placeholder="Main Email (optional)" value={mainEmail} onChange={(e) => setMainEmail(e.target.value)} />
        <button disabled={creating} onClick={createLink}>{creating ? "Creating…" : "Create Link"}</button>
      </div>
      {error ? <div className="state-box error">{error}</div> : null}

      <table className="grid-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>Contact</th>
            <th>Main Email</th>
            <th>Status</th>
            <th>Exts</th>
            <th>Public Link</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {(rows || []).map((r) => {
            const purl = r.publicUrl ? (new URL(r.publicUrl, window.location.origin)).toString() : null;
            return (
              <tr key={r.id}>
                <td>{r.companyName || ""}</td>
                <td>{r.contactName || ""}</td>
                <td>{r.mainEmail || ""}</td>
                <td>{r.status}</td>
                <td>{r.requestedExtensionCount || 0}</td>
                <td>{purl ? <a href={purl} target="_blank" rel="noreferrer">{r.publicUrl}</a> : "—"}</td>
                <td>
                  {purl ? <button onClick={() => copy(purl)}>Copy</button> : null}
                  <a href={`/admin/onboarding/${encodeURIComponent(r.id)}`} style={{ marginLeft: 8 }}>Open</a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="muted">API: {apiBase}</div>
    </div>
  );
}
