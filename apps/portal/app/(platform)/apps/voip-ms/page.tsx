"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiGet, apiPatch, apiPost, apiPut } from "../../../../services/apiClient";
import { normalizeUsCanadaToE164 } from "@connect/shared";

type Overview = {
  hasCredentials: boolean;
  usernameHint: string | null;
  smsEnabled: boolean;
  mmsEnabled: boolean;
  lastHealthOk: boolean | null;
  lastHealthAt: string | null;
  lastHealthMessage: string | null;
  lastDidsSyncAt: string | null;
  webhookUrl: string;
  webhookUrlNote?: string;
};

type SmsRow = {
  id: string;
  phoneE164: string;
  phoneRaw: string | null;
  tenantId: string | null;
  tenantName: string | null;
  smsCapable: boolean;
  mmsCapable: boolean;
  isTenantDefault: boolean;
  active: boolean;
  assignedUserId: string | null;
  assignedUserEmail: string | null;
  assignedExtensionId: string | null;
  assignedExtensionNumber: string | null;
};

type TenantRow = { id: string; name: string };
type ExtRow = { id: string; extNumber: string; displayName: string };

/** Always build the webhook URL from the current browser origin + /api */
function buildWebhookUrl(): string {
  if (typeof window === "undefined") return "";
  const origin = window.location.origin.replace(/\/+$/, "");
  const q = "from={FROM}&to={TO}&message={MESSAGE}&id={ID}&date={TIMESTAMP}&media={MEDIA}";
  return `${origin}/api/webhooks/voipms/sms?${q}`;
}

