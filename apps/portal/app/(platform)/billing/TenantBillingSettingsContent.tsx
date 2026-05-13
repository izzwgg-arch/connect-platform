"use client";

import Link from "next/link";
import { useState } from "react";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { apiGet, apiPost, apiPut } from "../../../services/apiClient";
import { DetailCard } from "../../../components/DetailCard";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { BillingActionToast, billingErrorMessage } from "../../../components/BillingActionToast";

/**
 * Tenant billing configuration (SOLA, invoice branding, presentation).
 * Rendered at `/billing/settings` and `/settings/billing` (same gates and APIs).
 */
export function TenantBillingSettingsContent() {
  const [busy, setBusy] = useState("");
  const [webhookCopied, setWebhookCopied] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [configKey, setConfigKey] = useState(0);
  const config = useAsyncResource(() => apiGet<any>("/billing/sola/config"), [configKey]);
  const tenantBilling = useAsyncResource(() => apiGet<any>("/billing/settings"), []);
  const current = config.status === "success" ? config.data?.config : null;
  const webhookUrl =
    (config.status === "success" && (config.data?.webhookUrl || current?.webhookUrl)) || null;
  const bs = tenantBilling.status === "success" ? tenantBilling.data : null;

  async function copyWebhookUrl() {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setWebhookCopied(true);
      window.setTimeout(() => setWebhookCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  return (
    <PermissionGate permission="can_view_settings_billing" fallback={<div className="state-box">You do not have billing settings access.</div>}>
      <div className="stack compact-stack billing-admin-shell">
        <PageHeader
          title="Billing Settings"
          subtitle="SOLA/Cardknox credentials, invoice presentation, and workspace billing configuration."
        />
        <div className="row-actions" style={{ marginTop: -8, marginBottom: 8 }}>
          <Link className="btn ghost" href="/billing">
            ← Billing overview
          </Link>
          <Link className="btn ghost" href="/settings/billing">
            Open in Settings menu
          </Link>
        </div>
        <section className="billing-tenant-hero">
          <div>
            <span className="eyebrow">Billing workspace</span>
            <h2>SOLA payment setup</h2>
            <p className="muted">
              Configure this tenant&apos;s SOLA gateway here, or use Admin Billing to set up every tenant from one place.
            </p>
            <div className="row-actions">
              <Link className="btn primary" href="/billing">
                Open Tenant Billing
              </Link>
              <Link className="btn ghost" href="/admin/billing">
                Admin Billing Console
              </Link>
            </div>
          </div>
          <div className="billing-hero-metrics">
            <span>
              <strong>{current?.isEnabled ? "Enabled" : current ? "Configured" : "Missing"}</strong>
              <small>SOLA status</small>
            </span>
            <span>
              <strong>{current?.mode || "sandbox"}</strong>
              <small>Mode</small>
            </span>
          </div>
        </section>
        {config.status === "loading" ? <LoadingSkeleton rows={4} /> : null}
        {config.status === "error" ? <ErrorState message={config.error} /> : null}
        {tenantBilling.status === "error" ? <ErrorState message={tenantBilling.error} /> : null}

        {bs ? (
          <DetailCard title="Invoice & email presentation">
            <p className="muted" style={{ marginBottom: 14 }}>
              Shown on PDF invoices (text header) and billing emails. Logo URL must be <strong>https</strong> — used in HTML emails only, not embedded in PDFs.
            </p>
            <form
              className="billing-form"
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy("brand");
                try {
                  const form = new FormData(event.currentTarget);
                  await apiPut("/billing/settings/branding", {
                    invoiceCompanyName: String(form.get("invoiceCompanyName") || "").trim() || null,
                    invoiceLogoUrl: String(form.get("invoiceLogoUrl") || "").trim() || null,
                    invoiceSupportEmail: String(form.get("invoiceSupportEmail") || "").trim() || null,
                    invoiceSupportPhone: String(form.get("invoiceSupportPhone") || "").trim() || null,
                    invoiceFooterNote: String(form.get("invoiceFooterNote") || "").trim() || null,
                    invoicePaymentInstructions: String(form.get("invoicePaymentInstructions") || "").trim() || null,
                  });
                  window.location.reload();
                } finally {
                  setBusy("");
                }
              }}
            >
              <label>
                Company display name <input name="invoiceCompanyName" defaultValue={bs.invoiceCompanyName || ""} placeholder="Shown on invoice & emails" />
              </label>
              <label>
                Logo URL (https only) <input name="invoiceLogoUrl" type="url" defaultValue={bs.invoiceLogoUrl || ""} placeholder="https://cdn.example.com/logo.png" />
              </label>
              <label>
                Billing support email <input name="invoiceSupportEmail" type="email" defaultValue={bs.invoiceSupportEmail || ""} placeholder="billing-support@yourcompany.com" />
              </label>
              <label>
                Billing support phone <input name="invoiceSupportPhone" defaultValue={bs.invoiceSupportPhone || ""} placeholder="+1 …" />
              </label>
              <label>
                Invoice footer / legal note <textarea name="invoiceFooterNote" rows={3} defaultValue={bs.invoiceFooterNote || ""} placeholder="Plain text, shown on PDF and email footers" />
              </label>
              <label>
                Payment instructions <textarea name="invoicePaymentInstructions" rows={3} defaultValue={bs.invoicePaymentInstructions || ""} placeholder="Wire details, remittance notes, etc." />
              </label>
              <p className="muted" style={{ fontSize: "0.85rem" }}>
                Default due offset is <strong>{bs.paymentTermsDays ?? 15}</strong> days (set in Admin Billing → Monthly Pricing). Emails include “Net N days” from that value.
              </p>
              <div className="row-actions">
                <button className="btn primary" type="submit" disabled={!!busy}>
                  {busy === "brand" ? "Saving…" : "Save presentation"}
                </button>
              </div>
            </form>
          </DetailCard>
        ) : null}

        <DetailCard title="This Tenant SOLA Gateway">
          {webhookUrl ? (
            <div className="muted" style={{ marginBottom: 16, lineHeight: 1.5 }}>
              <strong>Webhook/Postback URL</strong> — paste this exact URL into SOLA/Cardknox webhook or postback settings so payment notifications reach Connect.
              <div className="row-actions" style={{ marginTop: 8, flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                <code style={{ fontSize: "0.85rem", wordBreak: "break-all", flex: "1 1 240px" }}>{webhookUrl}</code>
                <button className="btn ghost" type="button" onClick={() => void copyWebhookUrl()}>
                  {webhookCopied ? "Copied" : "Copy URL"}
                </button>
              </div>
            </div>
          ) : null}
          <form
            className="billing-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy("save");
              try {
                const form = new FormData(event.currentTarget);
                const mode = String(form.get("mode") || "sandbox");
                const simulate = mode === "prod" ? false : form.get("simulate") === "on";
                const apiKey = String(form.get("apiKey") || "").trim();
                if (!apiKey && !(current?.masked?.apiKey && String(current.masked.apiKey).includes("*"))) {
                  window.alert("SOLA API Key (xKey) is required.");
                  return;
                }
                const pin = String(form.get("webhookSecret") || "").trim();
                if (mode === "prod" && !pin && !(current?.masked?.webhookSecret === "********")) {
                  window.alert("Production mode requires a Webhook Verification PIN (same value in Connect and in SOLA postback security).");
                  return;
                }
                await apiPut("/billing/sola/config", {
                  mode,
                  simulate,
                  apiKey: apiKey || undefined,
                  webhookSecret: pin || undefined,
                  ifieldsKey: String(form.get("ifieldsKey") || "").trim() || undefined,
                });
                window.location.reload();
              } finally {
                setBusy("");
              }
            }}
          >
            <div className={`billing-status-pill ${current?.isEnabled ? "good" : current ? "warn" : "bad"}`}>
              {current?.isEnabled ? "Enabled" : current ? "Configured but disabled" : "Not configured"}
            </div>
            <label>
              Mode (environment)
              <select name="mode" defaultValue={current?.mode || "sandbox"}>
                <option value="sandbox">Sandbox</option>
                <option value="prod">Production</option>
              </select>
            </label>
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: -6 }}>
              Production requires a saved webhook PIN and disables simulated gateway responses.
            </p>
            <label>
              SOLA API Key (xKey){" "}
              <input name="apiKey" autoComplete="off" placeholder={current?.masked?.apiKey || "From SOLA/Cardknox dashboard"} />
            </label>
            <label>
              iFields public key (optional){" "}
              <input name="ifieldsKey" placeholder={current?.masked?.ifieldsKey || "For Billing → Payments secure card fields"} />
            </label>
            <label>
              Webhook Verification PIN{" "}
              <input name="webhookSecret" type="password" autoComplete="new-password" placeholder={current?.masked?.webhookSecret || "Same PIN as SOLA postback / ck-signature"} />
            </label>
            <label className="billing-checkbox">
              <input name="simulate" type="checkbox" defaultChecked={!!current?.simulate} disabled={current?.mode === "prod"} /> Simulate gateway responses (sandbox only)
            </label>
            <div className="row-actions">
              <button className="btn primary" type="submit" disabled={!!busy}>
                {busy === "save" ? "Saving..." : "Save SOLA"}
              </button>
              <button
                className="btn ghost"
                type="button"
                disabled={!current || !!busy}
                onClick={async () => {
                  setBusy("test");
                  setToast(null);
                  try {
                    const result = await apiPost<{ ok: boolean; simulated?: boolean }>("/billing/sola/config/test", {});
                    setToast({ kind: "ok", text: result.simulated ? "SOLA configuration test passed (simulated)" : "SOLA configuration test passed" });
                    setConfigKey((k) => k + 1);
                  } catch (err: unknown) {
                    setToast({ kind: "err", text: billingErrorMessage(err, "SOLA test failed") });
                  } finally {
                    setBusy("");
                  }
                }}
              >
                {busy === "test" ? "Testing..." : "Test configuration"}
              </button>
              {current?.isEnabled ? (
                <button
                  className="btn danger"
                  type="button"
                  disabled={!current || !!busy}
                  onClick={async () => {
                    setBusy("disable");
                    setToast(null);
                    try {
                      await apiPost("/billing/sola/config/disable", {});
                      window.location.reload();
                    } catch (err: unknown) {
                      setToast({ kind: "err", text: billingErrorMessage(err, "Could not disable SOLA") });
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  Disable
                </button>
              ) : (
                <button
                  className="btn ghost"
                  type="button"
                  disabled={!current || current?.status?.lastTestResult !== "SUCCESS" || !!busy}
                  onClick={async () => {
                    setBusy("enable");
                    setToast(null);
                    try {
                      await apiPost("/billing/sola/config/enable", {});
                      window.location.reload();
                    } catch (err: unknown) {
                      setToast({ kind: "err", text: billingErrorMessage(err, "Could not enable SOLA") });
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  Enable
                </button>
              )}
            </div>
            {!current?.isEnabled ? (
              (() => {
                const reason = !current
                  ? "Save an API key first"
                  : current.status?.lastTestResult === "FAILED"
                  ? "Last test failed — re-run Test configuration"
                  : current.status?.lastTestResult !== "SUCCESS"
                  ? "Run Test configuration first"
                  : null;
                return reason ? (
                  <p className="muted" style={{ fontSize: "0.85rem", marginTop: 6 }}>{reason}</p>
                ) : null;
              })()
            ) : null}
            {toast ? <BillingActionToast kind={toast.kind} text={toast.text} /> : null}
          </form>
        </DetailCard>
      </div>
    </PermissionGate>
  );
}
