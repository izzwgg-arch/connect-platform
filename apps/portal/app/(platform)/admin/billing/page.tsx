"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { DataTable } from "../../../../components/DataTable";
import { DetailCard } from "../../../../components/DetailCard";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { MetricCard } from "../../../../components/MetricCard";
import { PageHeader } from "../../../../components/PageHeader";
import { useAppContext } from "../../../../hooks/useAppContext";
import type { TenantDetail } from "./_components/tenantBillingConfigForms";

type TenantRow = {
  id: string;
  name: string;
  balanceDueCents: number;
  billingSettings?: any;
  paymentMethods?: any[];
  invoices?: any[];
};

function dollars(cents: number) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function worstOpenStatus(invoices: any[] | undefined): string {
  const list = invoices || [];
  const active = list.filter((i) => !["PAID", "VOID"].includes(String(i.status)));
  if (active.some((i) => i.status === "FAILED")) return "FAILED";
  if (active.some((i) => i.status === "OVERDUE")) return "OVERDUE";
  if (active.some((i) => i.status === "OPEN" || i.status === "DRAFT")) return "OPEN";
  return "—";
}

export default function AdminBillingPage() {
  const { can, backendJwtRole } = useAppContext();
  const canPlatformAdminBilling = backendJwtRole === "SUPER_ADMIN" && can("can_view_admin_billing");
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState<string>("");
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [platformToast, setPlatformToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const overview = useAsyncResource(() => apiGet<any>("/admin/billing/overview"), []);
  const runs = useAsyncResource(() => apiGet<{ runs: any[] }>("/admin/billing/runs/recent?limit=8"), []);
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
    } catch (err: any) {
      setPlatformToast({ kind: "err", text: err?.message || "Monthly run failed." });
      window.setTimeout(() => setPlatformToast(null), 5000);
    } finally {
      setBusy(null);
    }
  }

  if (!canPlatformAdminBilling) {
    return (
      <div className="state-box">
        Platform Admin Billing is only available to platform administrators (JWT role SUPER_ADMIN) with billing access. Tenant administrators should use{" "}
        <a href="/billing">Billing</a> for their own workspace.
      </div>
    );
  }

  return (
    <div className="stack compact-stack billing-admin-shell">
        <PageHeader title="Admin Billing" subtitle="Operational overview: balances, invoices, payment methods, preview, and platform monthly run. Per-tenant pricing and gateway setup live under Billing configuration." />
        {platformToast ? (
          <div className={`billing-toast billing-toast--${platformToast.kind}`} style={{ position: "relative", bottom: "auto", right: "auto", maxWidth: "100%" }} role="status">
            {platformToast.text}
          </div>
        ) : null}
        <div className="row-actions" style={{ marginBottom: -4 }}>
          <Link className="btn primary" href="/admin/billing/invoices">
            Payment Operations
          </Link>
        <Link className="btn ghost" href="/admin/billing/plans">
          Catalog plans
        </Link>
        </div>
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

        {overview.status === "success" && (overview.data.recentFailures?.length > 0) ? (
          <DetailCard title="Recent failed / overdue invoices">
            <DataTable
              rows={overview.data.recentFailures as any[]}
              columns={[
                { key: "t", label: "Tenant", render: (r) => r.tenantName || r.tenantId },
                { key: "inv", label: "Invoice", render: (r) => r.invoiceNumber || r.invoiceId },
                { key: "st", label: "Status", render: (r) => r.status },
                { key: "bal", label: "Balance", render: (r) => dollars(r.balanceDueCents) },
                { key: "fail", label: "Failed at", render: (r) => (r.failedAt ? new Date(r.failedAt).toLocaleString() : "—") },
              ]}
            />
          </DetailCard>
        ) : null}

        {runs.status === "success" && runs.data.runs?.length ? (
          <DetailCard title="Recent billing runs">
            <div className="billing-line-list">
              {runs.data.runs.map((run: any) => (
                <div key={run.id}>
                  <span>
                    <strong>{run.dryRun ? "Dry run" : "Live run"}</strong>
                    <small>
                      {run.status} · {run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}
                      {run.tenantId ? ` · tenant ${run.tenantId}` : " · all tenants"}
                    </small>
                  </span>
                  <strong>{run.finishedAt ? "Done" : "In progress"}</strong>
                </div>
              ))}
            </div>
          </DetailCard>
        ) : null}
        {runs.status === "error" ? <ErrorState message={runs.error} /> : null}

        <div className="billing-admin-grid">
          <aside className="billing-tenant-rail">
            <div className="billing-panel-head">
              <span>Tenants</span>
              <strong>{tenantRows.length}</strong>
            </div>
            <div className="billing-tenant-list">
              {tenantRows.map((tenant) => {
                const active = tenant.id === selectedTenant?.id;
                const payState = worstOpenStatus(tenant.invoices);
                const hasCard = (tenant.paymentMethods || []).length > 0;
                return (
                  <button key={tenant.id} type="button" className={`billing-tenant-item ${active ? "active" : ""}`} onClick={() => setSelectedTenantId(tenant.id)}>
                    <span>
                      <strong>{tenant.name}</strong>
                      <small>
                        Autopay {tenant.billingSettings?.autoBillingEnabled ? "on" : "off"}
                        {tenant.billingSettings?.autoBillingEnabled ? ` · day ${tenant.billingSettings.billingDayOfMonth}` : ""}
                        {" · "}Card {hasCard ? "on file" : "missing"}
                        {payState !== "—" ? ` · ${payState}` : ""}
                      </small>
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
                    <span><strong>{detail.settings?.autoBillingEnabled ? `Day ${detail.settings.billingDayOfMonth}` : "Manual"}</strong><small>Autopay</small></span>
                    <span><strong>{detail.settings?.smsBillingEnabled ? "On" : "Off"}</strong><small>SMS billing</small></span>
                    <span><strong>{detail.sola.config?.isEnabled ? "Enabled" : detail.sola.configured ? "Configured" : "Missing"}</strong><small>SOLA</small></span>
                  </div>
                </section>

                <section className="billing-setup-grid">
                  <DetailCard title="Billing configuration">
                    <p className="muted" style={{ marginBottom: 12 }}>
                      Monthly pricing, taxes, SOLA gateway, and invoice branding for this tenant are on Admin Billing Settings.
                    </p>
                    <div className="row-actions">
                      <Link className="btn primary" href={`/admin/billing/settings?tenantId=${encodeURIComponent(detail.tenant.id)}`}>
                        Open billing settings
                      </Link>
                    </div>
                  </DetailCard>
                  <PaymentMethodsCard detail={detail} />
                </section>

                <section className="billing-setup-grid">
                  <InvoicePreviewCard detail={detail} setBusy={setBusy} busy={busy} onSaved={() => loadDetail(detail.tenant.id)} />
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
  );
}

function InvoicePreviewCard({ detail, busy, setBusy, onSaved }: { detail: TenantDetail; busy: string | null; setBusy: (v: string | null) => void; onSaved: () => void }) {
  const preview = detail.preview;
  const pr = preview?.pricingResolution;
  return (
    <DetailCard title="Invoice Preview">
      {pr?.banner ? (
        <div className="billing-status-pill" style={{ marginBottom: 12, fontSize: 12, whiteSpace: "normal", lineHeight: 1.45, textAlign: "left" }}>
          <strong>Pricing:</strong> {pr.banner}
        </div>
      ) : null}
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
  const [logInvoiceId, setLogInvoiceId] = useState<string | null>(null);
  const [logEvents, setLogEvents] = useState<{ id: string; type: string; message: string | null; createdAt: string; metadata?: unknown }[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState("");

  async function toggleLog(invoiceId: string) {
    if (logInvoiceId === invoiceId) {
      setLogInvoiceId(null);
      return;
    }
    setLogInvoiceId(invoiceId);
    setLogLoading(true);
    setLogError("");
    setLogEvents([]);
    try {
      const res = await apiGet<{ events: any[] }>(`/admin/billing/invoices/${invoiceId}/events`);
      setLogEvents(res.events || []);
    } catch (err: any) {
      setLogError(err?.message || "Unable to load billing events.");
    } finally {
      setLogLoading(false);
    }
  }

  return (
    <DetailCard title="Recent Invoices">
      {detail.invoices.length === 0 ? <p className="muted">No invoices yet for this tenant.</p> : null}
      <div className="billing-invoice-stack">
        {detail.invoices.map((invoice) => (
          <div className="billing-invoice-row" key={invoice.id} style={{ flexWrap: "wrap" }}>
            <span><strong>{invoice.invoiceNumber}</strong><small>{invoice.status} · due {new Date(invoice.dueDate).toLocaleDateString()}</small></span>
            <em>{dollars(invoice.totalCents)}</em>
            <div className="row-actions">
              <button className="btn ghost" type="button" disabled={!!busy} onClick={() => { void toggleLog(invoice.id); }}>{logInvoiceId === invoice.id ? "Hide log" : "Activity"}</button>
              <button className="btn ghost" type="button" disabled={!!busy} onClick={async () => { setBusy(`send-${invoice.id}`); try { await apiPost(`/admin/billing/invoices/${invoice.id}/send`, {}); onSaved(); } finally { setBusy(null); } }}>Send</button>
              {invoice.status !== "PAID" && invoice.status !== "VOID" ? <button className="btn ghost" type="button" disabled={!!busy} onClick={async () => { setBusy(`paid-${invoice.id}`); try { await apiPost(`/admin/billing/invoices/${invoice.id}/mark-paid`, {}); onSaved(); } finally { setBusy(null); } }}>Mark Paid</button> : null}
              {invoice.status !== "PAID" && invoice.status !== "VOID" && (detail.settings?.defaultPaymentMethodId || (detail.paymentMethods?.length ?? 0) > 0) ? (
                <button
                  className="btn ghost"
                  type="button"
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy(`retry-${invoice.id}`);
                    try {
                      await apiPost(`/admin/billing/invoices/${invoice.id}/retry-payment`, {});
                      onSaved();
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === `retry-${invoice.id}` ? "Charging…" : "Charge card"}
                </button>
              ) : null}
              {invoice.status !== "PAID" && invoice.status !== "VOID" ? <button className="btn danger" type="button" disabled={!!busy} onClick={async () => { setBusy(`void-${invoice.id}`); try { await apiPost(`/admin/billing/invoices/${invoice.id}/void`, {}); onSaved(); } finally { setBusy(null); } }}>Void</button> : null}
            </div>
            {logInvoiceId === invoice.id ? (
              <div style={{ width: "100%", marginTop: 10 }}>
                {logLoading ? <p className="muted">Loading events…</p> : null}
                {logError ? <ErrorState message={logError} /> : null}
                {!logLoading && !logError && logEvents.length === 0 ? <p className="muted">No BillingEventLog rows for this invoice.</p> : null}
                {!logLoading && !logError && logEvents.length > 0 ? (
                  <DataTable
                    rows={logEvents}
                    columns={[
                      { key: "c", label: "Time", render: (r) => new Date(r.createdAt).toLocaleString() },
                      { key: "t", label: "Type", render: (r) => r.type },
                      { key: "m", label: "Detail", render: (r) => r.message || (r.metadata ? JSON.stringify(r.metadata) : "—") },
                    ]}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </DetailCard>
  );
}
