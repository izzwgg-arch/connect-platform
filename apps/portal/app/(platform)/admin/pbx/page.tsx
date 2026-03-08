"use client";

import { useMemo, useState } from "react";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPatch, apiPost } from "../../../../services/apiClient";

type PbxInstance = {
  id: string;
  name: string;
  baseUrl: string;
  isEnabled: boolean;
  createdAt?: string;
  updatedAt?: string;
};

type PbxTestResult = {
  ok?: boolean;
  provider?: string;
  tenantCount?: number;
  capabilities?: unknown;
};

export default function AdminPbxPage() {
  const [form, setForm] = useState({ name: "", baseUrl: "", token: "", secret: "" });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [tokenInput, setTokenInput] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const instances = useAsyncResource(() => apiGet<PbxInstance[]>("/admin/pbx/instances"), [reloadKey]);
  const rows = useMemo(() => {
    if (instances.status !== "success") return [];
    return instances.data
      .filter((row) => row.isEnabled)
      .sort((a, b) => {
        const ad = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const bd = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return bd - ad;
      });
  }, [instances]);
  const isAuthError =
    instances.status === "error" &&
    (instances.error.includes("401") || instances.error.toLowerCase().includes("unauthorized"));

  function saveTokenAndRetry() {
    const raw = tokenInput.trim();
    if (!raw) {
      setError("Paste a valid JWT token first.");
      return;
    }
    localStorage.setItem("token", raw);
    setMessage("Session token updated. Reloading PBX instances...");
    setError("");
    setReloadKey((k) => k + 1);
  }

  async function createInstance() {
    setError("");
    setMessage("");
    if (!form.name || !form.baseUrl || !form.token) {
      setError("Name, Base URL, and App/API token are required.");
      return;
    }
    setSaving(true);
    try {
      await apiPost("/admin/pbx/instances", {
        name: form.name,
        baseUrl: form.baseUrl,
        token: form.token,
        secret: form.secret || undefined,
        isEnabled: true
      });
      setMessage("VitalPBX instance saved.");
      setForm({ name: "", baseUrl: "", token: "", secret: "" });
      setReloadKey((k) => k + 1);
    } catch (e: any) {
      setError(e?.message || "Failed to save VitalPBX instance.");
    } finally {
      setSaving(false);
    }
  }

  async function testInstance(id: string) {
    setError("");
    setMessage("");
    try {
      const res = await apiPost<PbxTestResult>(`/admin/pbx/instances/${id}/test`);
      if (res?.ok) {
        const tenantInfo = typeof res.tenantCount === "number" ? ` (${res.tenantCount} tenants detected)` : "";
        setMessage(`Connection test passed${tenantInfo}.`);
      } else {
        setError("Connection test returned an unexpected response.");
      }
    } catch (e: any) {
      setError(e?.message || "Connection test failed.");
    }
  }

  async function toggleEnabled(row: PbxInstance) {
    setError("");
    setMessage("");
    try {
      await apiPatch(`/admin/pbx/instances/${row.id}`, { isEnabled: !row.isEnabled });
      setMessage(`Instance ${!row.isEnabled ? "enabled" : "disabled"}.`);
      setReloadKey((k) => k + 1);
    } catch (e: any) {
      setError(e?.message || "Failed to update instance.");
    }
  }

  return (
    <div className="stack">
      <PageHeader title="VitalPBX Connection" subtitle="Manage PBX endpoints, credentials, and health checks." />

      <section className="panel stack">
        <h3>Add / Update Connection</h3>
        <div className="chip info">Secrets are encrypted after save and are never returned in plaintext.</div>
        <div className="grid two">
          <label className="stack">
            <span className="muted">Name</span>
            <input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Primary VitalPBX" />
          </label>
          <label className="stack">
            <span className="muted">Base URL</span>
            <input className="input" value={form.baseUrl} onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))} placeholder="https://pbx.example.com" />
          </label>
          <label className="stack">
            <span className="muted">App/API Token</span>
            <input className="input" value={form.token} onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))} placeholder="app-key value" />
          </label>
          <label className="stack">
            <span className="muted">Secret (optional)</span>
            <input className="input" value={form.secret} onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))} placeholder="optional secret" />
          </label>
        </div>
        <div className="row-actions">
          <button className="btn" onClick={createInstance} disabled={saving}>{saving ? "Saving..." : "Save Connection"}</button>
          <button className="btn ghost" onClick={() => setReloadKey((k) => k + 1)}>Refresh</button>
        </div>
        {message ? <div className="chip success">{message}</div> : null}
        {error ? <div className="chip danger">{error}</div> : null}
      </section>

      <section className="panel stack">
        <h3>Configured Instances</h3>
        {isAuthError ? (
          <div className="stack">
            <div className="chip warning">Your session token is missing or expired. Please sign in again or paste a fresh JWT token.</div>
            <label className="stack">
              <span className="muted">JWT Token</span>
              <input
                className="input"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="eyJhbGciOi..."
              />
            </label>
            <div className="row-actions">
              <button className="btn" onClick={saveTokenAndRetry}>Save Token & Retry</button>
            </div>
          </div>
        ) : null}
        {instances.status === "loading" ? <LoadingSkeleton rows={4} /> : null}
        {instances.status === "error" ? <ErrorState message={instances.error} /> : null}
        {instances.status === "success" ? (
          rows.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Base URL</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td>{row.baseUrl}</td>
                      <td><span className={`chip ${row.isEnabled ? "success" : "warning"}`}>{row.isEnabled ? "Enabled" : "Disabled"}</span></td>
                      <td>
                        <div className="row-actions">
                          <button className="btn ghost" onClick={() => testInstance(row.id)}>Test</button>
                          <button className="btn ghost" onClick={() => toggleEnabled(row)}>{row.isEnabled ? "Disable" : "Enable"}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="state-box">No VitalPBX instance configured yet.</div>
          )
        ) : null}
      </section>
    </div>
  );
}
