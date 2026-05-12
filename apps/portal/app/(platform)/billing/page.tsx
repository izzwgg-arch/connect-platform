"use client";

import Link from "next/link";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { apiGet } from "../../../services/apiClient";
import { DetailCard } from "../../../components/DetailCard";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { MetricCard } from "../../../components/MetricCard";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { dunningHintFromInvoice, dollars, lastPaidSummary, nextBillingSummary, worstOpenInvoice } from "../../../lib/billingUi";

export default function BillingOverviewPage() {
  const settings = useAsyncResource(() => apiGet<any>("/billing/settings"), []);
  const usage = useAsyncResource(() => apiGet<any>("/billing/usage/current"), []);
  const invoices = useAsyncResource(() => apiGet<any[]>("/billing/platform/invoices"), []);

  const openBalance = invoices.status === "success"
    ? invoices.data.reduce((sum, invoice) => sum + Number(invoice.balanceDueCents || 0), 0)
    : 0;
  const latestInvoice = invoices.status === "success" ? invoices.data[0] : null;
  const worst = invoices.status === "success" ? worstOpenInvoice(invoices.data) : null;
  const lastPaid = invoices.status === "success" ? lastPaidSummary(invoices.data) : null;
  const dunning = worst ? dunningHintFromInvoice(worst) : null;
  const nextBill =
    settings.status === "success"
      ? nextBillingSummary(settings.data.billingDayOfMonth, !!settings.data.autoBillingEnabled)
      : null;

  return (
    <PermissionGate permission="can_view_billing_overview" fallback={<div className="state-box">You do not have billing access.</div>}>
      <div className="stack compact-stack billing-admin-shell">
          <PageHeader title="Billing Overview" subtitle="Invoice status, balance, autopay, and payment readiness for this workspace." />
          {[settings, usage, invoices].some((r) => r.status === "loading") ? <LoadingSkeleton rows={4} /> : null}
          {settings.status === "error" ? <ErrorState message={settings.error} /> : null}
          {usage.status === "error" ? <ErrorState message={usage.error} /> : null}
          {invoices.status === "error" ? <ErrorState message={invoices.error} /> : null}
          {usage.status === "success" && settings.status === "success" ? (
            <section className="billing-tenant-hero">
              <div>
                <span className="eyebrow">ConnectComms subscription</span>
                <h2>{dollars(openBalance)} balance due</h2>
                <p className="muted">
                  Open balance sums unpaid amounts on all non-void invoices. Autopay charges the default card on the billing day when enabled.
                </p>
                {worst ? (
                  <p className={`billing-status-pill ${worst.status === "FAILED" || worst.status === "OVERDUE" ? "bad" : "warn"}`} style={{ display: "inline-flex", marginTop: 8 }}>
                    Priority invoice: {worst.invoiceNumber} · {worst.status}
                    {worst.balanceDueCents ? ` · ${dollars(worst.balanceDueCents)} due` : ""}
                  </p>
                ) : null}
                {dunning ? <p className="muted" style={{ marginTop: 8 }}>{dunning}</p> : null}
                <div className="row-actions">
                  <Link className="btn primary" href="/billing/invoices">View Invoices</Link>
                  <Link className="btn ghost" href="/billing/payments">Manage Payment Method</Link>
                  <PermissionGate permission="can_view_settings_billing" fallback={null}>
                    <Link className="btn ghost" href="/billing/settings">
                      Billing Settings
                    </Link>
                  </PermissionGate>
                </div>
                {nextBill ? <p className="muted" style={{ marginTop: 12, maxWidth: 520 }}>{nextBill}</p> : null}
              </div>
              <div className="billing-hero-metrics">
                <span>
                  <strong>{settings.data.autoBillingEnabled ? `Day ${settings.data.billingDayOfMonth}` : "Manual"}</strong>
                  <small>Autopay</small>
                </span>
                <span>
                  <strong>{settings.data.defaultPaymentMethodId ? "On file" : "None"}</strong>
                  <small>Default card</small>
                </span>
              </div>
            </section>
          ) : null}
          {usage.status === "success" && invoices.status === "success" ? (
            <p className="muted" style={{ marginTop: -4 }}>
              {lastPaid ? <>Last payment: {lastPaid}.</> : <>No paid invoices recorded yet.</>}
            </p>
          ) : null}
          {usage.status === "success" && invoices.status === "success" ? (
            <section className="metric-grid">
              <MetricCard label="Balance due" value={dollars(openBalance)} />
              <MetricCard label="Latest invoice status" value={latestInvoice ? String(latestInvoice.status) : "—"} />
              <MetricCard label="Autopay" value={settings.status === "success" && settings.data.autoBillingEnabled ? "On" : "Off"} />
              <MetricCard label="Billable extensions" value={String(usage.data.extensionCount || 0)} />
              <MetricCard label="Phone numbers" value={String(usage.data.phoneNumberCount || 0)} />
              <MetricCard label="SMS package" value={usage.data.smsEnabled ? "Enabled" : "Off"} />
            </section>
          ) : null}
          <section className="billing-setup-grid">
            <DetailCard title="Latest invoice">
              {latestInvoice ? (
                <div className="billing-preview-total">
                  <span>
                    {latestInvoice.invoiceNumber}
                    <small>
                      {String(latestInvoice.status).toLowerCase()} · due {new Date(latestInvoice.dueDate).toLocaleDateString()}
                    </small>
                  </span>
                  <strong>{dollars(latestInvoice.balanceDueCents)}</strong>
                  <Link className="btn ghost" href={`/billing/invoices/${latestInvoice.id}`}>Open</Link>
                </div>
              ) : (
                <p className="muted">No ConnectComms invoices have been generated for this tenant yet.</p>
              )}
            </DetailCard>
          </section>
      </div>
    </PermissionGate>
  );
}
