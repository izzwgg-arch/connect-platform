"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost, apiPut } from "../../../../services/apiClient";
import { DetailCard } from "../../../../components/DetailCard";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { MetricCard } from "../../../../components/MetricCard";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";

type TenantRow = {
  id: string;
  name: string;
  balanceDueCents: number;
  billingSettings?: any;
  paymentMethods?: any[];
  invoices?: any[];
};

type TenantDetail = {
  tenant: { id: string; name: string; createdAt: string };
  settings: any;
  usage: any;
  preview: any;
  invoices: any[];
  paymentMethods: any[];
  taxProfiles: any[];
  sola: { configured: boolean; config: any | null; decryptFailed?: boolean };
};

function dollars(cents: number) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function toDollars(cents: number | undefined | null) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function toCents(value: FormDataEntryValue | null) {
  const n = Number(String(value || "0").replace(/[^0-9. -]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export default function AdminBillingPage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState<string>("");
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const overview = useAsyncResource(() => apiGet<any>("/admin/billing/overview"), []);
  const tenants = useAsyncResource<TenantRow[]>(() => apiGet<TenantRow[]>("/admin/billing/platform/tenants"), []);
  const tenantRows = tenants.status === "success" ? tenants.data : [];
  const selectedTenant = tenantRows.find((tenant) => tenant.id === selectedTenantId) || tenantRows[0] || null;

  const loadDetail = useCallback(async (tenantId: string) => {
    if (!tenantId) return;
    setDetailLoading(true);
    setDetailError("");
    try {
      setDetail(await apiGet<TenantDetail>(`/admin/billing/platform/tenants/${tenantId}`));
    } catch (err: any) {
      setDetailError(err?.message || "Unable to load tenant billing detail.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedTenantId && tenantRows[0]?.id) {
      setSelectedTenantId(tenantRows[0].id);
    }
  }, [selectedTenantId, tenantRows]);

  useEffect(() => {
    if (selectedTenantId) void loadDetail(selectedTenantId);
  }, [loadDetail, selectedTenantId]);

  const projectedMrr = useMemo(() => {
    if (!detail?.preview) return 0;
    return Number(detail.preview.totalCents || 0);
  }, [detail]);

  async function runMonthly(dryRun: boolean) {
    setBusy(dryRun ? "dry-run" : "monthly");
    try {
      await apiPost("/admin/billing/runs/monthly", { dryRun });
      window.location.reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <PermissionGate permission="can_view_admin" fallback={<div className="state-box">You do not have admin billing access.</div>}>
      <div className="stack compact-stack billing-admin-shell">
        <PageHeader title="Admin Billing" subtitle="Set every tenant's SOLA gateway, monthly pricing, taxes, auto-billing, invoices, and payment status." />
        {overview.status === "loading" || tenants.status === "loading" ? <LoadingSkeleton rows={4} /> : null}
        {overview.status === "error" ? <ErrorState message={overview.error} /> : null}
        {tenants.status === "error" ? <ErrorState message={tenants.error} /> : null}
        {overview.status === "success" ? (
          <section className="metric-grid">
            <MetricCard label="MRR" value={dollars(overview.data.mrrCents)} />
            <MetricCard label="Open Balance" value={dollars(overview.data.openCents)} />
            <MetricCard label="Failed" value={String(overview.data.counts?.failed || 0)} />
            <MetricCard label="No Card" value={String(overview.data.counts?.tenantsWithoutCards || 0)} />
          </section>
        ) : null}

        <div className="billing-admin-grid">
          <aside className="billing-tenant-rail">
            <div className="billing-panel-head">
              <span>Tenants</span>
              <strong>{tenantRows.length}</strong>
            </div>
            <div className="billing-tenant-list">
              {tenantRows.map((tenant) => {
                const active = tenant.id === selectedTenant?.id;
                return (
                  <button key={tenant.id} type="button" className={`billing-tenant-item ${active ? "active" : ""}`} onClick={() => setSelectedTenantId(tenant.id)}>
                    <span>
                      <strong>{tenant.name}</strong>
                      <small>{tenant.billingSettings?.autoBillingEnabled ? `Auto day ${tenant.billingSettings.billingDayOfMonth}` : "Manual billing"}</small>
                    </span>
                    <em>{dollars(tenant.balanceDueCents || 0)}</em>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="billing-tenant-workspace">
            {detailLoading ? <LoadingSkeleton rows={6} /> : null}
            {detailError ? <ErrorState message={detailError} /> : null}
            {detail ? (
              <>
                <section className="billing-tenant-hero">
                  <div>
                    <span className="eyebrow">Tenant billing setup</span>
                    <h2>{detail.tenant.name}</h2>
                    <p className="muted">Projected monthly total is based on current billable usage, pricing, SMS, credits, and tax settings.</p>
                  </div>
                  <div className="billing-hero-metrics">
                    <span><strong>{dollars(projectedMrr)}</strong><small>Projected monthly</small></span>
                    <span><strong>{detail.usage.extensionCount}</strong><small>Extensions</small></span>
                    <span><strong>{detail.usage.phoneNumberCount}</strong><small>Numbers</small></span>
                    <span><strong>{detail.sola.config?.isEnabled ? "Enabled" : detail.sola.configured ? "Configured" : "Missing"}</strong><small>SOLA</small></span>
                  </div>
                </section>

                <section className="billing-setup-grid">
                  <BillingSettingsForm detail={detail} onSaved={() => loadDetail(detail.tenant.id)} />
                  <SolaSettingsForm detail={detail} onSaved={() => loadDetail(detail.tenant.id)} />
                </section>

                <section className="billing-setup-grid">
                  <InvoicePreviewCard detail={detail} setBusy={setBusy} busy={busy} onSaved={() => loadDetail(detail.tenant.id)} />
                  <PaymentMethodsCard detail={detail} />
                </section>

                <RecentInvoicesCard detail={detail} setBusy={setBusy} busy={busy} onSaved={() => loadDetail(detail.tenant.id)} />
              </>
            ) : null}
          </main>
        </div>

        <DetailCard title="Platform Monthly Run">
          <p className="muted">Dry-run previews the billing batch. Real run creates invoices and charges default SOLA cards only for tenants with auto billing enabled.</p>
          <div className="row-actions">
            <button className="btn ghost" type="button" disabled={!!busy} onClick={() => runMonthly(true)}>{busy === "dry-run" ? "Running..." : "Dry Run All Tenants"}</button>
            <button className="btn primary" type="button" disabled={!!busy} onClick={() => runMonthly(false)}>{busy === "monthly" ? "Running..." : "Run Monthly Billing"}</button>
          </div>
        </DetailCard>
      </div>
    </PermissionGate>
  );
}

function BillingSettingsForm({ detail, onSaved }: { detail: TenantDetail; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const settings = detail.settings || {};
  return (
    <DetailCard title="Monthly Pricing">
      <form className="billing-form" onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        try {
          const form = new FormData(event.currentTarget);
          await apiPut(`/admin/billing/tenants/${detail.tenant.id}/settings`, {
            extensionPriceCents: toCents(form.get("extensionPrice")),
            additionalPhoneNumberPriceCents: toCents(form.get("numberPrice")),
            smsPriceCents: toCents(form.get("smsPrice")),
            firstPhoneNumberFree: form.get("firstPhoneNumberFree") === "on",
            smsBillingEnabled: form.get("smsBillingEnabled") === "on",
            taxEnabled: form.get("taxEnabled") === "on",
            taxProfileId: String(form.get("taxProfileId") || "") || null,
            autoBillingEnabled: form.get("autoBillingEnabled") === "on",
            billingDayOfMonth: Number(form.get("billingDayOfMonth") || 1),
            paymentTermsDays: Number(form.get("paymentTermsDays") || 15),
            billingEmail: String(form.get("billingEmail") || "") || null,
            creditsCents: toCents(form.get("credits")),
          });
          onSaved();
        } finally {
          setSaving(false);
        }
      }}>
        <label>Per extension <input name="extensionPrice" defaultValue={toDollars(settings.extensionPriceCents)} /></label>
        <label>Additional phone number <input name="numberPrice" defaultValue={toDollars(settings.additionalPhoneNumberPriceCents)} /></label>
        <label>SMS package <input name="smsPrice" defaultValue={toDollars(settings.smsPriceCents)} /></label>
        <label>Billing email <input name="billingEmail" type="email" defaultValue={settings.billingEmail || ""} placeholder="billing@tenant.com" /></label>
        <label>Billing day <input name="billingDayOfMonth" type="number" min={1} max={28} defaultValue={settings.billingDayOfMonth || 1} /></label>
        <label>Payment terms <input name="paymentTermsDays" type="number" min={0} max={90} defaultValue={settings.paymentTermsDays || 15} /></label>
        <label>Credits this month <input name="credits" defaultValue={toDollars(settings.creditsCents)} /></label>
        <label>Tax profile
          <select name="taxProfileId" defaultValue={settings.taxProfileId || ""}>
            <option value="">No tax profile</option>
            {detail.taxProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>
        <div className="billing-check-grid">
          <label><input name="firstPhoneNumberFree" type="checkbox" defaultChecked={settings.firstPhoneNumberFree !== false} /> First number free</label>
          <label><input name="smsBillingEnabled" type="checkbox" defaultChecked={!!settings.smsBillingEnabled} /> Bill SMS package</label>
          <label><input name="taxEnabled" type="checkbox" defaultChecked={!!settings.taxEnabled} /> Apply taxes/fees</label>
          <label><input name="autoBillingEnabled" type="checkbox" defaultChecked={!!settings.autoBillingEnabled} /> Auto-charge monthly</label>
        </div>
        <button className="btn primary" type="submit" disabled={saving}>{saving ? "Saving..." : "Save Pricing"}</button>
      </form>
    </DetailCard>
  );
}

function SolaSettingsForm({ detail, onSaved }: { detail: TenantDetail; onSaved: () => void }) {
  const [busy, setBusy] = useState("");
  const config = detail.sola.config;
  return (
    <DetailCard title="SOLA Gateway">
      <form className="billing-form" onSubmit={async (event) => {
        event.preventDefault();
        setBusy("save");
        try {
          const form = new FormData(event.currentTarget);
          await apiPut(`/admin/billing/platform/tenants/${detail.tenant.id}/sola-config`, {
            apiBaseUrl: String(form.get("apiBaseUrl") || "https://x1.cardknox.com"),
            mode: String(form.get("mode") || "sandbox"),
            simulate: form.get("simulate") === "on",
            authMode: String(form.get("authMode") || "xkey_body"),
            authHeaderName: String(form.get("authHeaderName") || "") || null,
            apiKey: String(form.get("apiKey") || "") || undefined,
            apiSecret: String(form.get("apiSecret") || "") || undefined,
            webhookSecret: String(form.get("webhookSecret") || "") || undefined,
            ifieldsKey: String(form.get("ifieldsKey") || "") || undefined,
            pathOverrides: {
              transactionPath: String(form.get("transactionPath") || "/gatewayjson"),
              hostedSessionPath: String(form.get("hostedSessionPath") || ""),
              chargePath: String(form.get("chargePath") || ""),
            },
          });
          onSaved();
        } finally {
          setBusy("");
        }
      }}>
        <div className={`billing-status-pill ${config?.isEnabled ? "good" : config ? "warn" : "bad"}`}>
          {config?.isEnabled ? "Enabled" : config ? "Configured but disabled" : "Not configured"}
          {config?.status?.lastTestResult ? ` · Last test ${config.status.lastTestResult}` : ""}
        </div>
        <label>Gateway URL <input name="apiBaseUrl" defaultValue={config?.apiBaseUrl || "https://x1.cardknox.com"} /></label>
        <label>Transaction path <input name="transactionPath" defaultValue={config?.pathOverrides?.transactionPath || "/gatewayjson"} /></label>
        <label>Hosted session path <input name="hostedSessionPath" defaultValue={config?.pathOverrides?.hostedSessionPath || ""} placeholder="Optional" /></label>
        <label>Charge path <input name="chargePath" defaultValue={config?.pathOverrides?.chargePath || ""} placeholder="Optional legacy path" /></label>
        <label>Mode
          <select name="mode" defaultValue={config?.mode || "sandbox"}>
            <option value="sandbox">Sandbox</option>
            <option value="prod">Production</option>
          </select>
        </label>
        <label>Auth mode
          <select name="authMode" defaultValue={config?.authMode || "xkey_body"}>
            <option value="xkey_body">xKey in body</option>
            <option value="authorization_header">Authorization header</option>
          </select>
        </label>
        <label>Auth header name <input name="authHeaderName" defaultValue={config?.authHeaderName || ""} placeholder="authorization" /></label>
        <label>API key <input name="apiKey" placeholder={config?.masked?.apiKey || "Enter SOLA/Cardknox API key"} /></label>
        <label>iFields public key <input name="ifieldsKey" placeholder={config?.masked?.ifieldsKey || "Public key for hosted card fields"} /></label>
        <label>API secret <input name="apiSecret" type="password" placeholder={config?.masked?.apiSecret || "Optional"} /></label>
        <label>Webhook PIN/secret <input name="webhookSecret" type="password" placeholder={config?.masked?.webhookSecret || "For ck-signature verification"} /></label>
        <label className="billing-checkbox"><input name="simulate" type="checkbox" defaultChecked={!!config?.simulate} /> Simulate gateway responses</label>
        <div className="row-actions">
          <button className="btn primary" type="submit" disabled={!!busy}>{busy === "save" ? "Saving..." : "Save SOLA"}</button>
          <button className="btn ghost" type="button" disabled={!config || !!busy} onClick={async () => { setBusy("test"); try { await apiPost(`/admin/billing/platform/tenants/${detail.tenant.id}/sola-config/test`, {}); onSaved(); } finally { setBusy(""); } }}>{busy === "test" ? "Testing..." : "Test"}</button>
          {config?.isEnabled ? (
            <button className="btn danger" type="button" disabled={!!busy} onClick={async () => { setBusy("disable"); try { await apiPost(`/admin/billing/platform/tenants/${detail.tenant.id}/sola-config/disable`, {}); onSaved(); } finally { setBusy(""); } }}>Disable</button>
          ) : (
            <button className="btn ghost" type="button" disabled={!config || config?.status?.lastTestResult !== "SUCCESS" || !!busy} onClick={async () => { setBusy("enable"); try { await apiPost(`/admin/billing/platform/tenants/${detail.tenant.id}/sola-config/enable`, {}); onSaved(); } finally { setBusy(""); } }}>Enable</button>
          )}
        </div>
      </form>
    </DetailCard>
  );
}

function InvoicePreviewCard({ detail, busy, setBusy, onSaved }: { detail: TenantDetail; busy: string | null; setBusy: (v: string | null) => void; onSaved: () => void }) {
  const preview = detail.preview;
  return (
    <DetailCard title="Invoice Preview">
      <div className="billing-preview-total">
        <span>Monthly amount</span>
        <strong>{dollars(preview.totalCents)}</strong>
        <small>Subtotal {dollars(preview.subtotalCents)} · Taxes/fees {dollars(preview.taxCents)}</small>
      </div>
      <div className="billing-line-list">
        {preview.lineItems.map((item: any) => (
          <div key={`${item.type}-${item.description}`}>
            <span>{item.description}<small>{item.quantity} × {dollars(item.unitPriceCents)}</small></span>
            <strong>{dollars(item.amountCents)}</strong>
          </div>
        ))}
      </div>
      <div className="row-actions">
        <button className="btn primary" type="button" disabled={!!busy} onClick={async () => { setBusy("generate"); try { await apiPost(`/admin/billing/tenants/${detail.tenant.id}/invoices`, {}); onSaved(); } finally { setBusy(null); } }}>{busy === "generate" ? "Generating..." : "Generate Invoice"}</button>
        <button className="btn ghost" type="button" disabled={!!busy} onClick={async () => { setBusy("run-one"); try { await apiPost("/admin/billing/runs/monthly", { dryRun: false, tenantId: detail.tenant.id }); onSaved(); } finally { setBusy(null); } }}>Run This Tenant</button>
      </div>
    </DetailCard>
  );
}

function PaymentMethodsCard({ detail }: { detail: TenantDetail }) {
  return (
    <DetailCard title="Payment Methods">
      {detail.paymentMethods.length === 0 ? (
        <p className="muted">No saved cards yet. Tenant admins can add a tokenized SOLA card from Billing → Payments.</p>
      ) : (
        <div className="billing-line-list">
          {detail.paymentMethods.map((method) => (
            <div key={method.id}>
              <span>{method.brand || "Card"} ending {method.last4 || "----"}<small>{method.cardholderName || "No cardholder"} · exp {[method.expMonth, method.expYear].filter(Boolean).join("/") || "-"}</small></span>
              <strong>{method.isDefault ? "Default" : "Backup"}</strong>
            </div>
          ))}
        </div>
      )}
    </DetailCard>
  );
}

function RecentInvoicesCard({ detail, busy, setBusy, onSaved }: { detail: TenantDetail; busy: string | null; setBusy: (v: string | null) => void; onSaved: () => void }) {
  return (
    <DetailCard title="Recent Invoices">
      {detail.invoices.length === 0 ? <p className="muted">No invoices yet for this tenant.</p> : null}
      <div className="billing-invoice-stack">
        {detail.invoices.map((invoice) => (
          <div className="billing-invoice-row" key={invoice.id}>
            <span><strong>{invoice.invoiceNumber}</strong><small>{invoice.status} · due {new Date(invoice.dueDate).toLocaleDateString()}</small></span>
            <em>{dollars(invoice.totalCents)}</em>
            <div className="row-actions">
              <button className="btn ghost" type="button" disabled={!!busy} onClick={async () => { setBusy(`send-${invoice.id}`); try { await apiPost(`/admin/billing/invoices/${invoice.id}/send`, {}); onSaved(); } finally { setBusy(null); } }}>Send</button>
              {invoice.status !== "PAID" && invoice.status !== "VOID" ? <button className="btn ghost" type="button" disabled={!!busy} onClick={async () => { setBusy(`paid-${invoice.id}`); try { await apiPost(`/admin/billing/invoices/${invoice.id}/mark-paid`, {}); onSaved(); } finally { setBusy(null); } }}>Mark Paid</button> : null}
              {invoice.status !== "PAID" && invoice.status !== "VOID" ? <button className="btn danger" type="button" disabled={!!busy} onClick={async () => { setBusy(`void-${invoice.id}`); try { await apiPost(`/admin/billing/invoices/${invoice.id}/void`, {}); onSaved(); } finally { setBusy(null); } }}>Void</button> : null}
            </div>
          </div>
        ))}
      </div>
    </DetailCard>
  );
}
