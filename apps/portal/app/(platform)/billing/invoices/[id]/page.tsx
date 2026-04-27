"use client";

import { useParams } from "next/navigation";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
import { apiGet, apiPost, getPortalApiBaseUrl } from "../../../../../services/apiClient";
import { DataTable } from "../../../../../components/DataTable";
import { ErrorState } from "../../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../../components/PageHeader";
import { PermissionGate } from "../../../../../components/PermissionGate";

function dollars(cents: number) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function openPdf(id: string) {
  const token = localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  window.open(`${getPortalApiBaseUrl()}/billing/platform/invoices/${encodeURIComponent(id)}/pdf${qs}`, "_blank", "noopener,noreferrer");
}

type InvoiceLineRow = {
  id: string;
  description: string;
  quantity: string;
  unit: string;
  amount: string;
};

export default function BillingInvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const invoice = useAsyncResource(() => apiGet<any>(`/billing/platform/invoices/${params.id}`), [params.id]);
  const row = invoice.status === "success" ? invoice.data : null;
  const lineItems: InvoiceLineRow[] = row?.lineItems?.map((item: any) => ({
    id: item.id,
    description: item.description,
    quantity: String(item.quantity),
    unit: dollars(item.unitPriceCents),
    amount: dollars(item.amountCents)
  })) || [];

  return (
    <PermissionGate permission="can_view_reports" fallback={<div className="state-box">You do not have invoice access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title={row?.invoiceNumber || "Invoice"} subtitle="Invoice detail, line items, payment status, and PDF export." />
        {invoice.status === "loading" ? <LoadingSkeleton rows={6} /> : null}
        {invoice.status === "error" ? <ErrorState message={invoice.error} /> : null}
        {row ? (
          <>
            <section className="metric-grid">
              <div className="state-box"><span className="muted">Status</span><strong>{row.status}</strong></div>
              <div className="state-box"><span className="muted">Total</span><strong>{dollars(row.totalCents)}</strong></div>
              <div className="state-box"><span className="muted">Balance</span><strong>{dollars(row.balanceDueCents)}</strong></div>
              <div className="state-box"><span className="muted">Due</span><strong>{new Date(row.dueDate).toLocaleDateString()}</strong></div>
            </section>
            <div className="row-actions">
              <button className="btn ghost" type="button" onClick={() => openPdf(row.id)}>Download PDF</button>
              {row.status !== "PAID" && row.status !== "VOID" ? (
                <button className="btn primary" type="button" onClick={() => apiPost(`/billing/platform/invoices/${row.id}/pay`, {}).then(() => window.location.reload())}>Pay Invoice</button>
              ) : null}
            </div>
            <DataTable
              rows={lineItems}
              columns={[
                { key: "description", label: "Description", render: (r) => r.description },
                { key: "quantity", label: "Qty", render: (r) => r.quantity },
                { key: "unit", label: "Unit", render: (r) => r.unit },
                { key: "amount", label: "Amount", render: (r) => r.amount },
              ]}
            />
          </>
        ) : null}
      </div>
    </PermissionGate>
  );
}
