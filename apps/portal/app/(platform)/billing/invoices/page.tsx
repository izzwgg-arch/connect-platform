"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost, getPortalApiBaseUrl } from "../../../../services/apiClient";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { BillingPageChrome, billingErrorMessage } from "../../../../components/BillingActionToast";
import { dollars } from "../../../../lib/billingUi";

function openPdf(id: string) {
  const token = localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  window.open(`${getPortalApiBaseUrl()}/billing/platform/invoices/${encodeURIComponent(id)}/pdf${qs}`, "_blank", "noopener,noreferrer");
}

export default function BillingInvoicesPage() {
  const invoices = useAsyncResource(() => apiGet<any[]>("/billing/platform/invoices"), []);
  const settings = useAsyncResource(() => apiGet<any>("/billing/settings"), []);
  const rows = invoices.status === "success" ? invoices.data : [];
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const showToast = useCallback((kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const hasDefaultPm = settings.status === "success" && !!settings.data.defaultPaymentMethodId;

  return (
    <PermissionGate permission="can_view_billing_invoices" fallback={<div className="state-box">You do not have invoice access.</div>}>
      <BillingPageChrome toast={toast}>
        <div className="stack compact-stack billing-admin-shell">
          <PageHeader title="Invoices" subtitle="Status, balances, PDFs, and payment actions. Use an invoice’s detail page to email the PDF or a payment link." />
          {invoices.status === "loading" ? <LoadingSkeleton rows={7} /> : null}
          {invoices.status === "error" ? <ErrorState message={invoices.error} /> : null}
          {settings.status === "error" ? <ErrorState message={settings.error} /> : null}
          {invoices.status === "success" && rows.length === 0 ? (
            <EmptyState title="No invoices" message="No ConnectComms invoices have been generated for this tenant yet." />
          ) : null}
          {invoices.status === "success" && rows.length > 0 ? (
            <div className="billing-invoice-stack">
              {rows.map((invoice) => {
                const status = String(invoice.status || "-");
                const period = invoice.periodStart && invoice.periodEnd ? `${new Date(invoice.periodStart).toLocaleDateString()} - ${new Date(invoice.periodEnd).toLocaleDateString()}` : "-";
                const canPay = status !== "PAID" && status !== "VOID";
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
                      {canPay && hasDefaultPm ? (
                        <button
                          className="btn primary"
                          type="button"
                          disabled={!!pendingId}
                          onClick={async () => {
                            setPendingId(invoice.id);
                            try {
                              await apiPost(`/billing/platform/invoices/${invoice.id}/pay`, {});
                              showToast("ok", "Charge submitted.");
                              window.location.reload();
                            } catch (err) {
                              showToast("err", billingErrorMessage(err, "Charge failed"));
                            } finally {
                              setPendingId(null);
                            }
                          }}
                        >
                          {pendingId === invoice.id ? "Charging…" : "Charge card"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </BillingPageChrome>
    </PermissionGate>
  );
}
