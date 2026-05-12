"use client";

import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
import { apiGet, apiPost, getPortalApiBaseUrl } from "../../../../../services/apiClient";
import { DataTable } from "../../../../../components/DataTable";
import { ErrorState } from "../../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../../components/PageHeader";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { DetailCard } from "../../../../../components/DetailCard";
import { BillingPageChrome, billingErrorMessage } from "../../../../../components/BillingActionToast";
import { dunningHintFromInvoice, dollars } from "../../../../../lib/billingUi";

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

type BillingEventRow = {
  id: string;
  type: string;
  message: string | null;
  createdAt: string;
  detail: string;
};

export default function BillingInvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const invoice = useAsyncResource(() => apiGet<any>(`/billing/platform/invoices/${params.id}`), [params.id, refreshKey]);
  const settings = useAsyncResource(() => apiGet<any>("/billing/settings"), [refreshKey]);

  const showToast = useCallback((kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  const row = invoice.status === "success" ? invoice.data : null;
  const lineItems: InvoiceLineRow[] = row?.lineItems?.map((item: any) => ({
    id: item.id,
    description: item.description,
    quantity: String(item.quantity),
    unit: dollars(item.unitPriceCents),
    amount: dollars(item.amountCents),
  })) || [];

  const hasDefaultPm = settings.status === "success" && !!settings.data.defaultPaymentMethodId;
  const billingEmailSet = settings.status === "success" && !!String(settings.data.billingEmail || "").trim();

  const events: BillingEventRow[] = (row?.events || [])
    .slice()
    .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((e: any) => ({
      id: e.id,
      type: e.type,
      message: e.message,
      createdAt: e.createdAt,
      detail: e.message || (e.metadata ? JSON.stringify(e.metadata) : "—"),
    }));

  const dunning = row ? dunningHintFromInvoice(row) : null;
  const canPay = row && row.status !== "PAID" && row.status !== "VOID";

  async function runAction(key: string, fn: () => Promise<void>) {
    setPending(key);
    try {
      await fn();
    } catch (err) {
      showToast("err", billingErrorMessage(err, "Request failed"));
    } finally {
      setPending(null);
    }
  }

  return (
    <PermissionGate permission="can_view_billing_invoices" fallback={<div className="state-box">You do not have invoice access.</div>}>
      <BillingPageChrome toast={toast}>
        <div className="stack compact-stack">
          <PageHeader title={row?.invoiceNumber || "Invoice"} subtitle="Line items, PDF, payment, and billing activity for this invoice." />
          {invoice.status === "loading" && !invoice.refreshing ? <LoadingSkeleton rows={6} /> : null}
          {invoice.status === "error" ? <ErrorState message={invoice.error} /> : null}
          {settings.status === "error" ? <ErrorState message={settings.error} /> : null}
          {row ? (
            <>
              <section className="metric-grid">
                <div className="state-box"><span className="muted">Status</span><strong>{row.status}</strong></div>
                <div className="state-box"><span className="muted">Total</span><strong>{dollars(row.totalCents)}</strong></div>
                <div className="state-box"><span className="muted">Balance</span><strong>{dollars(row.balanceDueCents)}</strong></div>
                <div className="state-box"><span className="muted">Due</span><strong>{new Date(row.dueDate).toLocaleDateString()}</strong></div>
              </section>
              {dunning ? <div className="state-box">{dunning}</div> : null}
              <div className="row-actions" style={{ flexWrap: "wrap" }}>
                <button className="btn ghost" type="button" onClick={() => openPdf(row.id)}>View PDF</button>
                {canPay && billingEmailSet ? (
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={!!pending}
                    onClick={() =>
                      runAction("email-inv", async () => {
                        await apiPost(`/billing/platform/invoices/${row.id}/email-invoice`, {});
                        showToast("ok", "Invoice email queued.");
                        bump();
                      })
                    }
                  >
                    {pending === "email-inv" ? "Sending…" : "Email invoice"}
                  </button>
                ) : null}
                {canPay && billingEmailSet ? (
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={!!pending}
                    onClick={() =>
                      runAction("email-pay", async () => {
                        await apiPost(`/billing/platform/invoices/${row.id}/email-payment-link`, {});
                        showToast("ok", "Payment link email queued.");
                        bump();
                      })
                    }
                  >
                    {pending === "email-pay" ? "Sending…" : "Email payment link"}
                  </button>
                ) : null}
                {!billingEmailSet && canPay ? (
                  <span className="muted" style={{ alignSelf: "center" }}>
                    Set a billing email under Settings → Billing to enable invoice emails.
                  </span>
                ) : null}
                {canPay && hasDefaultPm ? (
                  <button
                    className="btn primary"
                    type="button"
                    disabled={!!pending}
                    onClick={() =>
                      runAction("pay", async () => {
                        await apiPost(`/billing/platform/invoices/${row.id}/pay`, {});
                        showToast("ok", "Charge submitted. Refreshing status…");
                        bump();
                      })
                    }
                  >
                    {pending === "pay" ? "Charging…" : "Charge default card"}
                  </button>
                ) : null}
                {canPay && !hasDefaultPm ? (
                  <a className="btn primary" href="/billing/payments">
                    Add payment method
                  </a>
                ) : null}
                <button className="btn ghost" type="button" disabled={!!pending} onClick={() => bump()}>
                  Refresh
                </button>
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
              <DetailCard title="Billing activity">
                {events.length === 0 ? (
                  <p className="muted">No billing events logged for this invoice yet.</p>
                ) : (
                  <DataTable
                    rows={events}
                    columns={[
                      { key: "t", label: "Time", render: (r) => new Date(r.createdAt).toLocaleString() },
                      { key: "type", label: "Type", render: (r) => r.type },
                      { key: "detail", label: "Detail", render: (r) => r.detail },
                    ]}
                  />
                )}
              </DetailCard>
            </>
          ) : null}
        </div>
      </BillingPageChrome>
    </PermissionGate>
  );
}
