"use client";

import { useState } from "react";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { DataTable } from "../../../../components/DataTable";
import { DetailCard } from "../../../../components/DetailCard";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { MetricCard } from "../../../../components/MetricCard";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";

function dollars(cents: number) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

export default function AdminBillingPage() {
  const [busy, setBusy] = useState<string | null>(null);
  const overview = useAsyncResource(() => apiGet<any>("/admin/billing/overview"), []);
  const tenants = useAsyncResource(() => apiGet<any[]>("/admin/billing/platform/tenants"), []);
  const rows = tenants.status === "success"
    ? tenants.data.map((tenant) => ({
        id: tenant.id,
        name: tenant.name,
        balance: dollars(tenant.balanceDueCents || 0),
        card: tenant.paymentMethods?.length ? "On file" : "Missing",
        autoBilling: tenant.billingSettings?.autoBillingEnabled ? `Day ${tenant.billingSettings.billingDayOfMonth}` : "Manual",
        latestInvoice: tenant.invoices?.[0]?.invoiceNumber || "-"
      }))
    : [];

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
      <div className="stack compact-stack">
        <PageHeader title="Admin Billing" subtitle="Platform-wide ConnectComms billing, failed payments, tax profiles, and monthly runs." />
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
        <DetailCard title="Monthly Billing Run">
          <p className="muted">Dry-run first to preview generated invoices and charges. Real runs create invoices and charge default SOLA cards for tenants with auto billing enabled.</p>
          <div className="row-actions">
            <button className="btn ghost" type="button" disabled={!!busy} onClick={() => runMonthly(true)}>{busy === "dry-run" ? "Running..." : "Dry Run"}</button>
            <button className="btn primary" type="button" disabled={!!busy} onClick={() => runMonthly(false)}>{busy === "monthly" ? "Running..." : "Run Monthly Billing"}</button>
          </div>
        </DetailCard>
        {tenants.status === "success" ? (
          <DataTable
            rows={rows}
            columns={[
              { key: "name", label: "Tenant", render: (r) => r.name },
              { key: "balance", label: "Balance", render: (r) => r.balance },
              { key: "card", label: "Card", render: (r) => r.card },
              { key: "autoBilling", label: "Auto Billing", render: (r) => r.autoBilling },
              { key: "latestInvoice", label: "Latest Invoice", render: (r) => r.latestInvoice },
              {
                key: "actions",
                label: "Actions",
                render: (r) => (
                  <div className="row-actions">
                    <button className="btn ghost" type="button" onClick={() => apiPost(`/admin/billing/tenants/${r.id}/invoices/preview`, {}).then((preview) => alert(`Preview total: ${dollars((preview as any).totalCents || 0)}`))}>Preview</button>
                    <button className="btn primary" type="button" onClick={() => apiPost(`/admin/billing/tenants/${r.id}/invoices`, {}).then(() => window.location.reload())}>Generate</button>
                  </div>
                )
              }
            ]}
          />
        ) : null}
      </div>
    </PermissionGate>
  );
}
