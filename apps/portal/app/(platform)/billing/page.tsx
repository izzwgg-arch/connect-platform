"use client";

import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { apiGet } from "../../../services/apiClient";
import { DetailCard } from "../../../components/DetailCard";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { MetricCard } from "../../../components/MetricCard";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";

function dollars(cents: number) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

export default function BillingOverviewPage() {
  const settings = useAsyncResource(() => apiGet<any>("/billing/settings"), []);
  const usage = useAsyncResource(() => apiGet<any>("/billing/usage/current"), []);
  const invoices = useAsyncResource(() => apiGet<any[]>("/billing/platform/invoices"), []);

  const openBalance = invoices.status === "success"
    ? invoices.data.reduce((sum, invoice) => sum + Number(invoice.balanceDueCents || 0), 0)
    : 0;
  const latestInvoice = invoices.status === "success" ? invoices.data[0] : null;

  return (
    <PermissionGate permission="can_view_reports" fallback={<div className="state-box">You do not have billing access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="Billing Overview" subtitle="ConnectComms subscription usage, invoices, and payment status." />
        {[settings, usage, invoices].some((r) => r.status === "loading") ? <LoadingSkeleton rows={4} /> : null}
        {settings.status === "error" ? <ErrorState message={settings.error} /> : null}
        {usage.status === "error" ? <ErrorState message={usage.error} /> : null}
        {invoices.status === "error" ? <ErrorState message={invoices.error} /> : null}
        {usage.status === "success" && invoices.status === "success" ? (
          <section className="metric-grid">
            <MetricCard label="Current Balance" value={dollars(openBalance)} />
            <MetricCard label="Billable Extensions" value={String(usage.data.extensionCount || 0)} />
            <MetricCard label="Phone Numbers" value={String(usage.data.phoneNumberCount || 0)} />
            <MetricCard label="SMS Package" value={usage.data.smsEnabled ? "Enabled" : "Off"} />
          </section>
        ) : null}
        <DetailCard title="Plan And Billing Settings">
          {settings.status === "success" ? (
            <div className="kv-grid">
              <span>Extension price</span><strong>{dollars(settings.data.extensionPriceCents)}</strong>
              <span>Additional number</span><strong>{dollars(settings.data.additionalPhoneNumberPriceCents)}</strong>
              <span>SMS package</span><strong>{dollars(settings.data.smsPriceCents)}</strong>
              <span>Taxes</span><strong>{settings.data.taxEnabled ? "Enabled" : "Disabled"}</strong>
              <span>Auto billing</span><strong>{settings.data.autoBillingEnabled ? `Day ${settings.data.billingDayOfMonth}` : "Manual"}</strong>
            </div>
          ) : null}
        </DetailCard>
        <DetailCard title="Latest Invoice">
          {latestInvoice ? (
            <p className="muted">
              {latestInvoice.invoiceNumber} is {String(latestInvoice.status).toLowerCase()} with a balance of {dollars(latestInvoice.balanceDueCents)}.
            </p>
          ) : (
            <p className="muted">No ConnectComms invoices have been generated for this tenant yet.</p>
          )}
        </DetailCard>
      </div>
    </PermissionGate>
  );
}
