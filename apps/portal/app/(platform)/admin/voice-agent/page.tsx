"use client";

// Conversational order-taking voice agent — per-tenant settings (2026-08-26).
// The AI that answers a store's phone, takes an order by talking, and drops a
// draft into the Orders Desk for a rep to approve.
//
// ⛔ Access: the PermissionGate here is presentation only — the real fences
// are the SUPER_ADMIN force line in navConfig.isNavItemVisibleForUser and the
// api routes' requireSuperAdmin (prefix /admin/voice-agent also carries
// can_manage_global_settings in PORTAL_API_PERMISSION_RULES).
// ⛔ The OpenAI KEY is entered on /admin/integrations (one writer, one
// ProviderCredential row). This page only shows whether it's configured and
// sends people there if it is not.
// ⛔ No native <select> — house rule; the voice picker is a ConnectSelect.

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPut, apiPost } from "../../../../services/apiClient";
import { PermissionGate } from "../../../../components/PermissionGate";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import "./voiceAgent.css";

type TenantOption = { id: string; name: string };

type Settings = {
  enabled: boolean;
  model: string;
  voice: string;
  greeting: string;
  instructionsExtra: string;
  maxCallSeconds: number;
  maxConcurrentCalls: number;
  monthlyMinuteCap: number;
  storeName?: string;
} | null;

type CallRow = {
  id: string;
  sessionUuid: string;
  callerNumber: string | null;
  startedAt: string;
  endedAt: string | null;
  seconds: number;
  endReason: string | null;
  draftId: string | null;
};

type LoadResp = {
  settings: Settings;
  openAiKeyConfigured: boolean;
  catalogCount: number;
  calls: CallRow[];
};

const VOICES = [
  { value: "cedar", label: "Cedar (male, recommended)" },
  { value: "marin", label: "Marin (female, recommended)" },
  { value: "ash", label: "Ash (male)" },
  { value: "ballad", label: "Ballad (male)" },
  { value: "verse", label: "Verse (male)" },
  { value: "alloy", label: "Alloy (neutral)" },
  { value: "coral", label: "Coral (female)" },
  { value: "sage", label: "Sage (female)" },
  { value: "shimmer", label: "Shimmer (female)" },
  { value: "echo", label: "Echo (male)" },
];

function errText(e: any, fallback: string): string {
  return e?.body?.detail || e?.body?.message || e?.body?.error || e?.message || fallback;
}

function fmtWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

const DEFAULTS = {
  enabled: false,
  model: "gpt-realtime",
  voice: "cedar",
  greeting: "",
  instructionsExtra: "",
  maxCallSeconds: 600,
  maxConcurrentCalls: 4,
  monthlyMinuteCap: 3000,
  storeName: "",
};

