"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import "../../../admin/billing/_components/billingPhase3.css";
import "../../../admin/billing/_components/billingPhase4.css";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
import { apiGet, apiPost, getPortalApiBaseUrl } from "../../../../../services/apiClient";
import { DataTable } from "../../../../../components/DataTable";
import { ErrorState } from "../../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../../components/PageHeader";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { DetailCard } from "../../../../../components/DetailCard";
import { BillingPageChrome, billingErrorMessage } from "../../../../../components/BillingActionToast";
import { BillingActionPanel } from "../../../../../components/billing/BillingActionPanel";
import { BillingEmptyState } from "../../../../../components/billing/BillingEmptyState";
import {
  dollars, formatDate, formatDateTime,
  invoiceStatusLabel, invoiceStatusClass,
  transactionStatusLabel, transactionStatusClass,
  billingEventLabel, billingEventIcon,
} from "../../../../../lib/billingUi";

function openPdf(id: string) {
  const token = localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  window.open(`${getPortalApiBaseUrl()}/billing/platform/invoices/${encodeURIComponent(id)}/pdf${qs}`, "_blank", "noopener,noreferrer");
}

type InvoiceLineRow = {
  id: string; description: string; quantity: string; unit: string; amount: string;
};

export default function BillingInvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmPay, setConfirmPay] = useState(false);
  const submittedRef = useRef(false);

  const invoice = useAsyncResource(() => apiGet<any>(`/billing/platform/invoices/${params.id}`), [params.id, refreshKey]);
  const settings = useAsyncResource(() => apiGet<any>("/billing/settings"), [refreshKey]);

  const showToast = useCallback((kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const bump = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setConfirmPay(false);
  }, []);

  const row = invoice.status === "success" ? invoice.data : null;
  const hasDefaultPm = settings.status === "success" && !!settings.data.defaultPaymentMethodId;
  const billingEmailSet = settings.status === "success" && !!String(settings.data.billingEmail || "").trim();
  const canPay = row && row.status !== "PAID" && row.status !== "VOID";

  const lineItems: InvoiceLineRow[] = row?.lineItems?.map((item: any) => ({
    id: item.id,
    description: item.description,
    quantity: String(item.quantity),
    unit: dollars(item.unitPriceCents),
    amount: dollars(item.amountCents),
  })) || [];

  const transactions: any[] = row?.transactions || [];
  const events: any[] = (row?.events || [])
    .slice()
    .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  async function runAction(key: string, fn: () => Promise<void>) {
    setPending(key);
    try { await fn(); }
    catch (err) { showToast("err", billingErrorMessage(err, "Request failed")); }
    finally { setPending(null); }
  }

  async function handlePay() {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setPending("pay");
    try {
      const result = await apiPost<any>(`/billing/platform/invoices/${row.id}/pay`, {});
      const tx = result?.transaction;
      if (tx?.status === "APPROVED") {
        showToast("ok", `Payment approved — ${dollars(tx.amountCents)}.`);
      } else if (tx?.status === "DECLINED") {
        showToast("err", `Declined: ${tx.responseMessage || tx.responseCode || "card declined"}.`);
      } else {
        showToast("ok", "Charge submitted. Refreshing status…");
      }
      bump();
    } catch (err) {
      showToast("err", billingErrorMessage(err, "Charge failed"));
      setConfirmPay(false);
    } finally {
      setPending(null);
      submittedRef.current = false;
    }
  }

  const period =
    row?.periodStart && row?.periodEnd
      ? `${formatDate(row.periodStart)} – ${formatDate(row.periodEnd)}`
      : null;

  return (
    <PermissionGate permission="can_view_billing_invoices" fallback={<div className="state-box">You do not have invoice access.</div>}>
      <BillingPageChrome toast={toast}>
        <div className="stack compact-stack">
          <div className="row-actions" style={{ marginBottom: -4 }}>
            <Link className="btn ghost" style={{ fontSize: 12, padding: "4px 10px" }} href="/billing/invoices">
              ← Invoices
            </Link>
          </div>

          <PageHeader
            title={row?.invoiceNumber || "Invoice"}
            subtitle={period ? `Billing period: ${period}` : "Invoice details, payment, and activity."}
          />

          {invoice.status === "loading" && !invoice.refreshing ? <LoadingSkeleton rows={6} /> : null}
          {invoice.status === "error" ? <ErrorState message={invoice.error} /> : null}
          {settings.status === "error" ? <ErrorState message={settings.error} /> : null}

          {row ? (
            <>
              {/* Invoice header card */}
              <div className="billing-invoice-header">
                <div className="billing-invoice-header-top">
                  <div>
                    <h2>{row.invoiceNumber}</h2>
                    <span className={`billing-status-pill ${invoiceStatusClass(row.status)}`}>
                      {invoiceStatusLabel(row.status)}
                    </span>
                  </div>
                  <button className="btn ghost" type="button" onClick={() => openPdf(row.id)}>
                    Download PDF
                  </button>
                </div>
                <div className="billing-invoice-meta">
                  <div className="billing-invoice-meta-item">
                    <span className="meta-label">Total</span>
                    <span className="meta-value">{dollars(row.totalCents)}</span>
                  </div>
                  {row.balanceDueCents > 0 ? (
                    <div className="billing-invoice-meta-item">
                      <span className="meta-label">Balance due</span>
                      <span className="meta-value" style={{ color: "var(--danger, #e53e3e)" }}>
                        {dollars(row.balanceDueCents)}
                      </span>
                    </div>
                  ) : null}
                  <div className="billing-invoice-meta-item">
                    <span className="meta-label">Due date</span>
                    <span className="meta-value">{formatDate(row.dueDate)}</span>
                  </div>
                  {period ? (
                    <div className="billing-invoice-meta-item">
                      <span className="meta-label">Period</span>
                      <span className="meta-value">{period}</span>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Payment actions */}
              {canPay ? (
                <DetailCard title="Pay this invoice">
                  {hasDefaultPm ? (
                    confirmPay ? (
                      <div>
                        <p className="muted" style={{ marginBottom: 12, fontSize: 14 }}>
                          Confirm the amount and your default card in the secure panel. You can cancel anytime.
                        </p>
                        <div className="row-actions" style={{ flexWrap: "wrap" }}>
                          <button className="btn ghost" type="button" disabled={pending === "pay"} onClick={() => setConfirmPay(false)}>
                            Cancel payment
                          </button>
                          {billingEmailSet ? (
                            <>
                              <button
                                className="btn ghost"
                                type="button"
                                disabled={!!pending}
                                onClick={() =>
                                  runAction("email-inv", async () => {
                                    await apiPost(`/billing/platform/invoices/${row.id}/email-invoice`, {});
                                    showToast("ok", "Invoice emailed.");
                                    bump();
                                  })
                                }
                              >
                                {pending === "email-inv" ? "Sending…" : "Email invoice"}
                              </button>
                              <button
                                className="btn ghost"
                                type="button"
                                disabled={!!pending}
                                onClick={() =>
                                  runAction("email-pay", async () => {
                                    await apiPost(`/billing/platform/invoices/${row.id}/email-payment-link`, {});
                                    showToast("ok", "Payment link emailed.");
                                    bump();
                                  })
                                }
                              >
                                {pending === "email-pay" ? "Sending…" : "Email payment link"}
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <div className="row-actions" style={{ flexWrap: "wrap" }}>
                        <button
                          className="btn primary"
                          type="button"
                          onClick={() => setConfirmPay(true)}
                        >
                          Pay {dollars(row.balanceDueCents || row.totalCents)}
                        </button>
                        {billingEmailSet ? (
                          <>
                            <button
                              className="btn ghost"
                              type="button"
                              disabled={!!pending}
                              onClick={() =>
                                runAction("email-inv", async () => {
                                  await apiPost(`/billing/platform/invoices/${row.id}/email-invoice`, {});
                                  showToast("ok", "Invoice emailed.");
                                  bump();
                                })
                              }
                            >
                              {pending === "email-inv" ? "Sending…" : "Email invoice"}
                            </button>
                            <button
                              className="btn ghost"
                              type="button"
                              disabled={!!pending}
                              onClick={() =>
                                runAction("email-pay", async () => {
                                  await apiPost(`/billing/platform/invoices/${row.id}/email-payment-link`, {});
                                  showToast("ok", "Payment link emailed.");
                                  bump();
                                })
                              }
                            >
                              {pending === "email-pay" ? "Sending…" : "Email payment link"}
                            </button>
                          </>
                        ) : null}
                      </div>
                    )
                  ) : (
                    <div>
                      <p className="muted" style={{ marginBottom: 10 }}>
                        No default payment method on file. Add a card to pay this invoice.
                      </p>
                      <a className="btn primary" href="/billing/payments">
                        Add payment method
                      </a>
                      {billingEmailSet ? (
                        <div className="row-actions" style={{ marginTop: 10 }}>
                          <button
                            className="btn ghost"
                            type="button"
                            disabled={!!pending}
                            onClick={() =>
                              runAction("email-pay", async () => {
                                await apiPost(`/billing/platform/invoices/${row.id}/email-payment-link`, {});
                                showToast("ok", "Payment link emailed.");
                                bump();
                              })
                            }
                          >
                            {pending === "email-pay" ? "Sending…" : "Email payment link"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  )}
                  {!billingEmailSet && canPay ? (
                    <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
                      Set a billing email in{" "}
                      <a href="/billing/settings" style={{ textDecoration: "underline" }}>
                        Billing Settings
                      </a>{" "}
                      to enable invoice and payment link emails.
                    </p>
                  ) : null}
                </DetailCard>
              ) : null}

              {canPay && hasDefaultPm && confirmPay ? (
                <BillingActionPanel
                  layout="center"
                  centerWidth="min(460px, 94vw)"
                  onClose={() => { if (pending !== "pay") setConfirmPay(false); }}
                  eyebrow="Balance due"
                  title={row.invoiceNumber || "Pay invoice"}
                  subtitle="Your default card on file is charged once for the open balance. Match this amount to your purchase approval before continuing."
                  summary={<p style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>{dollars(row.balanceDueCents || row.totalCents)}</p>}
                  notice={`Due ${formatDate(row.dueDate)}. You will see Approved or Declined as soon as the processor responds.`}
                  footer={(
                    <>
                      <button className="btn ghost" type="button" disabled={pending === "pay"} onClick={() => setConfirmPay(false)}>
                        Cancel
                      </button>
                      <button className="btn primary" type="button" disabled={pending === "pay"} onClick={handlePay}>
                        {pending === "pay" ? "Charging…" : `Pay ${dollars(row.balanceDueCents || row.totalCents)}`}
                      </button>
                    </>
                  )}
                />
              ) : null}

              {/* Paid banner */}
              {row.status === "PAID" ? (
                <div className="state-box" style={{ textAlign: "center" }}>
                  <p style={{ fontWeight: 600, margin: 0 }}>✓ Paid {row.paidAt ? formatDate(row.paidAt) : ""}</p>
                  <div className="row-actions" style={{ justifyContent: "center", marginTop: 8 }}>
                    <button className="btn ghost" type="button" onClick={() => openPdf(row.id)}>Download PDF</button>
                    {billingEmailSet ? (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={!!pending}
                        onClick={() =>
                          runAction("email-inv", async () => {
                            await apiPost(`/billing/platform/invoices/${row.id}/email-invoice`, {});
                            showToast("ok", "Invoice emailed.");
                          })
                        }
                      >
                        {pending === "email-inv" ? "Sending…" : "Email receipt"}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {/* Line items */}
              <DetailCard title="Line items">
                {lineItems.length === 0 ? (
                  <BillingEmptyState
                    title="No line items"
                    message="Line items appear when the invoice includes billable usage or fees. Contact your administrator if this looks wrong."
                  />
                ) : (
                  <DataTable
                    rows={lineItems}
                    columns={[
                      { key: "description", label: "Description", render: (r) => r.description },
                      { key: "quantity", label: "Qty", render: (r) => r.quantity },
                      { key: "unit", label: "Unit price", render: (r) => r.unit },
                      { key: "amount", label: "Amount", render: (r) => r.amount },
                    ]}
                  />
                )}
              </DetailCard>

              {/* Payment history */}
              {transactions.length > 0 ? (
                <DetailCard title="Payment history">
                  <div className="billing-tx-list">
                    {transactions.map((tx) => (
                      <div className="billing-tx-row" key={tx.id}>
                        <span>
                          <span className="tx-amount">{dollars(tx.amountCents)}</span>
                          <span className="tx-meta tx-date"> · {formatDateTime(tx.createdAt)}</span>
                          {tx.paymentMethod?.last4 ? (
                            <span className="tx-meta">
                              {" "}· {tx.paymentMethod.brand || "Card"} ••••{tx.paymentMethod.last4}
                            </span>
                          ) : null}
                        </span>
                        <span className={`billing-status-pill ${transactionStatusClass(tx.status)}`}>
                          {transactionStatusLabel(tx.status)}
                        </span>
                        {tx.responseMessage || tx.responseCode ? (
                          <span className="tx-meta tx-ref" style={{ fontSize: 12, color: "var(--muted)" }}>
                            {tx.responseMessage || tx.responseCode}
                          </span>
                        ) : null}
                        <span className="tx-ref" />
                      </div>
                    ))}
                  </div>
                </DetailCard>
              ) : null}

              {/* Activity timeline */}
              <DetailCard title="Activity">
                {events.length === 0 ? (
                  <BillingEmptyState
                    title="No activity yet"
                    message="Payments, emails, and status changes will appear here. Open this page again after paying to see the full trail."
                  />
                ) : (
                  <div className="billing-timeline-v2">
                    {events.map((e) => {
                      const isGood = e.type === "payment_succeeded" || e.type === "invoice_marked_paid" || e.type === "receipt_emailed";
                      const isBad = e.type === "payment_failed" || String(e.type || "").includes("failed");
                      return (
                        <div className="billing-timeline-v2__item" key={e.id}>
                          <div className={`billing-timeline-v2__icon ${isGood ? "good" : isBad ? "bad" : ""}`} aria-hidden>
                            {billingEventIcon(e.type)}
                          </div>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 14 }}>{billingEventLabel(e.type)}</div>
                            <div className="billing-timeline-v2__time">{formatDateTime(e.createdAt)}</div>
                            {e.message ? <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{e.message}</div> : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </DetailCard>
            </>
          ) : null}
        </div>
      </BillingPageChrome>
    </PermissionGate>
  );
}
