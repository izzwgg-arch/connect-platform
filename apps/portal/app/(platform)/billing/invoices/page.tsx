"use client";

import Link from "next/link";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost, getPortalApiBaseUrl } from "../../../../services/apiClient";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";

function dollars(cents: number) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function openPdf(id: string) {
  const token = localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  window.open(`${getPortalApiBaseUrl()}/billing/platform/invoices/${encodeURIComponent(id)}/pdf${qs}`, "_blank", "noopener,noreferrer");
}

export default function BillingInvoicesPage() {
  const invoices = useAsyncResource(() => apiGet<any[]>("/billing/platform/invoices"), []);
  const rows = invoices.status === "success" ? invoices.data : [];

  return (
    <PermissionGate permission="can_view_reports" fallback={<div className="state-box">You do not have invoice access.</div>}>
      <div className="stack compact-stack billing-admin-shell">
        <PageHeader title="Invoices" subtitle="ConnectComms invoices, payment status, and PDF downloads." />
        {invoices.status === "loading" ? <LoadingSkeleton rows={7} /> : null}
        {invoices.status === "error" ? <ErrorState message={invoices.error} /> : null}
        {invoices.status === "success" && rows.length === 0 ? <EmptyState title="No invoices" message="No ConnectComms invoices have been generated for this tenant yet." /> : null}
        {invoices.status === "success" && rows.length > 0 ? (
          <div className="billing-invoice-stack">
            {rows.map((invoice) => {
              const status = String(invoice.status || "-");
              const period = invoice.periodStart && invoice.periodEnd ? `${new Date(invoice.periodStart).toLocaleDateString()} - ${new Date(invoice.periodEnd).toLocaleDateString()}` : "-";
              return (
                <div className="billing-invoice-row" key={invoice.id}>
                  <span>
                    <strong>{invoice.invoiceNumber || invoice.id}</strong>
                    <small>{period} · due {invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : "-"}</small>
                  </span>
                  <em>{dollars(invoice.totalCents || 0)}<small> balance {dollars(invoice.balanceDueCents || 0)}</small></em>
                  <span className={`billing-status-pill ${status === "PAID" ? "good" : status === "FAILED" || status === "OVERDUE" ? "bad" : "warn"}`}>{status}</span>
                  <div className="row-actions">
                    <Link className="btn ghost" href={`/billing/invoices/${invoice.id}`}>Open</Link>
                    <button className="btn ghost" type="button" onClick={() => openPdf(invoice.id)}>PDF</button>
                    {status !== "PAID" && status !== "VOID" ? (
                      <button className="btn primary" type="button" onClick={() => apiPost(`/billing/platform/invoices/${invoice.id}/pay`, {}).then(() => window.location.reload())}>Pay</button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </PermissionGate>
  );
}
