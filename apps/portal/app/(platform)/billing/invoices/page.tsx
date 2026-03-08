"use client";

import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet } from "../../../../services/apiClient";
import { DataTable } from "../../../../components/DataTable";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";

export default function BillingInvoicesPage() {
  const invoices = useAsyncResource(() => apiGet<any[]>("/billing/invoices"), []);

  const rows = invoices.status === "success"
    ? invoices.data.map((row, idx) => ({
        id: String(row.id || idx),
        number: String(row.id || "-"),
        status: String(row.status || "-"),
        amount: `${Number(row.amountCents || 0) / 100} ${String(row.currency || "USD")}`,
        dueAt: String(row.dueAt || "-"),
        customer: String(row.customerEmail || "-")
      }))
    : [];

  return (
    <PermissionGate permission="can_view_reports" fallback={<div className="state-box">You do not have invoice access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="Invoices" subtitle="Invoice lifecycle, overdue tracking, and payment visibility." />
        {invoices.status === "loading" ? <LoadingSkeleton rows={7} /> : null}
        {invoices.status === "error" ? <ErrorState message={invoices.error} /> : null}
        {invoices.status === "success" && rows.length === 0 ? <EmptyState title="No invoices" message="Create invoices to begin billing operations." /> : null}
        {invoices.status === "success" && rows.length > 0 ? (
          <DataTable
            rows={rows}
            columns={[
              { key: "number", label: "Invoice", render: (r) => r.number },
              { key: "status", label: "Status", render: (r) => r.status },
              { key: "amount", label: "Amount", render: (r) => r.amount },
              { key: "dueAt", label: "Due Date", render: (r) => r.dueAt },
              { key: "customer", label: "Customer", render: (r) => r.customer }
            ]}
          />
        ) : null}
      </div>
    </PermissionGate>
  );
}
