"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiGet, apiPatch, apiPost, apiPut, getPortalApiBaseUrl } from "../../../../services/apiClient";
import { buildVoipMsSmsWebhookCallbackUrl, normalizeUsCanadaToE164 } from "@connect/shared";

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

export default function VoipMsIntegrationPage() {
  const { can, role } = useAppContext();
  const superOnly = role === "SUPER_ADMIN";
  const canSync = can("can_sync_voip_ms_numbers");
  const [tab, setTab] = useState<"connection" | "numbers" | "routing">("connection");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [numbers, setNumbers] = useState<SmsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [credUser, setCredUser] = useState("");
  const [credPass, setCredPass] = useState("");
  const [credBase, setCredBase] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [previewPhone, setPreviewPhone] = useState("");
  const [webhookCopied, setWebhookCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, n] = await Promise.all([
        apiGet<Overview>("/admin/apps/voip-ms/overview"),
        apiGet<{ numbers: SmsRow[] }>("/admin/apps/voip-ms/numbers"),
      ]);
      setOverview(o);
      setNumbers(n.numbers ?? []);
    } catch {
      setOverview(null);
      setNumbers([]);
    } finally {
      setLoading(false);
      setWebhookCopied(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveCredentials() {
    setMsg(null);
    try {
      await apiPut("/admin/apps/voip-ms/credentials", {
        username: credUser,
        password: credPass,
        apiBaseUrl: credBase || undefined,
        webhookSecret: webhookSecret || undefined,
      });
      setCredPass("");
      setWebhookSecret("");
      setMsg("Credentials saved (secrets are not shown again).");
      await load();
    } catch (e: unknown) {
      setMsg(String((e as Error)?.message || e));
    }
  }

  const resolvedWebhookUrl = useMemo(() => {
    const w = overview?.webhookUrl?.trim() ?? "";
    if (w && !w.startsWith("(")) return w;
    if (typeof window !== "undefined") {
      const apiBase = getPortalApiBaseUrl();
      if (apiBase) return buildVoipMsSmsWebhookCallbackUrl(apiBase);
    }
    return w;
  }, [overview?.webhookUrl]);

  const usedPortalOriginFallback =
    Boolean(overview?.webhookUrl?.trim().startsWith("(")) &&
    typeof window !== "undefined" &&
    Boolean(resolvedWebhookUrl) &&
    !resolvedWebhookUrl.startsWith("(");

  const webhookUrlCopyable =
    Boolean(resolvedWebhookUrl) && !resolvedWebhookUrl.startsWith("(") && resolvedWebhookUrl !== "—";

  async function copyWebhookUrl() {
    const url = resolvedWebhookUrl.trim();
    if (!url || url.startsWith("(")) {
      setMsg("Could not build webhook URL — check NEXT_PUBLIC_API_URL or open this page in the browser.");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        setMsg("Could not copy — select the URL in the box and copy manually (Ctrl+C).");
        return;
      }
    }
    setWebhookCopied(true);
    window.setTimeout(() => setWebhookCopied(false), 2000);
  }

  async function testConn() {
    setMsg(null);
    try {
      await apiPost("/admin/apps/voip-ms/test", {});
      setMsg("Connection test OK.");
      await load();
    } catch (e: unknown) {
      setMsg(String((e as Error)?.message || e));
    }
  }

  async function syncDids() {
    setMsg(null);
    try {
      const r = await apiPost<{ upserted: number }>("/admin/apps/voip-ms/sync-numbers", {});
      setMsg(`Synced ${r.upserted ?? 0} SMS-capable numbers from VoIP.ms.`);
      await load();
    } catch (e: unknown) {
      setMsg(String((e as Error)?.message || e));
    }
  }

  async function toggleFlags(smsEnabled?: boolean, mmsEnabled?: boolean) {
    await apiPost("/admin/apps/voip-ms/flags", { smsEnabled, mmsEnabled });
    await load();
  }

  const preview = previewPhone.trim() ? normalizeUsCanadaToE164(previewPhone.trim()) : null;

  return (
    <PermissionGate permission="can_manage_voip_ms" fallback={<div className="state-box">You do not have access to VoIP.ms integration.</div>}>
      <div className="stack">
        <PageHeader
          title="VoIP.ms"
          subtitle="SMS/MMS via VoIP.ms — credentials, number inventory, and tenant routing. Internal chat uses Connect only; this page configures the external SMS provider."
          actions={
            <Link className="btn ghost" href="/apps">
              ← Apps
            </Link>
          }
        />

        <div className="row-actions" style={{ gap: 8 }}>
          {(["connection", "numbers", "routing"] as const).map((t) => (
            <button key={t} className={`btn ${tab === t ? "" : "ghost"}`} type="button" onClick={() => setTab(t)}>
              {t === "connection" ? "Connection" : t === "numbers" ? "Numbers" : "Routing preview"}
            </button>
          ))}
        </div>

        {msg ? <div className="panel" style={{ borderColor: "var(--warning)" }}>{msg}</div> : null}
        {loading ? <div className="state-box">Loading…</div> : null}

        {!loading && tab === "connection" ? (
          <section className="panel stack">
            <h3>Connection</h3>
            <p style={{ color: "var(--text-dim)", fontSize: 14 }}>
              SMS/MMS callback URL (VoIP.ms DID → SMS/MMS URL callback). Include the{" "}
              <code>{"{FROM}"}</code>, <code>{"{TO}"}</code>, … placeholders — VoIP.ms substitutes them on each hit (VoIP.ms SMS-MMS policy).
            </p>
            <div
              style={{
                marginTop: 10,
                display: "flex",
                gap: 10,
                alignItems: "stretch",
                flexWrap: "wrap",
              }}
            >
              <textarea
                readOnly
                aria-label="VoIP.ms SMS/MMS webhook URL"
                value={resolvedWebhookUrl}
                placeholder={loading ? "Loading…" : "—"}
                onFocus={(e) => e.currentTarget.select()}
                rows={4}
                style={{
                  flex: "1 1 280px",
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
                }}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 8, justifyContent: "flex-start" }}>
                <button type="button" className="btn" onClick={() => void copyWebhookUrl()} disabled={!webhookUrlCopyable}>
                  {webhookCopied ? "Copied" : "Copy URL"}
                </button>
                <span style={{ fontSize: 12, color: "var(--text-dim)", maxWidth: 140 }}>
                  Paste into VoIP.ms → DID → SMS/MMS URL callback
                </span>
              </div>
            </div>
            {usedPortalOriginFallback ? (
              <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 6 }}>
                URL uses this site’s public API base (same as the portal). If VoIP.ms must call a different host, set{" "}
                <code>PUBLIC_API_BASE_URL</code> on the API — the overview will then show that value.
              </p>
            ) : null}
            {overview?.webhookUrlNote ? (
              <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: 8 }}>{overview.webhookUrlNote}</p>
            ) : null}
            <div className="grid two">
              <div>
                <div style={{ fontSize: 13, marginBottom: 6 }}>Status</div>
                <ul className="list" style={{ fontSize: 14 }}>
                  <li>Credentials: {overview?.hasCredentials ? "configured" : "missing"}</li>
                  <li>Username hint: {overview?.usernameHint || "—"}</li>
                  <li>SMS enabled (Connect): {overview?.smsEnabled ? "yes" : "no"}</li>
                  <li>MMS enabled (Connect): {overview?.mmsEnabled ? "yes" : "no"}</li>
                  <li>Last health: {overview?.lastHealthAt || "never"} — {overview?.lastHealthMessage || "—"}</li>
                  <li>Last DID sync: {overview?.lastDidsSyncAt || "never"}</li>
                </ul>
                {superOnly ? (
                  <div className="row-actions" style={{ marginTop: 12 }}>
                    <button className="btn" type="button" onClick={() => toggleFlags(!overview?.smsEnabled, undefined)}>
                      Toggle SMS
                    </button>
                    <button className="btn ghost" type="button" onClick={() => toggleFlags(undefined, !overview?.mmsEnabled)}>
                      Toggle MMS
                    </button>
                    <button className="btn" type="button" onClick={testConn} disabled={!overview?.hasCredentials}>
                      Test connection
                    </button>
                    {canSync ? (
                      <button className="btn" type="button" onClick={syncDids} disabled={!overview?.hasCredentials}>
                        Sync numbers
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <p className="state-box" style={{ marginTop: 12 }}>
                    Global credentials and sync are limited to super administrators. You can still assign numbers already synced to your tenant on the Numbers tab.
                  </p>
                )}
              </div>
              {superOnly ? (
                <div>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>Set API credentials (never shown back)</div>
                  <input className="input" placeholder="API email / username" value={credUser} onChange={(e) => setCredUser(e.target.value)} style={{ marginBottom: 8 }} />
                  <input className="input" placeholder="API password" type="password" value={credPass} onChange={(e) => setCredPass(e.target.value)} style={{ marginBottom: 8 }} />
                  <input className="input" placeholder="API base URL (optional)" value={credBase} onChange={(e) => setCredBase(e.target.value)} style={{ marginBottom: 8 }} />
                  <input className="input" placeholder="Webhook shared secret (optional)" type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} style={{ marginBottom: 8 }} />
                  <button className="btn" type="button" onClick={saveCredentials} disabled={!credUser || !credPass}>
                    Save credentials
                  </button>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {!loading && tab === "numbers" ? (
          <section className="panel stack">
            <h3>Numbers</h3>
            <p style={{ color: "var(--text-dim)", fontSize: 14 }}>
              Canonical E.164 is the source of truth for SMS threading. Assign each DID to exactly one tenant; optionally pin to one user or extension for inbox routing.
            </p>
            <div style={{ overflowX: "auto" }}>
              <table className="table" style={{ minWidth: 720 }}>
                <thead>
                  <tr>
                    <th>Normalized</th>
                    <th>Raw</th>
                    <th>Tenant ID</th>
                    <th>Default</th>
                    <th>Active</th>
                    <th>Assign user id</th>
                    <th>Assign ext id</th>
                    {can("can_assign_sms_numbers") ? <th></th> : null}
                  </tr>
                </thead>
                <tbody>
                  {numbers.map((r) => (
                    <tr key={r.id}>
                      <td><code>{r.phoneE164}</code></td>
                      <td>{r.phoneRaw || "—"}</td>
                      <td style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>{r.tenantId || "—"}</td>
                      <td>{r.isTenantDefault ? "yes" : "—"}</td>
                      <td>{r.active ? "yes" : "no"}</td>
                      <td style={{ fontSize: 12 }}>{r.assignedUserEmail || r.assignedUserId || "—"}</td>
                      <td style={{ fontSize: 12 }}>{r.assignedExtensionNumber || r.assignedExtensionId || "—"}</td>
                      {can("can_assign_sms_numbers") ? (
                        <td>
                          <NumberAssignForm row={r} onSaved={load} />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {!loading && tab === "routing" ? (
          <section className="panel stack">
            <h3>Routing preview</h3>
            <input className="input" placeholder="Enter any phone format" value={previewPhone} onChange={(e) => setPreviewPhone(e.target.value)} />
            {preview && preview.ok ? (
              <p style={{ fontSize: 14 }}>
                Normalized: <code>{preview.e164}</code>
              </p>
            ) : preview && !preview.ok ? (
              <p style={{ fontSize: 14, color: "var(--danger)" }}>Invalid: {preview.error}</p>
            ) : null}
            <button
              className="btn ghost"
              type="button"
              onClick={async () => {
                if (!preview?.ok) return;
                try {
                  const r = await apiGet<{ found: boolean; inboundRoutesTo?: string }>(
                    `/admin/apps/voip-ms/routing-preview?phoneE164=${encodeURIComponent(preview.e164)}`,
                  );
                  setMsg(JSON.stringify(r, null, 2));
                } catch (e: unknown) {
                  setMsg(String((e as Error)?.message || e));
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

function NumberAssignForm({ row, onSaved }: { row: SmsRow; onSaved: () => Promise<void> }) {
  const [tenantId, setTenantId] = useState(row.tenantId || "");
  const [userId, setUserId] = useState(row.assignedUserId || "");
  const [extId, setExtId] = useState(row.assignedExtensionId || "");
  const [isDef, setIsDef] = useState(row.isTenantDefault);
  const [active, setActive] = useState(row.active);

  async function save() {
    await apiPatch(`/admin/apps/voip-ms/numbers/${row.id}`, {
      tenantId: tenantId || null,
      assignedUserId: userId || null,
      assignedExtensionId: extId || null,
      isTenantDefault: isDef,
      active,
    });
    await onSaved();
  }

  return (
    <div className="stack" style={{ minWidth: 200 }}>
      <input className="input" style={{ fontSize: 11 }} placeholder="tenantId" value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
      <input className="input" style={{ fontSize: 11 }} placeholder="userId" value={userId} onChange={(e) => setUserId(e.target.value)} />
      <input className="input" style={{ fontSize: 11 }} placeholder="extensionId" value={extId} onChange={(e) => setExtId(e.target.value)} />
      <label style={{ fontSize: 12 }}>
        <input type="checkbox" checked={isDef} onChange={(e) => setIsDef(e.target.checked)} /> tenant default
      </label>
      <label style={{ fontSize: 12 }}>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> active
      </label>
      <button className="btn" type="button" style={{ fontSize: 12 }} onClick={() => void save()}>
        Save
      </button>
    </div>
  );
}
