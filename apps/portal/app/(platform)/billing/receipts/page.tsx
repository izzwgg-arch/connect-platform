"use client";

import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, getPortalApiBaseUrl } from "../../../../services/apiClient";
import { DetailCard } from "../../../../components/DetailCard";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { dollars, formatDate } from "../../../../lib/billingUi";

function openPdf(id: string) {
  const token = localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  window.open(`${getPortalApiBaseUrl()}/billing/platform/invoices/${encodeURIComponent(id)}/pdf${qs}`, "_blank", "noopener,noreferrer");
}

function receiptCardLabel(invoice: any): string {
  const tx = invoice.transactions?.find((t: any) => t.status === "APPROVED");
  if (!tx?.paymentMethod?.last4) return "";
  return `${tx.paymentMethod.brand || "Card"} ••••${tx.paymentMethod.last4}`;
}

export default function BillingReceiptsPage() {
  const invoices = useAsyncResource(() => apiGet<any[]>("/billing/platform/invoices"), []);
  const paidInvoices =
    invoices.status === "success"
      ? invoices.data
          .filter((inv) => inv.status === "PAID" || inv.transactions?.some((tx: any) => tx.status === "APPROVED"))
          .sort((a, b) => new Date(b.paidAt || 0).getTime() - new Date(a.paidAt || 0).getTime())
      : [];

  return (
    <PermissionGate permission="can_view_billing_receipts" fallback={<div className="state-box">You do not have receipt access.</div>}>
      <div className="stack compact-stack billing-admin-shell">
        <PageHeader title="Receipts" subtitle="Paid invoices and payment confirmations." />
        {invoices.status === "loading" ? <LoadingSkeleton rows={5} /> : null}
        {invoices.status === "error" ? <ErrorState message={invoices.error} /> : null}
        {invoices.status === "success" && paidInvoices.length === 0 ? (
          <EmptyState title="No receipts yet" message="Receipts appear after a payment is approved or an invoice is marked paid." />
        ) : null}
        {paidInvoices.length > 0 ? (
          <DetailCard title="Payment receipts">
            <div>
              {paidInvoices.map((invoice) => {
                const cardLabel = receiptCardLabel(invoice);
                return (
                  <div className="billing-receipt-row" key={invoice.id}>
                    <span>
                      <strong>{invoice.invoiceNumber}</strong>
                      <small style={{ display: "block", color: "var(--muted)", fontSize: 11 }}>
                        Paid {invoice.paidAt ? formatDate(invoice.paidAt) : "—"}
                        {cardLabel ? ` · ${cardLabel}` : ""}
                      </small>
                    </span>
                    <strong className="receipt-amount">{dollars(invoice.totalCents)}</strong>
                    <span className="billing-status-pill good receipt-card">Paid</span>
                    <div className="row-actions receipt-pdf">
                      <button className="btn ghost" type="button" onClick={() => openPdf(invoice.id)}>
                        PDF
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </DetailCard>
        ) : null}
      </div>
    </PermissionGate>
  );
}
