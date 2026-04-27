"use client";

import Link from "next/link";
import { useState } from "react";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost, apiPut } from "../../../../services/apiClient";
import { DetailCard } from "../../../../components/DetailCard";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";

export default function SettingsBillingPage() {
  const [busy, setBusy] = useState("");
  const config = useAsyncResource(() => apiGet<any>("/billing/sola/config"), []);
  const current = config.status === "success" ? config.data?.config : null;

  return (
    <PermissionGate permission="can_view_settings" fallback={<div className="state-box">You do not have billing settings access.</div>}>
      <div className="stack compact-stack billing-admin-shell">
        <PageHeader title="Billing Settings" subtitle="Tenant SOLA/Cardknox credentials and customer billing workspace." />
        <section className="billing-tenant-hero">
          <div>
            <span className="eyebrow">Billing workspace</span>
            <h2>SOLA payment setup</h2>
            <p className="muted">Configure this tenant's SOLA gateway here, or use Admin Billing to set up every tenant from one place.</p>
            <div className="row-actions">
              <Link className="btn primary" href="/billing">Open Tenant Billing</Link>
              <Link className="btn ghost" href="/admin/billing">Admin Billing Console</Link>
            </div>
          </div>
          <div className="billing-hero-metrics">
            <span><strong>{current?.isEnabled ? "Enabled" : current ? "Configured" : "Missing"}</strong><small>SOLA status</small></span>
            <span><strong>{current?.mode || "sandbox"}</strong><small>Mode</small></span>
          </div>
        </section>
        {config.status === "loading" ? <LoadingSkeleton rows={4} /> : null}
        {config.status === "error" ? <ErrorState message={config.error} /> : null}
        <DetailCard title="This Tenant SOLA Gateway">
          <form className="billing-form" onSubmit={async (event) => {
            event.preventDefault();
            setBusy("save");
            try {
              const form = new FormData(event.currentTarget);
              await apiPut("/billing/sola/config", {
                apiBaseUrl: String(form.get("apiBaseUrl") || "https://x1.cardknox.com"),
                mode: String(form.get("mode") || "sandbox"),
                simulate: form.get("simulate") === "on",
                authMode: String(form.get("authMode") || "xkey_body"),
                authHeaderName: String(form.get("authHeaderName") || "") || null,
                apiKey: String(form.get("apiKey") || "") || undefined,
                apiSecret: String(form.get("apiSecret") || "") || undefined,
                webhookSecret: String(form.get("webhookSecret") || "") || undefined,
                ifieldsKey: String(form.get("ifieldsKey") || "") || undefined,
                pathOverrides: { transactionPath: String(form.get("transactionPath") || "/gatewayjson") },
              });
              window.location.reload();
            } finally {
              setBusy("");
            }
          }}>
            <div className={`billing-status-pill ${current?.isEnabled ? "good" : current ? "warn" : "bad"}`}>
              {current?.isEnabled ? "Enabled" : current ? "Configured but disabled" : "Not configured"}
            </div>
            <label>Gateway URL <input name="apiBaseUrl" defaultValue={current?.apiBaseUrl || "https://x1.cardknox.com"} /></label>
            <label>Transaction path <input name="transactionPath" defaultValue={current?.pathOverrides?.transactionPath || "/gatewayjson"} /></label>
            <label>Mode
              <select name="mode" defaultValue={current?.mode || "sandbox"}>
                <option value="sandbox">Sandbox</option>
                <option value="prod">Production</option>
              </select>
            </label>
            <label>Auth mode
              <select name="authMode" defaultValue={current?.authMode || "xkey_body"}>
                <option value="xkey_body">xKey in body</option>
                <option value="authorization_header">Authorization header</option>
              </select>
            </label>
            <label>Auth header name <input name="authHeaderName" defaultValue={current?.authHeaderName || ""} placeholder="authorization" /></label>
            <label>API key <input name="apiKey" placeholder={current?.masked?.apiKey || "Enter SOLA/Cardknox API key"} /></label>
            <label>iFields public key <input name="ifieldsKey" placeholder={current?.masked?.ifieldsKey || "Public key for secure card fields"} /></label>
            <label>API secret <input name="apiSecret" type="password" placeholder={current?.masked?.apiSecret || "Optional"} /></label>
            <label>Webhook PIN/secret <input name="webhookSecret" type="password" placeholder={current?.masked?.webhookSecret || "For ck-signature verification"} /></label>
            <label className="billing-checkbox"><input name="simulate" type="checkbox" defaultChecked={!!current?.simulate} /> Simulate gateway responses</label>
            <div className="row-actions">
              <button className="btn primary" type="submit" disabled={!!busy}>{busy === "save" ? "Saving..." : "Save SOLA"}</button>
              <button className="btn ghost" type="button" disabled={!current || !!busy} onClick={async () => { setBusy("test"); try { await apiPost("/billing/sola/config/test", {}); window.location.reload(); } finally { setBusy(""); } }}>{busy === "test" ? "Testing..." : "Test"}</button>
              {current?.isEnabled ? (
                <button className="btn danger" type="button" disabled={!current || !!busy} onClick={async () => { setBusy("disable"); try { await apiPost("/billing/sola/config/disable", {}); window.location.reload(); } finally { setBusy(""); } }}>Disable</button>
              ) : (
                <button className="btn ghost" type="button" disabled={!current || current?.status?.lastTestResult !== "SUCCESS" || !!busy} onClick={async () => { setBusy("enable"); try { await apiPost("/billing/sola/config/enable", {}); window.location.reload(); } finally { setBusy(""); } }}>Enable</button>
              )}
            </div>
          </form>
        </DetailCard>
      </div>
    </PermissionGate>
  );
}
