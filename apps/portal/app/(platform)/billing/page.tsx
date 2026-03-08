"use client";

import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { apiGet } from "../../../services/apiClient";
import { DetailCard } from "../../../components/DetailCard";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { MetricCard } from "../../../components/MetricCard";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";

export default function BillingOverviewPage() {
  const summary = useAsyncResource(() => apiGet<any>("/billing/invoices/summary"), []);

  return (
    <PermissionGate permission="can_view_reports" fallback={<div className="state-box">You do not have billing access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="Billing Overview" subtitle="Invoice and payment status for the current tenant context." />
        {summary.status === "loading" ? <LoadingSkeleton rows={4} /> : null}
        {summary.status === "error" ? <ErrorState message={summary.error} /> : null}
        {summary.status === "success" ? (
          <section className="metric-grid">
            <MetricCard label="Draft" value={String(summary.data?.counts?.DRAFT || 0)} />
            <MetricCard label="Sent" value={String(summary.data?.counts?.SENT || 0)} />
            <MetricCard label="Overdue" value={String(summary.data?.counts?.OVERDUE || 0)} />
            <MetricCard label="Paid" value={String(summary.data?.counts?.PAID || 0)} />
          </section>
        ) : null}
        <DetailCard title="Billing Workflows">
          <p className="muted">Use Invoices and Payments pages for lifecycle actions, reminders, and reconciliation.</p>
        </DetailCard>
      </div>
    </PermissionGate>
  );
}
