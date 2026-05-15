"use client";

import "../../admin/billing/_components/billingPhase3.css";
import "../../admin/billing/_components/billingPhase4.css";
import "../../admin/billing/_components/billingPhase5.css";
import Link from "next/link";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, getPortalApiBaseUrl } from "../../../../services/apiClient";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { BillingPageChrome } from "../../../../components/BillingActionToast";
import { dollars, formatDate, invoiceStatusLabel, invoiceStatusClass } from "../../../../lib/billingUi";

function openPdf(id: string) {
  const token = localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  window.open(`${getPortalApiBaseUrl()}/billing/platform/invoices/${encodeURIComponent(id)}/pdf${qs}`, "_blank", "noopener,noreferrer");
}

const STATUS_SORT: Record<string, number> = { FAILED: 5, OVERDUE: 4, OPEN: 3, DRAFT: 2, PAID: 1, VOID: 0 };

export default function BillingInvoicesPage() {
  const invoices = useAsyncResource(() => apiGet<any[]>("/billing/platform/invoices"), []);
  const rows = invoices.status === "success"
    ? [...invoices.data].sort((a, b) => (STATUS_SORT[String(b.status)] || 0) - (STATUS_SORT[String(a.status)] || 0))
    : [];

  return (
    <PermissionGate permission="can_view_billing_invoices" fallback={<div className="state-box">You do not have invoice access.</div>}>
      <BillingPageChrome toast={null}>
        <div className="stack compact-stack billing-admin-shell billing-phase3-tenant billing-p5-scope">
          <PageHeader title="Invoices" subtitle="History, PDFs, and pay-open balances." />
          <div data-testid="billing-tenant-invoices-root">
            {invoices.status === "loading" ? <LoadingSkeleton rows={7} /> : null}
            {invoices.status === "error" ? <ErrorState message={invoices.error} /> : null}
            {invoices.status === "success" && rows.length === 0 ? (
              <EmptyState title="No invoices yet" message="Invoices will appear here once billing begins for your account." />
            ) : null}
            {invoices.status === "success" && rows.length > 0 ? (
              <div className="billing-invoice-stack">
              {rows.map((invoice) => {
                const status = String(invoice.status || "");
                const period =
                  invoice.periodStart && invoice.periodEnd
                    ? `${formatDate(invoice.periodStart)} – ${formatDate(invoice.periodEnd)}`
                    : null;
                return (
                  <div className="billing-invoice-row" key={invoice.id}>
                    <span>
                      <strong>{invoice.invoiceNumber || invoice.id}</strong>
                      <small>
                        {period ? `${period} · ` : ""}
                        Due {invoice.dueDate ? formatDate(invoice.dueDate) : "—"}
                      </small>
                    </span>
                    <em>
                      {dollars(invoice.totalCents || 0)}
                      {invoice.balanceDueCents > 0 && status !== "PAID" ? (
                        <small> · {dollars(invoice.balanceDueCents)} due</small>
                      ) : null}
                    </em>
                    <span className={`billing-status-pill ${invoiceStatusClass(status)}`}>
                      {invoiceStatusLabel(status)}
                    </span>
                    <div className="row-actions">
                      <Link className="btn ghost" href={`/billing/invoices/${invoice.id}`}>
                        {status === "FAILED" || status === "OVERDUE" ? "Pay now" : "Open"}
                      </Link>
                      <button className="btn ghost" type="button" onClick={() => openPdf(invoice.id)}>
                        PDF
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          </div>
        </div>
      </BillingPageChrome>
    </PermissionGate>
  );
}
