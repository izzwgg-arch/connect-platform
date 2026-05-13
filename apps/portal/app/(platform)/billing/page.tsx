"use client";

import Link from "next/link";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { apiGet } from "../../../services/apiClient";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import {
  dollars, formatDate, formatDateTime,
  invoiceStatusLabel, invoiceStatusClass,
  worstOpenInvoice, nextBillingSummary,
} from "../../../lib/billingUi";

function FailedPaymentBanner({ invoice }: { invoice: any }) {
  const isFailed = invoice.status === "FAILED";
  const isOverdue = invoice.status === "OVERDUE";
  if (!isFailed && !isOverdue) return null;
  return (
    <div className={`billing-alert-banner ${isFailed ? "" : "warn"}`} role="alert">
      <span className="billing-alert-icon">{isFailed ? "⚠️" : "🔔"}</span>
      <div className="billing-alert-body">
        <strong>
          {isFailed ? "Payment failed" : "Invoice overdue"} — {invoice.invoiceNumber}
        </strong>
        <p>
          {dollars(invoice.balanceDueCents)} due
          {invoice.dueDate ? ` · Due ${formatDate(invoice.dueDate)}` : ""}.{" "}
          {isFailed
            ? "Update your payment method or pay manually."
            : "This invoice is past due. Pay now to avoid service interruption."}
        </p>
        <div className="billing-alert-actions">
          <Link className="btn primary" href={`/billing/invoices/${invoice.id}`}>
            Pay now
          </Link>
          <Link className="btn ghost" href="/billing/payments">
            Update payment method
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function BillingOverviewPage() {
  const settings = useAsyncResource(() => apiGet<any>("/billing/settings"), []);
  const invoices = useAsyncResource(() => apiGet<any[]>("/billing/platform/invoices"), []);

  const allInvoices = invoices.status === "success" ? invoices.data : [];
  const openBalance = allInvoices.reduce((sum, inv) => sum + Number(inv.balanceDueCents || 0), 0);
  const worst = worstOpenInvoice(allInvoices);
  const unpaid = allInvoices.filter((inv) => ["OPEN", "FAILED", "OVERDUE", "DRAFT"].includes(String(inv.status)));
  const recentPaid = allInvoices
    .filter((inv) => inv.status === "PAID" && inv.paidAt)
    .sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime())
    .slice(0, 3);

  const s = settings.status === "success" ? settings.data : null;
  const nextBill = s ? nextBillingSummary(s.billingDayOfMonth, !!s.autoBillingEnabled) : null;
  const defaultCard = s?.defaultPaymentMethodId ? "On file" : "None";
  const autopayLabel = s?.autoBillingEnabled
    ? (s.billingDayOfMonth ? `Day ${s.billingDayOfMonth}` : "Enabled")
    : "Off";

  const loading = settings.status === "loading" || invoices.status === "loading";

  return (
    <PermissionGate permission="can_view_billing_overview" fallback={<div className="state-box">You do not have billing access.</div>}>
      <div className="stack compact-stack billing-admin-shell">
        <PageHeader title="Billing" subtitle="Invoices, payments, and account balance." />

        {loading ? <LoadingSkeleton rows={4} /> : null}
        {settings.status === "error" ? <ErrorState message={settings.error} /> : null}
        {invoices.status === "error" ? <ErrorState message={invoices.error} /> : null}

        {/* Failed / overdue banner */}
        {!loading && worst ? <FailedPaymentBanner invoice={worst} /> : null}

        {/* 3-stat summary */}
        {!loading && s ? (
          <div className="billing-stat-grid">
            <div className="billing-stat-card">
              <span className="stat-label">Balance due</span>
              <span className={`stat-value ${openBalance > 0 ? "bad" : ""}`}>{dollars(openBalance)}</span>
              {openBalance > 0 ? (
                <span className="stat-sub">
                  {unpaid.length} unpaid invoice{unpaid.length !== 1 ? "s" : ""}
                </span>
              ) : (
                <span className="stat-sub">All clear</span>
              )}
            </div>
            <div className="billing-stat-card">
              <span className="stat-label">Autopay</span>
              <span className="stat-value">{autopayLabel}</span>
              {nextBill ? <span className="stat-sub">{nextBill}</span> : null}
            </div>
            <div className="billing-stat-card">
              <span className="stat-label">Default card</span>
              <span className="stat-value">{defaultCard}</span>
              {!s.defaultPaymentMethodId ? (
                <span className="stat-cta">
                  <Link className="btn ghost" style={{ fontSize: 12, padding: "4px 10px" }} href="/billing/payments">
                    Add card
                  </Link>
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Unpaid invoices callout */}
        {!loading && unpaid.length > 0 ? (
          <div className="billing-unpaid-callout">
            <div className="billing-unpaid-callout-head">
              <span>Unpaid invoices ({unpaid.length})</span>
              <Link className="btn ghost" style={{ fontSize: 12, padding: "4px 10px" }} href="/billing/invoices">
                View all
              </Link>
            </div>
            {unpaid.slice(0, 4).map((inv) => (
              <div className="billing-unpaid-item" key={inv.id}>
                <span>
                  <strong>{inv.invoiceNumber || inv.id}</strong>
                  <small>Due {formatDate(inv.dueDate)}</small>
                </span>
                <span className={`billing-status-pill ${invoiceStatusClass(inv.status)}`}>
                  {invoiceStatusLabel(inv.status)}
                </span>
                <div className="row-actions">
                  <Link className="btn primary" style={{ fontSize: 12, padding: "5px 12px" }} href={`/billing/invoices/${inv.id}`}>
                    {inv.status === "FAILED" ? "Pay now" : dollars(inv.balanceDueCents)}
                  </Link>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* Recent payments */}
        {!loading && recentPaid.length > 0 ? (
          <div className="billing-unpaid-callout">
            <div className="billing-unpaid-callout-head">
              <span>Recent payments</span>
              <Link className="btn ghost" style={{ fontSize: 12, padding: "4px 10px" }} href="/billing/receipts">
                All receipts
              </Link>
            </div>
            {recentPaid.map((inv) => (
              <div className="billing-recent-item" key={inv.id}>
                <span>
                  <strong>{inv.invoiceNumber}</strong>
                  <small style={{ color: "var(--muted)" }}>{formatDateTime(inv.paidAt)}</small>
                </span>
                <span className="billing-status-pill good">Paid</span>
                <strong>{dollars(inv.totalCents)}</strong>
              </div>
            ))}
          </div>
        ) : null}

        {/* Empty state when all paid */}
        {!loading && allInvoices.length > 0 && unpaid.length === 0 && openBalance === 0 ? (
          <div className="state-box" style={{ textAlign: "center" }}>
            <p style={{ fontSize: 16, fontWeight: 600, margin: "0 0 4px" }}>✓ All paid</p>
            <p className="muted">No unpaid invoices. Your account is current.</p>
          </div>
        ) : null}

        {/* Quick nav */}
        {!loading ? (
          <div className="row-actions" style={{ flexWrap: "wrap" }}>
            <Link className="btn ghost" href="/billing/invoices">View invoices</Link>
            <Link className="btn ghost" href="/billing/payments">Payment methods</Link>
            <Link className="btn ghost" href="/billing/receipts">Receipts</Link>
            <PermissionGate permission="can_view_settings_billing" fallback={null}>
              <Link className="btn ghost" href="/billing/settings">Billing settings</Link>
            </PermissionGate>
          </div>
        ) : null}
      </div>
    </PermissionGate>
  );
}