export default function VoiceAgentAdminPage() {
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [tenantId, setTenantId] = useState<string>("");
  const [data, setData] = useState<LoadResp | null>(null);
  const [form, setForm] = useState({ ...DEFAULTS });
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ options: TenantOption[] }>("/admin/tenant-options")
      .then((r) => setTenants((r.options || []).map((t) => ({ id: t.id, name: t.name }))))
      .catch((e) => setErr(errText(e, "Could not load tenants")));
  }, []);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    setErr(null);
    setNotice(null);
    try {
      const resp = await apiGet<LoadResp>(`/admin/voice-agent/${encodeURIComponent(id)}`);
      setData(resp);
      setForm({ ...DEFAULTS, ...(resp.settings || {}) });
      setDirty(false);
    } catch (e) {
      setErr(errText(e, "Could not load settings"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tenantId) void load(tenantId);
  }, [tenantId, load]);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
    setNotice(null);
  };

  const save = async () => {
    if (!tenantId) return;
    setSaving(true);
    setErr(null);
    setNotice(null);
    try {
      await apiPut(`/admin/voice-agent/${encodeURIComponent(tenantId)}`, {
        enabled: form.enabled,
        model: form.model,
        voice: form.voice,
        greeting: form.greeting,
        instructionsExtra: form.instructionsExtra,
        maxCallSeconds: Number(form.maxCallSeconds),
        maxConcurrentCalls: Number(form.maxConcurrentCalls),
        monthlyMinuteCap: Number(form.monthlyMinuteCap),
        storeName: form.storeName,
      });
      setNotice("Saved.");
      setDirty(false);
      await load(tenantId);
    } catch (e) {
      setErr(errText(e, "Save failed"));
    } finally {
      setSaving(false);
    }
  };

  const tenantOptions = useMemo(() => tenants.map((t) => ({ value: t.id, label: t.name })), [tenants]);
  const canEnable = Boolean(data?.openAiKeyConfigured) && (data?.catalogCount ?? 0) > 0;

  return (
    <PermissionGate permission="can_manage_global_settings">
      <div className="va-root">
        <header className="va-head">
          <div>
            <h1>Voice Agent</h1>
            <p className="va-sub">
              The AI that answers a store&rsquo;s phone, takes an order by talking, and drops a draft into the Orders Desk for a rep to approve.
            </p>
          </div>
        </header>

        <div className="va-picker">
          <label className="va-lbl">Company</label>
          <ConnectSelect
            value={tenantId}
            onChange={setTenantId}
            options={tenantOptions}
            placeholder="Choose a company…"
            searchable
            ariaLabel="Company"
          />
        </div>

        {err && <div className="va-alert va-alert-err">{err}</div>}
        {notice && <div className="va-alert va-alert-ok">{notice}</div>}

        {!tenantId && <div className="va-empty">Pick a company to configure its voice agent.</div>}

        {tenantId && loading && <div className="va-empty">Loading…</div>}

        {tenantId && !loading && data && (
          <>
            <section className="va-card">
              <div className="va-card-h">Readiness</div>
              <div className="va-card-b va-checks">
                <div className={`va-check ${data.openAiKeyConfigured ? "ok" : "no"}`}>
                  <span className="va-dot" />
                  OpenAI key {data.openAiKeyConfigured ? "configured" : "missing"}
                  {!data.openAiKeyConfigured && (
                    <a className="va-link" href="/admin/integrations">Add it on Integrations →</a>
                  )}
                </div>
                <div className={`va-check ${data.catalogCount > 0 ? "ok" : "no"}`}>
                  <span className="va-dot" />
                  Product catalog: {data.catalogCount.toLocaleString()} items
                  {data.catalogCount === 0 && <span className="va-hint">Sync or import a catalog before enabling.</span>}
                </div>
                <div className={`va-check ${form.enabled ? "ok" : "idle"}`}>
                  <span className="va-dot" />
                  {form.enabled ? "Enabled — callers reach the AI" : "Disabled — callers reach a person"}
                </div>
              </div>
            </section>

            <section className="va-card">
              <div className="va-card-h">Settings</div>
              <div className="va-card-b">
                <label className="va-row va-toggle">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    disabled={!canEnable && !form.enabled}
                    onChange={(e) => set("enabled", e.target.checked)}
                  />
                  <span>
                    Enable the voice agent for this company
                    {!canEnable && !form.enabled && (
                      <span className="va-hint"> — needs an OpenAI key and a catalog first</span>
                    )}
                  </span>
                </label>

                <div className="va-grid">
                  <div className="va-field">
                    <label className="va-lbl">Store name (how the AI refers to the store)</label>
                    <input className="va-input" value={form.storeName} onChange={(e) => set("storeName", e.target.value)} placeholder="e.g. Gesheft Kosher" />
                  </div>
                  <div className="va-field">
                    <label className="va-lbl">Voice</label>
                    <ConnectSelect value={form.voice} onChange={(v) => set("voice", v)} options={VOICES} ariaLabel="Voice" />
                  </div>
                </div>

                <div className="va-field">
                  <label className="va-lbl">Greeting (optional — leave blank for a natural greeting)</label>
                  <input className="va-input" value={form.greeting} onChange={(e) => set("greeting", e.target.value)} placeholder="Thanks for calling — what can I get started for you?" />
                </div>

                <div className="va-field">
                  <label className="va-lbl">Extra instructions (store-specific notes for the AI)</label>
                  <textarea className="va-textarea" rows={3} value={form.instructionsExtra} onChange={(e) => set("instructionsExtra", e.target.value)} placeholder="e.g. We close Fridays at 2pm. Substitute brands freely unless the caller says otherwise." />
                </div>

                <div className="va-grid va-grid-3">
                  <div className="va-field">
                    <label className="va-lbl">Max call length (seconds)</label>
                    <input className="va-input" type="number" min={60} max={3600} value={form.maxCallSeconds} onChange={(e) => set("maxCallSeconds", Number(e.target.value))} />
                  </div>
                  <div className="va-field">
                    <label className="va-lbl">Max calls at once</label>
                    <input className="va-input" type="number" min={1} max={32} value={form.maxConcurrentCalls} onChange={(e) => set("maxConcurrentCalls", Number(e.target.value))} />
                  </div>
                  <div className="va-field">
                    <label className="va-lbl">Monthly minutes cap (0 = no cap)</label>
                    <input className="va-input" type="number" min={0} value={form.monthlyMinuteCap} onChange={(e) => set("monthlyMinuteCap", Number(e.target.value))} />
                  </div>
                </div>

                <div className="va-actions">
                  <button className="va-btn va-btn-primary" onClick={save} disabled={saving || !dirty}>
                    {saving ? "Saving…" : "Save settings"}
                  </button>
                  {dirty && <span className="va-hint">Unsaved changes</span>}
                </div>
              </div>
            </section>

            <section className="va-card">
              <div className="va-card-h">Recent calls</div>
              <div className="va-card-b">
                {data.calls.length === 0 ? (
                  <div className="va-empty">No voice-agent calls yet.</div>
                ) : (
                  <table className="va-table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Caller</th>
                        <th>Length</th>
                        <th>Outcome</th>
                        <th>Order</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.calls.map((c) => (
                        <tr key={c.id}>
                          <td>{fmtWhen(c.startedAt)}</td>
                          <td>{c.callerNumber || "—"}</td>
                          <td>{c.seconds ? `${Math.floor(c.seconds / 60)}m ${c.seconds % 60}s` : "—"}</td>
                          <td>
                            <span className={`va-pill va-pill-${(c.endReason || "").replace(/[^a-z]/gi, "")}`}>{c.endReason || (c.endedAt ? "ended" : "live")}</span>
                          </td>
                          <td>{c.draftId ? "✓ draft created" : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </PermissionGate>
  );
}
