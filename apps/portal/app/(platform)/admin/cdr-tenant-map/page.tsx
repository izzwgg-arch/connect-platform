"use client";

import { useState } from "react";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost, apiDelete } from "../../../../services/apiClient";

type CdrTenantRule = {
  id: string;
  matchType: "did" | "from_did" | "extension_prefix";
  matchValue: string;
  tenantSlug: string;
  description?: string;
};

type VpbxTenant = { id: number; name: string; description?: string };

const MATCH_TYPE_LABELS: Record<string, string> = {
  did:               "Inbound DID (toNumber exact)",
  from_did:          "Outbound from DID (fromNumber exact)",
  extension_prefix:  "Extension prefix (fromNumber starts with)",
};

async function loadRules() {
  const res = await apiGet<{ rules: CdrTenantRule[] }>("/admin/cdr/tenant-rules");
  return res.rules;
}

async function loadTenants() {
  const res = await apiGet<{ tenants: VpbxTenant[] }>("/admin/pbx/tenants");
  return (res.tenants || []).filter((t) => t.name && t.name !== "vitalpbx");
}

export default function CdrTenantMapPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const rules = useAsyncResource(loadRules, [refreshKey]);
  const tenants = useAsyncResource(loadTenants, []);

  const [matchType, setMatchType] = useState<"did" | "from_did" | "extension_prefix">("did");
  const [matchValue, setMatchValue] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function refresh() { setRefreshKey((k) => k + 1); }

  async function addRule(e: React.FormEvent) {
    e.preventDefault();
    if (!matchValue.trim() || !tenantSlug) return;
    setSaving(true);
    setErr(null);
    try {
      await apiPost("/admin/cdr/tenant-rules", {
        matchType,
        matchValue: matchValue.trim(),
        tenantSlug,
        description: description.trim() || undefined,
      });
      setMatchValue("");
      setDescription("");
      refresh();
    } catch (e: any) {
      setErr(e?.message || "Failed to save rule");
    } finally {
      setSaving(false);
    }
  }

  async function deleteRule(id: string) {
    if (!confirm("Delete this rule?")) return;
    await apiDelete(`/admin/cdr/tenant-rules/${id}`).catch(() => null);
    refresh();
  }

  async function runBackfill() {
    setBackfilling(true);
    setBackfillResult(null);
    try {
      const res = await apiPost<{ updated: number; message?: string }>("/admin/cdr/tenant-rules/backfill");
      setBackfillResult(`Backfill complete — ${res.updated} CDR row(s) updated.`);
      refresh();
    } catch (e: any) {
      setBackfillResult("Backfill failed: " + (e?.message || "unknown error"));
    } finally {
      setBackfilling(false);
    }
  }

  return (
    <PermissionGate permission="can_view_admin" fallback={<div className="state-box">No access.</div>}>
      <div className="stack">
        <PageHeader
          title="CDR Tenant Mapping"
          subtitle="Map phone numbers and extension patterns to VitalPBX tenants so per-tenant call KPIs are correctly scoped."
        />

        {/* Existing rules */}
        <section className="panel">
          <h3>Current Rules</h3>
          {rules.status === "loading" && <div className="state-box">Loading…</div>}
          {rules.status === "error" && <div className="state-box error">{rules.error}</div>}
          {rules.status === "success" && rules.data.length === 0 && (
            <div className="state-box">No rules configured yet. Add rules below to enable per-tenant KPIs.</div>
          )}
          {rules.status === "success" && rules.data.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Match Type</th>
                  <th>Match Value</th>
                  <th>Tenant Slug</th>
                  <th>Description</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rules.data.map((r) => (
                  <tr key={r.id}>
                    <td><span className="chip">{MATCH_TYPE_LABELS[r.matchType] ?? r.matchType}</span></td>
                    <td><code>{r.matchValue}</code></td>
                    <td><span className="chip info">vpbx:{r.tenantSlug}</span></td>
                    <td>{r.description || "—"}</td>
                    <td>
                      <button className="btn danger sm" onClick={() => deleteRule(r.id)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Backfill */}
        <section className="panel">
          <h3>Backfill Existing CDR Rows</h3>
          <p className="text-muted">After adding rules, click below to retroactively assign tenants to CDR records that currently have no tenant set.</p>
          <div className="row-actions">
            <button className="btn primary" onClick={runBackfill} disabled={backfilling}>
              {backfilling ? "Backfilling…" : "Run Backfill Now"}
            </button>
          </div>
          {backfillResult && <div className="state-box success" style={{ marginTop: "0.5rem" }}>{backfillResult}</div>}
        </section>

        {/* Add rule form */}
        <section className="panel">
          <h3>Add Rule</h3>
          <p className="text-muted">
            <strong>Inbound DID</strong>: when a call arrives at this phone number (e.g. <code>8452449666</code>), assign it to the tenant.<br />
            <strong>Extension prefix</strong>: when an extension starting with this prefix makes an outgoing call (e.g. <code>10</code> for extensions 100–109), assign it to the tenant.
          </p>
          <form className="stack" onSubmit={addRule} style={{ maxWidth: 520 }}>
            <label>
              Match Type
              <select value={matchType} onChange={(e) => setMatchType(e.target.value as any)} className="input">
                {Object.entries(MATCH_TYPE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </label>
            <label>
              Match Value
              <input
                className="input"
                value={matchValue}
                onChange={(e) => setMatchValue(e.target.value)}
                placeholder={matchType === "extension_prefix" ? "e.g. 10 (matches 100–109)" : "e.g. 8452449666"}
                required
              />
            </label>
            <label>
              Tenant
              <select
                className="input"
                value={tenantSlug}
                onChange={(e) => setTenantSlug(e.target.value)}
                required
              >
                <option value="">— select tenant —</option>
                {tenants.status === "success" && tenants.data.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.description || t.name} ({t.name})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Description (optional)
              <input
                className="input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Main inbound line for A Plus Center"
              />
            </label>
            {err && <div className="state-box error">{err}</div>}
            <div className="row-actions">
              <button className="btn primary" type="submit" disabled={saving}>
                {saving ? "Saving…" : "Add Rule"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </PermissionGate>
  );
}
