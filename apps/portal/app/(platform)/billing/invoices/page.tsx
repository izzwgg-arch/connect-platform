"use client";

import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost, getPortalApiBaseUrl } from "../../../../services/apiClient";
import { DataTable } from "../../../../components/DataTable";
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

  const rows = invoices.status === "success"
    ? invoices.data.map((row, idx) => ({
        id: String(row.id || idx),
        number: String(row.invoiceNumber || row.id || "-"),
        status: String(row.status || "-"),
        amount: dollars(row.totalCents || 0),
        balance: dollars(row.balanceDueCents || 0),
        dueAt: row.dueDate ? new Date(row.dueDate).toLocaleDateString() : "-",
        period: row.periodStart && row.periodEnd ? `${new Date(row.periodStart).toLocaleDateString()} - ${new Date(row.periodEnd).toLocaleDateString()}` : "-"
      }))
    : [];

  return (
    <PermissionGate permission="can_view_reports" fallback={<div className="state-box">You do not have invoice access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="Invoices" subtitle="ConnectComms invoices, payment status, and PDF downloads." />
        {invoices.status === "loading" ? <LoadingSkeleton rows={7} /> : null}
        {invoices.status === "error" ? <ErrorState message={invoices.error} /> : null}
        {invoices.status === "success" && rows.length === 0 ? <EmptyState title="No invoices" message="No ConnectComms invoices have been generated for this tenant yet." /> : null}
        {invoices.status === "success" && rows.length > 0 ? (
          <DataTable
            rows={rows}
            columns={[
              { key: "number", label: "Invoice", render: (r) => r.number },
              { key: "status", label: "Status", render: (r) => r.status },
              { key: "amount", label: "Total", render: (r) => r.amount },
              { key: "balance", label: "Balance", render: (r) => r.balance },
              { key: "dueAt", label: "Due Date", render: (r) => r.dueAt },
              { key: "period", label: "Period", render: (r) => r.period },
              {
                key: "actions",
                label: "Actions",
                render: (r) => (
                  <div className="row-actions">
                    <button className="btn ghost" type="button" onClick={() => openPdf(r.id)}>PDF</button>
                    {r.status !== "PAID" && r.status !== "VOID" ? (
                      <button className="btn primary" type="button" onClick={() => apiPost(`/billing/platform/invoices/${r.id}/pay`, {}).then(() => window.location.reload())}>Pay</button>
                    ) : null}
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
