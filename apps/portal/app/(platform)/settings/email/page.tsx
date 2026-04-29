"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Mail } from "lucide-react";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPatch, apiPost } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";

type EmailSettingsResponse = {
  tenantId: string;
  currentProvider: {
    type: string | null;
    fromName?: string | null;
    fromEmail?: string | null;
    replyTo?: string | null;
    isEnabled?: boolean;
    lastTestAt?: string | null;
    lastTestResult?: string | null;
    lastTestErrorCode?: string | null;
    masked?: Record<string, unknown>;
  };
  googleWorkspace: {
    integrationType: "SMTP" | "OAUTH";
    fromName?: string | null;
    fromEmail?: string | null;
    googleWorkspaceMailboxMasked?: string | null;
    hasMailboxConfigured?: boolean;
    smtpHost?: string | null;
    smtpPort?: number | null;
    hasAppPassword: boolean;
    hasOAuthRefresh: boolean;
    oauthClientIdMasked?: string | null;
    status: "CONNECTED" | "FAILED" | "NOT_CONNECTED";
    lastTestedAt?: string | null;
    lastTestErrorCode?: string | null;
  };
};

function statusBadgeClass(status: string): string {
  if (status === "CONNECTED") return "gw-badge gw-badge--ok";
  if (status === "FAILED") return "gw-badge gw-badge--bad";
  return "gw-badge gw-badge--muted";
}