export default function VoipMsIntegrationPage() {
  const { can, role } = useAppContext();
  const superOnly = role === "SUPER_ADMIN";
  const [tab, setTab] = useState<"connection" | "numbers" | "routing">("connection");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [numbers, setNumbers] = useState<SmsRow[]>([]);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);

  // credentials form
  const [credUser, setCredUser] = useState("");
  const [credPass, setCredPass] = useState("");
  const [credBase, setCredBase] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  // test SMS form
  const [testFrom, setTestFrom] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testMsg, setTestMsg] = useState("Test from Connect");
  const [testSending, setTestSending] = useState(false);

  // routing preview
  const [previewPhone, setPreviewPhone] = useState("");

  // webhook URL copy state
  const [webhookCopied, setWebhookCopied] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");

  useEffect(() => {
    setWebhookUrl(buildWebhookUrl());
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, n] = await Promise.all([
        apiGet<Overview>("/admin/apps/voip-ms/overview"),
        apiGet<{ numbers: SmsRow[] }>("/admin/apps/voip-ms/numbers"),
      ]);
      setOverview(o);
      setNumbers(n.numbers ?? []);
      if (superOnly) {
        const t = await apiGet<{ tenants: TenantRow[] }>("/admin/apps/voip-ms/tenants").catch(() => ({ tenants: [] }));
        setTenants(t.tenants ?? []);
      }
    } catch {
      setOverview(null);
      setNumbers([]);
    } finally {
      setLoading(false);
    }
  }, [superOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  function notify(text: string, kind: "ok" | "err" = "ok") {
    setMsg({ text, kind });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveCredentials() {
    setMsg(null);
    try {
      await apiPut("/admin/apps/voip-ms/credentials", {
        username: credUser,
        password: credPass,
        ...(credBase ? { apiBaseUrl: credBase } : {}),
        ...(webhookSecret ? { webhookSecret } : {}),
      });
      setCredPass("");
      setWebhookSecret("");
      notify("Credentials saved — secrets are never shown again.");
      await load();
    } catch (e: unknown) {
      notify(String((e as Error)?.message || e), "err");
    }
  }

  async function copyWebhookUrl() {
    const url = webhookUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.cssText = "position:fixed;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setWebhookCopied(true);
    window.setTimeout(() => setWebhookCopied(false), 2500);
  }

  async function testConn() {
    setMsg(null);
    try {
      await apiPost("/admin/apps/voip-ms/test", {});
      notify("Connection test OK — credentials are valid.");
      await load();
    } catch (e: unknown) {
      notify(String((e as Error)?.message || e), "err");
    }
  }

  async function syncDids() {
    setMsg(null);
    try {
      const r = await apiPost<{ upserted: number }>("/admin/apps/voip-ms/sync-numbers", {});
      notify(`Synced ${r.upserted ?? 0} SMS-capable numbers from VoIP.ms.`);
      await load();
    } catch (e: unknown) {
      notify(String((e as Error)?.message || e), "err");
    }
  }

  async function toggleFlags(smsEnabled?: boolean, mmsEnabled?: boolean) {
    await apiPost("/admin/apps/voip-ms/flags", { smsEnabled, mmsEnabled });
    await load();
  }

  async function sendTestSms() {
    if (!testFrom || !testTo || !testMsg) return;
    setTestSending(true);
    setMsg(null);
    try {
      const r = await apiPost<{ ok: boolean; messageId?: string }>("/admin/apps/voip-ms/send-test-sms", {
        from: testFrom,
        to: testTo,
        message: testMsg,
      });
      notify(`Test SMS sent! Message ID: ${r.messageId || "—"}`);
    } catch (e: unknown) {
      notify(String((e as Error)?.message || e), "err");
    } finally {
      setTestSending(false);
    }
  }

  const preview = previewPhone.trim() ? normalizeUsCanadaToE164(previewPhone.trim()) : null;

  return (
    <PermissionGate permission="can_manage_voip_ms" fallback={<div className="state-box">You do not have access to VoIP.ms integration.</div>}>
      <div className="stack">
        <PageHeader
          title="VoIP.ms"
          subtitle="SMS/MMS via VoIP.ms — credentials, number inventory, and tenant routing."
          actions={
            <Link className="btn ghost" href="/apps">
              ← Apps
            </Link>
          }
        />

        <div className="row-actions" style={{ gap: 8 }}>
          {(["connection", "numbers", "routing"] as const).map((t) => (
            <button key={t} className={`btn ${tab === t ? "" : "ghost"}`} type="button" onClick={() => setTab(t)}>
              {t === "connection" ? "Connection" : t === "numbers" ? `Numbers (${numbers.length})` : "Routing preview"}
            </button>
          ))}
        </div>

        {msg ? (
          <div
            className="panel"
            style={{ borderColor: msg.kind === "err" ? "var(--danger)" : "var(--success, var(--brand))", fontSize: 14 }}
          >
            {msg.text}
          </div>
        ) : null}
        {loading ? <div className="state-box">Loading…</div> : null}

        {/* ── CONNECTION TAB ── */}
        {!loading && tab === "connection" ? (
          <section className="stack">
            {/* Webhook URL — always displayed */}
            <div className="panel stack">
              <h3 style={{ marginTop: 0 }}>Webhook URL</h3>
              <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 10px" }}>
                Paste this into <strong>VoIP.ms → DID → SMS/MMS URL callback</strong>. Keep the{" "}
                <code>{"{FROM}"}</code>, <code>{"{TO}"}</code>, <code>{"{MESSAGE}"}</code> placeholders — VoIP.ms
                substitutes real values on each inbound message.
              </p>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                <textarea
                  readOnly
                  aria-label="VoIP.ms webhook URL"
                  value={webhookUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  rows={3}
                  style={{
                    flex: "1 1 300px",
                    minWidth: 0,
                    fontSize: 12,
                    fontFamily: "ui-monospace, monospace",
                    padding: 10,
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "var(--panel-2)",
                    color: "var(--text)",
                    resize: "vertical",
                    wordBreak: "break-all",
                    lineHeight: 1.5,
                  }}
                />
                <button
                  type="button"
                  className="btn"
                  style={{ minWidth: 100, alignSelf: "flex-start" }}
                  onClick={() => void copyWebhookUrl()}
                  disabled={!webhookUrl}
                >
                  {webhookCopied ? "✓ Copied!" : "Copy URL"}
                </button>
              </div>
            </div>

            {/* Status + Actions */}
            <div className="panel">
              <div className="grid two">
                <div>
                  <h3 style={{ marginTop: 0 }}>Status</h3>
                  <ul className="list" style={{ fontSize: 14, lineHeight: 1.8 }}>
                    <li>
                      Credentials:{" "}
                      <strong style={{ color: overview?.hasCredentials ? "var(--success, green)" : "var(--danger)" }}>
                        {overview?.hasCredentials ? "configured" : "missing"}
                      </strong>
                    </li>
                    {overview?.usernameHint ? <li>Username: {overview.usernameHint}</li> : null}
                    <li>SMS enabled: {overview?.smsEnabled ? "yes" : "no"}</li>
                    <li>MMS enabled: {overview?.mmsEnabled ? "yes" : "no"}</li>
                    <li>
                      Last health:{" "}
                      <span style={{ color: overview?.lastHealthOk === false ? "var(--danger)" : undefined }}>
                        {overview?.lastHealthAt
                          ? `${new Date(overview.lastHealthAt).toLocaleString()} — ${overview.lastHealthMessage || "—"}`
                          : "never"}
                      </span>
                    </li>
                    <li>Last DID sync: {overview?.lastDidsSyncAt ? new Date(overview.lastDidsSyncAt).toLocaleString() : "never"}</li>
                  </ul>
                  {superOnly ? (
                    <div className="row-actions" style={{ marginTop: 14, flexWrap: "wrap", gap: 8 }}>
                      <button className="btn" type="button" onClick={testConn} disabled={!overview?.hasCredentials}>
                        Test connection
                      </button>
                      <button className="btn" type="button" onClick={syncDids} disabled={!overview?.hasCredentials}>
                        Sync numbers
                      </button>
                      <button className="btn ghost" type="button" onClick={() => toggleFlags(!overview?.smsEnabled, undefined)}>
                        Toggle SMS
                      </button>
                      <button className="btn ghost" type="button" onClick={() => toggleFlags(undefined, !overview?.mmsEnabled)}>
                        Toggle MMS
                      </button>
                    </div>
                  ) : (
                    <p style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 12 }}>
                      Global credentials and sync require super admin access.
                    </p>
                  )}
                </div>

                {superOnly ? (
                  <div>
                    <h3 style={{ marginTop: 0 }}>API Credentials</h3>
                    <p style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 10 }}>Never shown back after saving.</p>
                    <input
                      className="input"
                      placeholder="VoIP.ms API email / username"
                      value={credUser}
                      onChange={(e) => setCredUser(e.target.value)}
                      style={{ marginBottom: 8 }}
                    />
                    <input
                      className="input"
                      placeholder="VoIP.ms API password"
                      type="password"
                      value={credPass}
                      onChange={(e) => setCredPass(e.target.value)}
                      style={{ marginBottom: 8 }}
                    />
                    <input
                      className="input"
                      placeholder="API base URL (optional — leave blank for default)"
                      value={credBase}
                      onChange={(e) => setCredBase(e.target.value)}
                      style={{ marginBottom: 8 }}
                    />
                    <input
                      className="input"
                      placeholder="Webhook shared secret (optional)"
                      type="password"
                      value={webhookSecret}
                      onChange={(e) => setWebhookSecret(e.target.value)}
                      style={{ marginBottom: 10 }}
                    />
                    <button className="btn" type="button" onClick={() => void saveCredentials()} disabled={!credUser || !credPass}>
                      Save credentials
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Test SMS */}
            {superOnly ? (
              <div className="panel stack">
                <h3 style={{ marginTop: 0 }}>Send test SMS</h3>
                <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 10px" }}>
                  Send a real SMS via VoIP.ms to verify the credentials work end-to-end. Use an E.164 number.
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div style={{ flex: "1 1 160px" }}>
                    <label style={{ display: "block", fontSize: 12, color: "var(--text-dim)", marginBottom: 4 }}>From (your DID)</label>
                    <input
                      className="input"
                      placeholder="+1xxxxxxxxxx"
                      value={testFrom}
                      onChange={(e) => setTestFrom(e.target.value)}
                    />
                  </div>
                  <div style={{ flex: "1 1 160px" }}>
                    <label style={{ display: "block", fontSize: 12, color: "var(--text-dim)", marginBottom: 4 }}>To (destination)</label>
                    <input
                      className="input"
                      placeholder="+1xxxxxxxxxx"
                      value={testTo}
                      onChange={(e) => setTestTo(e.target.value)}
                    />
                  </div>
                  <div style={{ flex: "2 1 200px" }}>
                    <label style={{ display: "block", fontSize: 12, color: "var(--text-dim)", marginBottom: 4 }}>Message</label>
                    <input
                      className="input"
                      placeholder="Test message"
                      value={testMsg}
                      onChange={(e) => setTestMsg(e.target.value)}
                    />
                  </div>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void sendTestSms()}
                    disabled={!testFrom || !testTo || !testMsg || testSending || !overview?.hasCredentials}
                    style={{ alignSelf: "flex-end" }}
                  >
                    {testSending ? "Sending…" : "Send test"}
                  </button>
                </div>
                {!overview?.hasCredentials ? (
                  <p style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>Save credentials first before sending a test.</p>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* ── NUMBERS TAB ── */}
        {!loading && tab === "numbers" ? (
          <section className="panel stack">
            <div style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between", flexWrap: "wrap" }}>
              <div>
                <h3 style={{ marginTop: 0 }}>Synced numbers</h3>
                <p style={{ fontSize: 13, color: "var(--text-dim)", margin: 0 }}>
                  {numbers.length} numbers — assign each to a tenant, and optionally pin to an extension for inbound routing.
                </p>
              </div>
              {superOnly ? (
                <button className="btn" type="button" onClick={syncDids} disabled={!overview?.hasCredentials} style={{ flexShrink: 0 }}>
                  Sync now
                </button>
              ) : null}
            </div>
            {numbers.length === 0 ? (
              <div className="state-box">
                No numbers synced yet.{" "}
                {superOnly ? <span>Use <strong>Sync numbers</strong> on the Connection tab to pull DIDs from VoIP.ms.</span> : null}
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="table" style={{ minWidth: 780 }}>
                  <thead>
                    <tr>
                      <th>Phone (E.164)</th>
                      <th>Raw DID</th>
                      <th>SMS</th>
                      <th>MMS</th>
                      <th>Tenant</th>
                      <th>Default</th>
                      <th>Active</th>
                      <th>Extension</th>
                      {can("can_assign_sms_numbers") ? <th style={{ minWidth: 180 }}>Assign</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {numbers.map((r) => (
                      <tr key={r.id}>
                        <td><code style={{ fontSize: 12 }}>{r.phoneE164}</code></td>
                        <td style={{ fontSize: 13 }}>{r.phoneRaw || "—"}</td>
                        <td>{r.smsCapable ? "✓" : "—"}</td>
                        <td>{r.mmsCapable ? "✓" : "—"}</td>
                        <td style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", fontSize: 13 }}>
                          {r.tenantName ? <span title={r.tenantId || ""}>{r.tenantName}</span> : r.tenantId ? <span style={{ opacity: 0.6 }}>{r.tenantId.slice(0, 8)}…</span> : "—"}
                        </td>
                        <td>{r.isTenantDefault ? <span style={{ color: "var(--brand)" }}>✓</span> : "—"}</td>
                        <td>{r.active ? <span style={{ color: "var(--success, green)" }}>yes</span> : <span style={{ opacity: 0.5 }}>no</span>}</td>
                        <td style={{ fontSize: 12 }}>{r.assignedExtensionNumber ? `Ext ${r.assignedExtensionNumber}` : r.assignedExtensionId ? r.assignedExtensionId.slice(0, 8) + "…" : "—"}</td>
                        {can("can_assign_sms_numbers") ? (
                          <td>
                            <NumberAssignForm row={r} tenants={tenants} superOnly={superOnly} onSaved={load} />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}

        {/* ── ROUTING PREVIEW TAB ── */}
        {!loading && tab === "routing" ? (
          <section className="panel stack">
            <h3 style={{ marginTop: 0 }}>Routing preview</h3>
            <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 12px" }}>
              Enter a phone number to see how it normalizes and which tenant/extension it routes to.
            </p>
            <input
              className="input"
              placeholder="Enter any phone format, e.g. (555) 867-5309"
              value={previewPhone}
              onChange={(e) => setPreviewPhone(e.target.value)}
              style={{ maxWidth: 320 }}
            />
            {preview && preview.ok ? (
              <p style={{ fontSize: 14 }}>
                Normalized: <code>{preview.e164}</code>
              </p>
            ) : preview && !preview.ok ? (
              <p style={{ fontSize: 14, color: "var(--danger)" }}>Invalid: {preview.error}</p>
            ) : null}
            <button
              className="btn"
              type="button"
              disabled={!preview?.ok}
              style={{ maxWidth: 160 }}
              onClick={async () => {
                if (!preview?.ok) return;
                setMsg(null);
                try {
                  const r = await apiGet<{ found: boolean; tenantId?: string; inboundRoutesTo?: string; normalized: string }>(
                    `/admin/apps/voip-ms/routing-preview?phoneE164=${encodeURIComponent(preview.e164)}`,
                  );
                  if (!r.found) {
                    notify(`${r.normalized} — not assigned to any tenant.`, "err");
                  } else {
                    notify(`Routes to: ${r.inboundRoutesTo || "tenant inbox"} (tenant: ${r.tenantId || "—"})`);
                  }
                } catch (e: unknown) {
                  notify(String((e as Error)?.message || e), "err");
                }
              }}
            >
              Lookup routing
            </button>
          </section>
        ) : null}
      </div>
    </PermissionGate>
  );
}

function NumberAssignForm({
  row,
  tenants,
  superOnly,
  onSaved,
}: {
  row: SmsRow;
  tenants: TenantRow[];
  superOnly: boolean;
  onSaved: () => Promise<void>;
}) {
  const [tenantId, setTenantId] = useState(row.tenantId || "");
  const [extId, setExtId] = useState(row.assignedExtensionId || "");
  const [isDef, setIsDef] = useState(row.isTenantDefault);
  const [active, setActive] = useState(row.active);
  const [extensions, setExtensions] = useState<ExtRow[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!tenantId) { setExtensions([]); return; }
    apiGet<{ extensions: ExtRow[] }>(`/admin/apps/voip-ms/extensions?tenantId=${encodeURIComponent(tenantId)}`)
      .then((r) => setExtensions(r.extensions ?? []))
      .catch(() => setExtensions([]));
  }, [tenantId]);

  async function save() {
    setSaving(true);
    try {
      await apiPatch(`/admin/apps/voip-ms/numbers/${row.id}`, {
        tenantId: tenantId || null,
        assignedUserId: null,
        assignedExtensionId: extId || null,
        isTenantDefault: isDef,
        active,
      });
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack" style={{ minWidth: 180, gap: 6 }}>
      {superOnly && tenants.length > 0 ? (
        <select
          className="input"
          style={{ fontSize: 12 }}
          value={tenantId}
          onChange={(e) => { setTenantId(e.target.value); setExtId(""); }}
        >
          <option value="">— unassigned —</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>{t.name || t.id}</option>
          ))}
        </select>
      ) : (
        <input
          className="input"
          style={{ fontSize: 12 }}
          placeholder="Tenant ID"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
        />
      )}

      {extensions.length > 0 ? (
        <select className="input" style={{ fontSize: 12 }} value={extId} onChange={(e) => setExtId(e.target.value)}>
          <option value="">— no extension —</option>
          {extensions.map((e) => (
            <option key={e.id} value={e.id}>Ext {e.extNumber}{e.displayName ? ` — ${e.displayName}` : ""}</option>
          ))}
        </select>
      ) : (
        <input
          className="input"
          style={{ fontSize: 12 }}
          placeholder="Extension ID (optional)"
          value={extId}
          onChange={(e) => setExtId(e.target.value)}
        />
      )}

      <div style={{ display: "flex", gap: 10, fontSize: 12 }}>
        <label>
          <input type="checkbox" checked={isDef} onChange={(e) => setIsDef(e.target.checked)} />{" "}
          Default
        </label>
        <label>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{" "}
          Active
        </label>
      </div>

      <button className="btn" type="button" style={{ fontSize: 12 }} onClick={() => void save()} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
