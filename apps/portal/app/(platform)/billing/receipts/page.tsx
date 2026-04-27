"use client";

import Link from "next/link";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet } from "../../../../services/apiClient";
import { DetailCard } from "../../../../components/DetailCard";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";

function dollars(cents: number) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

export default function BillingReceiptsPage() {
  const invoices = useAsyncResource(() => apiGet<any[]>("/billing/platform/invoices"), []);
  const paidInvoices = invoices.status === "success" ? invoices.data.filter((invoice) => invoice.status === "PAID" || invoice.transactions?.some((tx: any) => tx.status === "APPROVED")) : [];

  return (
    <PermissionGate permission="can_view_reports" fallback={<div className="state-box">You do not have receipt access.</div>}>
      <div className="stack compact-stack billing-admin-shell">
        <PageHeader title="Receipts" subtitle="Paid invoices, payment receipts, and receipt email status." />
        {invoices.status === "loading" ? <LoadingSkeleton rows={5} /> : null}
        {invoices.status === "error" ? <ErrorState message={invoices.error} /> : null}
        {invoices.status === "success" && paidInvoices.length === 0 ? <EmptyState title="No receipts yet" message="Receipts appear after a SOLA payment is approved or an invoice is marked paid." /> : null}
        {paidInvoices.length > 0 ? (
          <DetailCard title="Receipt History">
            <div className="billing-invoice-stack">
              {paidInvoices.map((invoice) => (
                <div className="billing-invoice-row" key={invoice.id}>
                  <span><strong>{invoice.invoiceNumber}</strong><small>Paid {invoice.paidAt ? new Date(invoice.paidAt).toLocaleDateString() : "date unavailable"} · email {invoice.lastEmailStatus || "not sent"}</small></span>
                  <em>{dollars(invoice.totalCents)}</em>
                  <span className="billing-status-pill good">PAID</span>
                  <Link className="btn ghost" href={`/billing/invoices/${invoice.id}`}>Receipt</Link>
                </div>
              ))}
            </div>
          </DetailCard>
        ) : null}
      </div>
    </PermissionGate>
  );
}