export default function SettingsEmailPage() {
  const { role } = useAppContext();
  const canEdit = role === "SUPER_ADMIN" || role === "TENANT_ADMIN";
  const [data, setData] = useState<EmailSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [fromName, setFromName] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [mailbox, setMailbox] = useState("");
  const [integrationType, setIntegrationType] = useState<"SMTP" | "OAUTH">("SMTP");
  const [smtpHost, setSmtpHost] = useState("smtp.gmail.com");
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUser, setSmtpUser] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [testTo, setTestTo] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiGet<EmailSettingsResponse>("/admin/email-settings");
      setData(r);
      setFromName(r.googleWorkspace.fromName || "");
      setFromEmail(r.googleWorkspace.fromEmail || "");
      setMailbox("");
      setIntegrationType(r.googleWorkspace.integrationType || "SMTP");
      setSmtpHost(r.googleWorkspace.smtpHost || "smtp.gmail.com");
      setSmtpPort(Number(r.googleWorkspace.smtpPort || 587));
      setSmtpUser("");
      setAppPassword("");
      setOauthClientId("");
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const googleStatus = data?.googleWorkspace?.status ?? "NOT_CONNECTED";

  const providerLabel = useMemo(() => {
    const t = data?.currentProvider?.type;
    if (!t) return "Not configured";
    if (t === "GOOGLE_WORKSPACE") return "Google Workspace";
    if (t === "SENDGRID") return "SendGrid";
    if (t === "SMTP") return "SMTP";
    return t;
  }, [data?.currentProvider?.type]);

  async function saveGoogle() {
    setToast(null);
    setBusy("save");
    try {
      const payload: Record<string, unknown> = {
        fromName: fromName.trim() || null,
        fromEmail: fromEmail.trim() || null,
        integrationType,
        smtpHost: smtpHost.trim() || null,
        smtpPort: smtpPort || null,
      };
      if (mailbox.trim()) payload.googleWorkspaceMailbox = mailbox.trim();
      if (smtpUser.trim()) payload.smtpUser = smtpUser.trim();
      if (appPassword.trim()) payload.smtpAppPassword = appPassword.trim();
      if (oauthClientId.trim()) payload.oauthClientId = oauthClientId.trim();
      await apiPatch("/admin/email-settings/google-workspace", payload);
      setToast({ kind: "ok", text: "Google Workspace settings saved. Send a test email to verify delivery." });
      setAppPassword("");
      await load();
    } catch (e: unknown) {
      setToast({ kind: "err", text: String((e as Error)?.message || e) });
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    if (!testTo.trim()) {
      setToast({ kind: "err", text: "Enter a recipient email address." });
      return;
    }
    setToast(null);
    setBusy("test");
    try {
      await apiPost("/admin/email-settings/google-workspace/test", { testRecipientEmail: testTo.trim() });
      setToast({ kind: "ok", text: `Test email queued/sent to ${testTo.trim()}. Check the inbox (and spam).` });
      await load();
    } catch (e: unknown) {
      setToast({ kind: "err", text: String((e as Error)?.message || e) });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect Google Workspace from this tenant? Outbound mail will fall back to SendGrid if configured, otherwise SMTP must be set up again.")) return;
    setToast(null);
    setBusy("disconnect");
    try {
      await apiPost("/admin/email-settings/google-workspace/disconnect", {});
      setToast({ kind: "ok", text: "Google Workspace disconnected for this tenant." });
      await load();
    } catch (e: unknown) {
      setToast({ kind: "err", text: String((e as Error)?.message || e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <PermissionGate permission="can_view_settings" fallback={<div className="state-box">You do not have access to Email Settings.</div>}>
      <div className="stack compact-stack email-settings-page">
        <PageHeader
          title="Email Settings"
          subtitle="Configure outbound email for invoices, password resets, and system notifications — without affecting telephony or billing logic."
        />

        <style jsx global>{`
          .email-settings-page .gw-card {
            border-radius: 14px;
            border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
            background: linear-gradient(145deg, var(--panel, #151821) 0%, var(--panel-2, #12151c) 100%);
            padding: 1.35rem 1.5rem;
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
          }
          .email-settings-page .gw-card h3 {
            margin: 0 0 0.35rem;
            font-size: 1.05rem;
            letter-spacing: -0.02em;
          }
          .email-settings-page .gw-row {
            display: flex;
            align-items: flex-start;
            gap: 1rem;
            flex-wrap: wrap;
          }
          .email-settings-page .gw-google-mark {
            width: 44px;
            height: 44px;
            border-radius: 10px;
            background: #fff;
            color: #4285f4;
            font-weight: 800;
            font-size: 1.35rem;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }
          .email-settings-page .gw-badge {
            display: inline-flex;
            align-items: center;
            padding: 0.2rem 0.55rem;
            border-radius: 999px;
            font-size: 0.72rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.04em;
          }
          .email-settings-page .gw-badge--ok {
            background: rgba(34, 197, 94, 0.15);
            color: #4ade80;
          }
          .email-settings-page .gw-badge--bad {
            background: rgba(248, 113, 113, 0.15);
            color: #f87171;
          }
          .email-settings-page .gw-badge--muted {
            background: rgba(148, 163, 184, 0.12);
            color: #94a3b8;
          }
          .email-settings-page .gw-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 0.75rem 1rem;
            margin-top: 1rem;
          }
          .email-settings-page .gw-field label {
            display: block;
            font-size: 0.72rem;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: var(--text-dim, #8b93a7);
            margin-bottom: 0.35rem;
          }
          .email-settings-page .gw-hint {
            font-size: 0.85rem;
            color: var(--text-dim, #8b93a7);
            line-height: 1.45;
            margin: 0.5rem 0 0;
          }
          .email-settings-page .gw-toast {
            border-radius: 10px;
            padding: 0.75rem 1rem;
            font-size: 0.9rem;
          }
          .email-settings-page .gw-toast--ok {
            border: 1px solid rgba(74, 222, 128, 0.35);
            background: rgba(34, 197, 94, 0.08);
          }
          .email-settings-page .gw-toast--err {
            border: 1px solid rgba(248, 113, 113, 0.35);
            background: rgba(248, 113, 113, 0.08);
          }
        `}</style>

        {toast ? (
          <div className={`gw-toast ${toast.kind === "ok" ? "gw-toast--ok" : "gw-toast--err"}`}>{toast.text}</div>
        ) : null}

        {loading ? <div className="state-box">Loading email configuration…</div> : null}

        {!loading && data ? (
          <>
            <section className="gw-card">
              <div className="gw-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Mail size={22} style={{ opacity: 0.85 }} />
                  <div>
                    <h3>Current email provider</h3>
                    <p className="muted" style={{ margin: 0 }}>
                      Active pipeline for queued messages (invoices, receipts, password reset, etc.).
                    </p>
                  </div>
                </div>
                <span className={statusBadgeClass(data.currentProvider.isEnabled ? "CONNECTED" : "NOT_CONNECTED")}>
                  {data.currentProvider.type || "none"}
                </span>
              </div>
              <dl style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: "0.35rem 1rem", marginTop: "1rem", fontSize: "0.9rem" }}>
                <dt className="muted">Provider</dt>
                <dd style={{ margin: 0 }}>{providerLabel}</dd>
                <dt className="muted">From name</dt>
                <dd style={{ margin: 0 }}>{data.currentProvider.fromName || "—"}</dd>
                <dt className="muted">From email</dt>
                <dd style={{ margin: 0 }}>{data.currentProvider.fromEmail || "—"}</dd>
                <dt className="muted">Enabled</dt>
                <dd style={{ margin: 0 }}>{data.currentProvider.isEnabled ? "Yes" : "No"}</dd>
                <dt className="muted">Secrets</dt>
                <dd style={{ margin: 0 }} className="muted">
                  API never returns raw passwords or tokens — only masked hints.
                </dd>
              </dl>
            </section>

            <section className="gw-card">
              <div className="gw-row">
                <div className="gw-google-mark" aria-hidden>
                  G
                </div>
                <div style={{ flex: "1 1 240px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <h3>Google Workspace email integration</h3>
                    <span className={statusBadgeClass(googleStatus)}>{googleStatus.replace("_", " ")}</span>
                  </div>
                  <p className="gw-hint">
                    Recommended: Google <strong>App password</strong> with SMTP — <code>smtp.gmail.com</code>, port{" "}
                    <code>587</code>, STARTTLS (TLS). OAuth Gmail API can be enabled later; Connect stores refresh tokens
                    encrypted like other secrets.
                  </p>
                  <p className="gw-hint" style={{ marginTop: 8 }}>
                    Last tested:{" "}
                    {data.googleWorkspace.lastTestedAt
                      ? new Date(data.googleWorkspace.lastTestedAt).toLocaleString()
                      : "—"}
                    {data.googleWorkspace.lastTestErrorCode ? (
                      <span style={{ color: "var(--danger, #f87171)", marginLeft: 8 }}>
                        ({data.googleWorkspace.lastTestErrorCode})
                      </span>
                    ) : null}
                  </p>
                </div>
              </div>

              {!canEdit ? (
                <p className="state-box" style={{ marginTop: 14 }}>
                  Only tenant or super administrators can change email integration. You can still review status here.
                </p>
              ) : (
                <>
                  <div className="gw-grid">
                    <div className="gw-field">
                      <label>From name</label>
                      <input className="input" value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Connect Communications" />
                    </div>
                    <div className="gw-field">
                      <label>From email</label>
                      <input className="input" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="billing@yourdomain.com" />
                    </div>
                    <div className="gw-field">
                      <label>Google Workspace mailbox (sign-in email)</label>
                      <input
                        className="input"
                        value={mailbox}
                        onChange={(e) => setMailbox(e.target.value)}
                        placeholder="you@yourdomain.com"
                      />
                      {data.googleWorkspace.hasMailboxConfigured && !mailbox ? (
                        <p className="gw-hint" style={{ marginTop: 6 }}>
                          On file (masked): <strong>{data.googleWorkspace.googleWorkspaceMailboxMasked || "—"}</strong> — re-enter only if you are rotating the mailbox.
                        </p>
                      ) : null}
                    </div>
                    <div className="gw-field">
                      <label>Integration type</label>
                      <select
                        className="input"
                        value={integrationType}
                        onChange={(e) => setIntegrationType(e.target.value as "SMTP" | "OAUTH")}
                      >
                        <option value="SMTP">SMTP (app password) — supported now</option>
                        <option value="OAUTH">OAuth Gmail API — coming soon</option>
                      </select>
                    </div>
                    <div className="gw-field">
                      <label>SMTP host</label>
                      <input className="input" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} disabled={integrationType !== "SMTP"} />
                    </div>
                    <div className="gw-field">
                      <label>SMTP port</label>
                      <input
                        className="input"
                        type="number"
                        value={smtpPort}
                        onChange={(e) => setSmtpPort(Number(e.target.value) || 587)}
                        disabled={integrationType !== "SMTP"}
                      />
                    </div>
                    <div className="gw-field">
                      <label>SMTP username (optional if same as mailbox)</label>
                      <input className="input" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="Usually same as mailbox" />
                    </div>
                    <div className="gw-field">
                      <label>App password</label>
                      <input
                        className="input"
                        type="password"
                        value={appPassword}
                        onChange={(e) => setAppPassword(e.target.value)}
                        placeholder={data.googleWorkspace.hasAppPassword ? "•••••••• (enter new to rotate)" : "16-character app password"}
                        autoComplete="new-password"
                      />
                    </div>
                    <div className="gw-field">
                      <label>OAuth client ID (optional, future)</label>
                      <input className="input" value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} placeholder="Leave blank unless OAuth is enabled" />
                    </div>
                  </div>

                  <div className="row-actions" style={{ marginTop: "1.1rem", flexWrap: "wrap", gap: 8 }}>
                    <button type="button" className="btn primary" disabled={busy !== null || integrationType === "OAUTH"} onClick={() => void saveGoogle()}>
                      {busy === "save" ? "Saving…" : "Save settings"}
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={busy !== null || data.currentProvider.type !== "GOOGLE_WORKSPACE"}
                      onClick={() => void disconnect()}
                    >
                      {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy !== null || integrationType === "OAUTH"}
                      title="OAuth connect flow is not wired yet — use SMTP + app password."
                      onClick={() =>
                        setToast({
                          kind: "err",
                          text: "Google OAuth sign-in is not enabled yet. Choose SMTP and create a Google app password for this mailbox.",
                        })
                      }
                    >
                      Connect Google Workspace
                    </button>
                  </div>
                  {integrationType === "OAUTH" ? (
                    <p className="gw-hint" style={{ marginTop: 10 }}>
                      OAuth is reserved for a future release. Select <strong>SMTP</strong> to go live today.
                    </p>
                  ) : null}
                </>
              )}
            </section>

            <section className="gw-card">
              <h3>Test email</h3>
              <p className="gw-hint">Sends &quot;Connect Communications test email&quot; through your saved provider configuration (same path as production mail).</p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12, alignItems: "flex-end" }}>
                <div style={{ flex: "1 1 240px" }}>
                  <label className="muted" style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
                    Recipient
                  </label>
                  <input className="input" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
                </div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!canEdit || busy !== null || data.currentProvider.type !== "GOOGLE_WORKSPACE"}
                  onClick={() => void sendTest()}
                >
                  {busy === "test" ? "Sending…" : "Send test email"}
                </button>
              </div>
              {data.currentProvider.type !== "GOOGLE_WORKSPACE" ? (
                <p className="gw-hint" style={{ marginTop: 10 }}>
                  Save Google Workspace settings above before running a test.
                </p>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </PermissionGate>
  );
}
