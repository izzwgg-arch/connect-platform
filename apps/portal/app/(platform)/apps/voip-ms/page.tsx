"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { ConnectSelect, ConnectMultiSelect } from "../../../../components/ConnectSelect";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../../../../services/apiClient";
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

type AccountRow = {
  id: string;
  label: string | null;
  isPrimary: boolean;
  hasCredentials: boolean;
  usernameHint: string | null;
  apiBaseUrl: string | null;
  lastHealthOk: boolean | null;
  lastHealthAt: string | null;
  lastHealthMessage: string | null;
  lastDidsSyncAt: string | null;
  numberCount: number;
};

type SmsRow = {
  id: string;
  phoneE164: string;
  phoneRaw: string | null;
  voipmsAccountId?: string;
  voipmsAccountLabel?: string | null;
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
  assignedUserIds: string[];
  assignedUserEmails: string[];
  assignedUsers?: Array<{ userId: string; email: string | null; inboxMode: "SHARED" | "PERSONAL" }>;
};

type TenantRow = { id: string; name: string };
type ExtRow = { id: string; extNumber: string; displayName: string };
type UserRow = { id: string; email: string; displayName: string };

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
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [numbers, setNumbers] = useState<SmsRow[]>([]);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [numberSearch, setNumberSearch] = useState("");

  // credentials form (primary account)
  const [credUser, setCredUser] = useState("");
  const [credPass, setCredPass] = useState("");
  const [credBase, setCredBase] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  // add-another-account form
  const [newAcctLabel, setNewAcctLabel] = useState("");
  const [newAcctUser, setNewAcctUser] = useState("");
  const [newAcctPass, setNewAcctPass] = useState("");
  const [newAcctBase, setNewAcctBase] = useState("");
  const [newAcctSaving, setNewAcctSaving] = useState(false);
  const [acctBusyId, setAcctBusyId] = useState<string | null>(null);

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
      setNumbers((n.numbers ?? []).map((r) => ({
        ...r,
        assignedUserIds: r.assignedUserIds ?? [],
        assignedUserEmails: r.assignedUserEmails ?? [],
        assignedUsers: r.assignedUsers ?? [],
      })));
      if (superOnly) {
        const t = await apiGet<{ tenants: TenantRow[] }>("/admin/apps/voip-ms/tenants").catch(() => ({ tenants: [] }));
        setTenants(t.tenants ?? []);
        const a = await apiGet<{ accounts: AccountRow[] }>("/admin/apps/voip-ms/accounts").catch(() => ({ accounts: [] }));
        setAccounts(a.accounts ?? []);
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

  async function addAccount() {
    if (!newAcctLabel || !newAcctUser || !newAcctPass) return;
    setNewAcctSaving(true);
    setMsg(null);
    try {
      await apiPost("/admin/apps/voip-ms/accounts", {
        label: newAcctLabel,
        username: newAcctUser,
        password: newAcctPass,
        ...(newAcctBase ? { apiBaseUrl: newAcctBase } : {}),
      });
      setNewAcctLabel("");
      setNewAcctUser("");
      setNewAcctPass("");
      setNewAcctBase("");
      notify("VoIP.ms account attached. Run a sync to pull its numbers in.");
      await load();
    } catch (e: unknown) {
      notify(String((e as Error)?.message || e), "err");
    } finally {
      setNewAcctSaving(false);
    }
  }

  async function testAccount(accountId: string) {
    setAcctBusyId(accountId);
    setMsg(null);
    try {
      await apiPost(`/admin/apps/voip-ms/accounts/${encodeURIComponent(accountId)}/test`, {});
      notify("Connection test OK — this account's credentials are valid.");
      await load();
    } catch (e: unknown) {
      notify(String((e as Error)?.message || e), "err");
    } finally {
      setAcctBusyId(null);
    }
  }

  async function syncAccount(accountId: string) {
    setAcctBusyId(accountId);
    setMsg(null);
    try {
      const r = await apiPost<{ upserted?: number }>("/admin/apps/voip-ms/sync-numbers", { accountId });
      notify(`Synced ${r.upserted ?? 0} numbers from this account.`);
      await load();
    } catch (e: unknown) {
      notify(String((e as Error)?.message || e), "err");
    } finally {
      setAcctBusyId(null);
    }
  }

  async function removeAccount(accountId: string, label: string) {
    if (typeof window !== "undefined" && !window.confirm(`Remove the VoIP.ms account "${label}"? Its saved credentials are deleted from Connect (nothing changes at VoIP.ms).`)) return;
    setAcctBusyId(accountId);
    setMsg(null);
    try {
      await apiDelete(`/admin/apps/voip-ms/accounts/${encodeURIComponent(accountId)}`);
      notify("Account removed.");
      await load();
    } catch (e: unknown) {
      notify(String((e as Error)?.message || e), "err");
    } finally {
      setAcctBusyId(null);
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
      const r = await apiPost<{ ok: boolean; messageId?: string; from?: string; to?: string }>(
        "/admin/apps/voip-ms/send-test-sms",
        { from: testFrom, to: testTo, message: testMsg },
      );
      notify(`Test SMS sent from ${r.from || testFrom} → ${r.to || testTo}. Message ID: ${r.messageId || "—"}`);
    } catch (e: unknown) {
      notify(String((e as Error)?.message || e), "err");
    } finally {
      setTestSending(false);
    }
  }

  const preview = previewPhone.trim() ? normalizeUsCanadaToE164(previewPhone.trim()) : null;

  const filteredNumbers = numberSearch.trim()
    ? numbers.filter((r) => {
        const q = numberSearch.trim().toLowerCase().replace(/\D/g, "");
        const digits = r.phoneE164.replace(/\D/g, "");
        const rawDigits = (r.phoneRaw || "").replace(/\D/g, "");
        const tenant = (r.tenantName || r.tenantId || "").toLowerCase();
        return (
          digits.includes(q) ||
          rawDigits.includes(q) ||
          tenant.includes(numberSearch.trim().toLowerCase())
        );
      })
    : numbers;

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
              {t === "connection" ? "Connection" : t === "numbers" ? `Numbers (${numberSearch.trim() ? `${filteredNumbers.length}/${numbers.length}` : numbers.length})` : "Routing preview"}
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
                    <h3 style={{ marginTop: 0 }}>Primary account credentials</h3>
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

            {/* Accounts — the primary plus any additional VoIP.ms accounts */}
            {superOnly ? (
              <div className="panel stack">
                <h3 style={{ marginTop: 0 }}>VoIP.ms accounts</h3>
                <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 10px" }}>
                  Attach more than one VoIP.ms account. Each synced number remembers which account it lives on, and
                  texting in and out of that number uses that account&rsquo;s credentials automatically. New sign-ups and
                  number purchases keep using the primary account.
                </p>
                {accounts.length === 0 ? (
                  <div className="state-box">No accounts yet — save the primary credentials above first.</div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="table" style={{ minWidth: 640 }}>
                      <thead>
                        <tr>
                          <th>Account</th>
                          <th>Username</th>
                          <th>Numbers</th>
                          <th>Last health</th>
                          <th>Last sync</th>
                          <th style={{ minWidth: 220 }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {accounts.map((a) => {
                          const name = a.isPrimary ? "Primary account" : a.label || a.id.slice(0, 8);
                          const busy = acctBusyId === a.id;
                          return (
                            <tr key={a.id}>
                              <td style={{ fontSize: 13 }}>
                                {name}
                                {a.isPrimary ? <span style={{ marginLeft: 6, fontSize: 11, color: "var(--brand)" }}>primary</span> : null}
                              </td>
                              <td style={{ fontSize: 13 }}>{a.usernameHint || <span style={{ color: "var(--danger)" }}>missing</span>}</td>
                              <td style={{ fontSize: 13 }}>{a.numberCount}</td>
                              <td style={{ fontSize: 12 }}>
                                {a.lastHealthAt ? (
                                  <span style={{ color: a.lastHealthOk === false ? "var(--danger)" : undefined }}>
                                    {new Date(a.lastHealthAt).toLocaleString()} — {a.lastHealthMessage || "—"}
                                  </span>
                                ) : (
                                  "never"
                                )}
                              </td>
                              <td style={{ fontSize: 12 }}>{a.lastDidsSyncAt ? new Date(a.lastDidsSyncAt).toLocaleString() : "never"}</td>
                              <td>
                                <div className="row-actions" style={{ gap: 6, flexWrap: "wrap" }}>
                                  <button className="btn ghost" type="button" disabled={busy || !a.hasCredentials} onClick={() => void testAccount(a.id)}>
                                    Test
                                  </button>
                                  <button className="btn ghost" type="button" disabled={busy || !a.hasCredentials} onClick={() => void syncAccount(a.id)}>
                                    Sync
                                  </button>
                                  {!a.isPrimary ? (
                                    <button
                                      className="btn ghost"
                                      type="button"
                                      disabled={busy || a.numberCount > 0}
                                      title={a.numberCount > 0 ? "This account still owns synced numbers." : undefined}
                                      style={{ color: "var(--danger)" }}
                                      onClick={() => void removeAccount(a.id, a.label || a.id.slice(0, 8))}
                                    >
                                      Remove
                                    </button>
                                  ) : null}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <h4 style={{ margin: "14px 0 6px" }}>Attach another VoIP.ms account</h4>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div style={{ flex: "1 1 140px" }}>
                    <label style={{ display: "block", fontSize: 12, color: "var(--text-dim)", marginBottom: 4 }}>Name</label>
                    <input className="input" placeholder="e.g. Second account" value={newAcctLabel} onChange={(e) => setNewAcctLabel(e.target.value)} />
                  </div>
                  <div style={{ flex: "1 1 180px" }}>
                    <label style={{ display: "block", fontSize: 12, color: "var(--text-dim)", marginBottom: 4 }}>API email / username</label>
                    <input className="input" placeholder="VoIP.ms API username" value={newAcctUser} onChange={(e) => setNewAcctUser(e.target.value)} />
                  </div>
                  <div style={{ flex: "1 1 160px" }}>
                    <label style={{ display: "block", fontSize: 12, color: "var(--text-dim)", marginBottom: 4 }}>API password</label>
                    <input className="input" type="password" placeholder="VoIP.ms API password" value={newAcctPass} onChange={(e) => setNewAcctPass(e.target.value)} />
                  </div>
                  <div style={{ flex: "1 1 180px" }}>
                    <label style={{ display: "block", fontSize: 12, color: "var(--text-dim)", marginBottom: 4 }}>API base URL (optional)</label>
                    <input className="input" placeholder="Leave blank for default" value={newAcctBase} onChange={(e) => setNewAcctBase(e.target.value)} />
                  </div>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void addAccount()}
                    disabled={!newAcctLabel || !newAcctUser || !newAcctPass || newAcctSaving}
                    style={{ alignSelf: "flex-end" }}
                  >
                    {newAcctSaving ? "Attaching…" : "Attach account"}
                  </button>
                </div>
                <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6 }}>
                  Remember to enable API access for Connect&rsquo;s server IP in that VoIP.ms account (Main Menu → SOAP and REST/JSON API), then run a sync.
                </p>
              </div>
            ) : null}

            {/* Test SMS */}
            {superOnly ? (
              <div className="panel stack">
                <h3 style={{ marginTop: 0 }}>Send test SMS</h3>
                <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 10px" }}>
                  Send a real SMS via VoIP.ms to verify credentials end-to-end. US/Canada formats are accepted — the API normalizes them to E.164 automatically.
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div style={{ flex: "1 1 160px" }}>
                    <label style={{ display: "block", fontSize: 12, color: "var(--text-dim)", marginBottom: 4 }}>From (your VoIP.ms DID)</label>
                    <input
                      className="input"
                      placeholder="e.g. +16471234567 or 6471234567"
                      value={testFrom}
                      onChange={(e) => setTestFrom(e.target.value)}
                    />
                  </div>
                  <div style={{ flex: "1 1 160px" }}>
                    <label style={{ display: "block", fontSize: 12, color: "var(--text-dim)", marginBottom: 4 }}>To (destination number)</label>
                    <input
                      className="input"
                      placeholder="e.g. +19051234567 or 9051234567"
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
                  {filteredNumbers.length !== numbers.length
                    ? `${filteredNumbers.length} of ${numbers.length} numbers`
                    : `${numbers.length} numbers`}{" "}
                  — assign each to a tenant. Leave extension as <strong>Shared tenant inbox</strong> for a tenant-wide SMS inbox, or pin to an extension for a personal inbox.
                </p>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  className="input"
                  placeholder="Search by number or tenant…"
                  value={numberSearch}
                  onChange={(e) => setNumberSearch(e.target.value)}
                  style={{ minWidth: 220, fontSize: 13 }}
                />
                {superOnly ? (
                  <button className="btn" type="button" onClick={syncDids} disabled={!overview?.hasCredentials} style={{ flexShrink: 0 }}>
                    Sync now
                  </button>
                ) : null}
              </div>
            </div>
            {numbers.length === 0 ? (
              <div className="state-box">
                No numbers synced yet.{" "}
                {superOnly ? <span>Use <strong>Sync numbers</strong> on the Connection tab to pull DIDs from VoIP.ms.</span> : null}
              </div>
            ) : filteredNumbers.length === 0 ? (
              <div className="state-box">No numbers match &ldquo;{numberSearch}&rdquo;.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="table" style={{ minWidth: 780 }}>
                  <thead>
                    <tr>
                      <th>Phone (E.164)</th>
                      <th>Raw DID</th>
                      {accounts.length > 1 ? <th>Account</th> : null}
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
                    {filteredNumbers.map((r) => (
                      <tr key={r.id}>
                        <td><code style={{ fontSize: 12 }}>{r.phoneE164}</code></td>
                        <td style={{ fontSize: 13 }}>{r.phoneRaw || "—"}</td>
                        {accounts.length > 1 ? (
                          <td style={{ fontSize: 12 }}>
                            {!r.voipmsAccountId || r.voipmsAccountId === "default" ? "Primary" : r.voipmsAccountLabel || r.voipmsAccountId.slice(0, 8)}
                          </td>
                        ) : null}
                        <td>{r.smsCapable ? "✓" : "—"}</td>
                        <td>{r.mmsCapable ? "✓" : "—"}</td>
                        <td style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", fontSize: 13 }}>
                          {r.tenantName ? <span title={r.tenantId || ""}>{r.tenantName}</span> : r.tenantId ? <span style={{ opacity: 0.6 }}>{r.tenantId.slice(0, 8)}…</span> : "—"}
                        </td>
                        <td>{r.isTenantDefault ? <span style={{ color: "var(--brand)" }}>✓</span> : "—"}</td>
                        <td>{r.active ? <span style={{ color: "var(--success, green)" }}>yes</span> : <span style={{ opacity: 0.5 }}>no</span>}</td>
                        <td style={{ fontSize: 12 }}>
                          {r.assignedExtensionNumber
                            ? `Ext ${r.assignedExtensionNumber}`
                            : r.assignedExtensionId
                              ? r.assignedExtensionId.slice(0, 8) + "…"
                              : (r.assignedUserIds?.length ?? 0) > 0
                                ? (
                                  <span title={r.assignedUserEmails?.join(", ")}>
                                    {r.assignedUserIds.length} user{r.assignedUserIds.length === 1 ? "" : "s"} · {r.assignedUsers?.some((u) => u.inboxMode === "PERSONAL") ? "personal" : "shared"}
                                  </span>
                                )
                                : "—"}
                        </td>
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
  const [assignedUserIds, setAssignedUserIds] = useState<string[]>(row.assignedUserIds ?? []);
  const [assignedUserInboxMode, setAssignedUserInboxMode] = useState<"SHARED" | "PERSONAL">(
    row.assignedUsers?.some((u) => u.inboxMode === "PERSONAL") ? "PERSONAL" : "SHARED",
  );
  const [isDef, setIsDef] = useState(row.isTenantDefault);
  const [active, setActive] = useState(row.active);
  const [extensions, setExtensions] = useState<ExtRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!tenantId) { setExtensions([]); setUsers([]); return; }
    apiGet<{ extensions: ExtRow[] }>(`/admin/apps/voip-ms/extensions?tenantId=${encodeURIComponent(tenantId)}`)
      .then((r) => setExtensions(r.extensions ?? []))
      .catch(() => setExtensions([]));
    apiGet<{ users: UserRow[] }>(`/admin/apps/voip-ms/users?tenantId=${encodeURIComponent(tenantId)}`)
      .then((r) => setUsers(r.users ?? []))
      .catch(() => setUsers([]));
  }, [tenantId]);

  async function save() {
    setSaving(true);
    try {
      await apiPatch(`/admin/apps/voip-ms/numbers/${row.id}`, {
        tenantId: tenantId || null,
        assignedUserId: null,
        assignedExtensionId: extId || null,
        assignedUserIds: extId ? [] : assignedUserIds,
        assignedUserInboxMode,
        isTenantDefault: isDef,
        active,
      });
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack" style={{ minWidth: 200, gap: 6 }}>
      {superOnly && tenants.length > 0 ? (
        <ConnectSelect
          style={{ width: "100%" }}
          value={tenantId}
          onChange={(v) => { setTenantId(v); setExtId(""); setAssignedUserIds([]); }}
          options={[
            { value: "", label: "— unassigned —" },
            ...tenants.map((t) => ({ value: t.id, label: t.name || t.id })),
          ]}
        />
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
        <ConnectSelect
          value={extId}
          onChange={(v) => { setExtId(v); if (v) setAssignedUserIds([]); }}
          searchable
          style={{ width: "100%", fontSize: 12 }}
          options={[
            { value: "", label: "— shared tenant inbox —" },
            ...extensions.map((e) => ({ value: e.id, label: `Ext ${e.extNumber}${e.displayName ? ` — ${e.displayName}` : ""}` })),
          ]}
        />
      ) : (
        <input
          className="input"
          style={{ fontSize: 12 }}
          placeholder="Extension ID (optional)"
          value={extId}
          onChange={(e) => setExtId(e.target.value)}
        />
      )}

      {tenantId && !extId && users.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ fontSize: 11, color: "var(--text-2, #666)", marginBottom: 1 }}>
            Specific users{assignedUserIds.length > 0 ? ` (${assignedUserIds.length} selected)` : " (optional — blank = all)"}:
          </div>
          <ConnectSelect
            value={assignedUserInboxMode}
            onChange={(v) => setAssignedUserInboxMode(v === "PERSONAL" ? "PERSONAL" : "SHARED")}
            style={{ width: "100%", fontSize: 12 }}
            options={[
              { value: "SHARED", label: "Shared mailbox for selected users" },
              { value: "PERSONAL", label: "Personal mailbox per selected user" },
            ]}
          />
          <ConnectMultiSelect
            style={{ width: "100%" }}
            values={assignedUserIds}
            onChange={setAssignedUserIds}
            placeholder="— all users —"
            options={users.map((u) => ({ value: u.id, label: u.displayName || u.email }))}
          />
          {assignedUserIds.length > 0 && (
            <button
              type="button"
              style={{ fontSize: 11, background: "none", border: "none", cursor: "pointer", color: "var(--text-2, #666)", textAlign: "left", padding: 0 }}
              onClick={() => setAssignedUserIds([])}
            >
              ✕ Clear selection (back to shared)
            </button>
          )}
        </div>
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
