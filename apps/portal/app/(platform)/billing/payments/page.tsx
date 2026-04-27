"use client";

import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiDelete, apiGet, apiPost } from "../../../../services/apiClient";
import { DataTable } from "../../../../components/DataTable";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";

export default function BillingPaymentsPage() {
  const methods = useAsyncResource(() => apiGet<any[]>("/billing/payment-methods"), []);
  const rows = methods.status === "success"
    ? methods.data.map((method) => ({
        id: method.id,
        card: `${method.brand || "Card"} ending ${method.last4 || "----"}`,
        exp: [method.expMonth, method.expYear].filter(Boolean).join("/") || "-",
        name: method.cardholderName || "-",
        default: method.isDefault ? "Default" : "",
        lastUsed: method.lastUsedAt ? new Date(method.lastUsedAt).toLocaleString() : "-"
      }))
    : [];

  return (
    <PermissionGate permission="can_view_reports" fallback={<div className="state-box">You do not have payment access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="Payment Methods" subtitle="Saved SOLA tokenized cards. Raw card numbers are never stored in ConnectComms." />
        <div className="state-box">
          <strong>Add card on file</strong>
          <p className="muted">Use the SOLA iFields/SUT token from the secure card form, then save it here as the default card.</p>
          <form className="form-grid" onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            await apiPost("/billing/payment-methods/sola/save", {
              xSut: String(form.get("xSut") || ""),
              cardholderName: String(form.get("cardholderName") || ""),
              billingZip: String(form.get("billingZip") || ""),
              makeDefault: true
            });
            window.location.reload();
          }}>
            <input name="cardholderName" placeholder="Cardholder name" />
            <input name="billingZip" placeholder="Billing ZIP" />
            <input name="xSut" placeholder="SOLA secure token (SUT)" required />
            <button className="btn primary" type="submit">Save Card</button>
          </form>
        </div>
        {methods.status === "loading" ? <LoadingSkeleton rows={4} /> : null}
        {methods.status === "error" ? <ErrorState message={methods.error} /> : null}
        {methods.status === "success" && rows.length === 0 ? <EmptyState title="No payment methods" message="Add a SOLA card-on-file token to enable auto billing and invoice payments." /> : null}
        {methods.status === "success" && rows.length > 0 ? (
          <DataTable
            rows={rows}
            columns={[
              { key: "card", label: "Card", render: (r) => r.card },
              { key: "exp", label: "Exp", render: (r) => r.exp },
              { key: "name", label: "Name", render: (r) => r.name },
              { key: "default", label: "Default", render: (r) => r.default || "-" },
              { key: "lastUsed", label: "Last Used", render: (r) => r.lastUsed },
              {
                key: "actions",
                label: "Actions",
                render: (r) => (
                  <div className="row-actions">
                    {!r.default ? <button className="btn ghost" type="button" onClick={() => apiPost(`/billing/payment-methods/${r.id}/default`, {}).then(() => window.location.reload())}>Make Default</button> : null}
                    <button className="btn danger" type="button" onClick={() => apiDelete(`/billing/payment-methods/${r.id}`).then(() => window.location.reload())}>Remove</button>
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
