"use client";

import "../admin/billing/_components/billingPhase3.css";
import "../admin/billing/_components/billingPhase4.css";
import "../admin/billing/_components/billingPhase5.css";
import "./billingWorkspace.css";
import Link from "next/link";
import { useState } from "react";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { apiGet } from "../../../services/apiClient";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { useAppContext } from "../../../hooks/useAppContext";
import { BillingActivityList } from "../../../components/billing/BillingActivityList";
import {
  dollars, formatDate, formatDateTime,
  invoiceStatusLabel, invoiceStatusClass,
  worstOpenInvoice, nextBillingSummary,
  nextOpenInvoiceDueSummary,
} from "../../../lib/billingUi";

type PreviewLineItem = {
  type: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
};

type InvoicePreview = {
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  lineItems: PreviewLineItem[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};

function greetingForNow(name: string): string {
  const hour = new Date().getHours();
  const first = name.split(" ").filter(Boolean)[0] || name || "there";
  if (hour < 12) return `Good morning, ${first} 👋`;
  if (hour < 18) return `Good afternoon, ${first} 👋`;
  return `Good evening, ${first} 👋`;
}

function invoiceDetailHref(id: string) {
  return `/billing/invoices/${encodeURIComponent(id)}`;
}

function invoicePayHref(invoice: any) {
  const status = String(invoice.status || "");
  const hasBalance = Number(invoice.balanceDueCents || 0) > 0;
  const publicPayUrl = String(invoice.publicPayUrl || "").trim();
  if (hasBalance && status !== "PAID" && status !== "VOID" && publicPayUrl) return publicPayUrl;
  return invoiceDetailHref(invoice.id);
}

function InvoicePreviewSection() {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadPreview() {
    if (preview) { setOpen((o) => !o); return; }
    setLoading(true);
    setError("");
    try {
      const data = await apiGet<InvoicePreview>("/billing/invoice-preview");
      setPreview(data);
      setOpen(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load preview.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="billing-unpaid-callout" style={{ marginTop: 8 }}>
      <div className="billing-unpaid-callout-head" style={{ alignItems: "center" }}>
        <span style={{ fontWeight: 600 }}>Estimated next invoice</span>
        <button
          className="btn ghost"
          type="button"
          style={{ fontSize: 12, padding: "4px 10px" }}
          onClick={() => void loadPreview()}
          disabled={loading}
        >
          {loading ? "Loading…" : open ? "Hide" : "Preview"}
        </button>
      </div>
      {error ? <p style={{ fontSize: 13, color: "var(--danger, #dc2626)", padding: "6px 0" }}>{error}</p> : null}
      {open && preview ? (
        <div style={{ padding: "8px 0" }}>
          <div style={{ fontSize: 12, background: "var(--surface-alt, #f8fafc)", border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, padding: "8px 12px", marginBottom: 10, color: "var(--muted, #475569)" }}>
            <strong>Preview only</strong> — no invoice is created. Period {formatDate(preview.periodStart)} – {formatDate(preview.periodEnd)} · Due {formatDate(preview.dueDate)}.
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <tbody>
              {preview.lineItems.map((item, idx) => (
                <tr key={idx} style={{ borderBottom: "1px solid var(--border-light, #f3f4f6)" }}>
                  <td style={{ padding: "4px 0" }}>{item.description}</td>
                  <td style={{ textAlign: "right", padding: "4px 0", color: item.amountCents < 0 ? "var(--danger, #dc2626)" : undefined, fontWeight: 500 }}>
                    {item.amountCents < 0 ? `(${dollars(-item.amountCents)})` : dollars(item.amountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: "1px solid var(--border, #e5e7eb)" }}>
                <td style={{ padding: "6px 0", fontWeight: 700 }}>Estimated total</td>
                <td style={{ textAlign: "right", padding: "6px 0", fontWeight: 700 }}>{dollars(preview.totalCents)}</td>
              </tr>
            </tfoot>
          </table>
          {preview.taxCents > 0 ? (
            <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Includes {dollars(preview.taxCents)} in taxes and fees.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

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
          {dollars(invoice.balanceDueCents)} is due
          {invoice.dueDate ? ` by ${formatDate(invoice.dueDate)}` : ""}.{" "}
          {isFailed
            ? "Update your card or pay manually to bring the account current."
            : "Pay now to avoid interruption."}
        </p>
        <div className="billing-alert-actions">
          <Link className="btn primary" href={invoicePayHref(invoice)}>
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
  const { user } = useAppContext();
  const settings = useAsyncResource(() => apiGet<any>("/billing/settings"), []);
  const invoices = useAsyncResource(() => apiGet<any[]>("/billing/platform/invoices"), []);
  const methods = useAsyncResource(() => apiGet<any[]>("/billing/payment-methods"), []);
  const usage = useAsyncResource(() => apiGet<any>("/billing/usage/current"), []);
  const invoicePreview = useAsyncResource(() => apiGet<InvoicePreview>("/billing/invoice-preview"), []);

  const allInvoices = invoices.status === "success" ? invoices.data : [];
  const openBalance = allInvoices
    .filter((inv) => !["PAID", "VOID"].includes(String(inv.status)) && Number(inv.balanceDueCents || 0) > 0)
    .reduce((sum, inv) => sum + Number(inv.balanceDueCents || 0), 0);
  const worst = worstOpenInvoice(allInvoices);
  const unpaid = allInvoices.filter((inv) => ["OPEN", "FAILED", "OVERDUE", "DRAFT"].includes(String(inv.status)) && Number(inv.balanceDueCents || 0) > 0);
  const recentPaid = allInvoices
    .filter((inv) => inv.status === "PAID" && inv.paidAt)
    .sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime())
    .slice(0, 3);

  const pmRows = methods.status === "success" ? methods.data : [];
  const defaultPm = pmRows.find((m: any) => m.isDefault) || pmRows[0] || null;

  const s = settings.status === "success" ? settings.data : null;
  const nextBill = s ? nextBillingSummary(s.billingDayOfMonth, !!s.autoBillingEnabled) : null;
  const autopayLabel = s?.autoBillingEnabled
    ? (s.billingDayOfMonth ? `Day ${s.billingDayOfMonth}` : "Enabled")
    : "Off";

  const loading = settings.status === "loading" || invoices.status === "loading";

  const timelineId = worst?.id || (allInvoices[0]?.id ?? null);
  const timeline = useAsyncResource<any | null>(
    () => (timelineId ? apiGet<any>(`/billing/platform/invoices/${timelineId}`) : Promise.resolve(null)),
    [timelineId],
  );

  return (
    <PermissionGate permission="can_view_billing_overview" fallback={<div className="state-box">You do not have billing access.</div>}>
      <div className="billing-workspace" data-testid="billing-tenant-overview-loaded">
        <PageHeader title="Billing" subtitle="Premium customer billing workspace — balance, autopay, invoice history." />

        {loading ? <LoadingSkeleton rows={4} /> : null}
        {settings.status === "error" ? <ErrorState message={settings.error} /> : null}
        {invoices.status === "error" ? <ErrorState message={invoices.error} /> : null}

        {/* Hero */}
        <section className="bw-hero billing-card">
          <div className="bw-hero-main">
            <h2>{greetingForNow(user?.name || "")}</h2>
            <p className="muted">
              {openBalance > 0
                ? `You have ${unpaid.length} unpaid invoice${unpaid.length !== 1 ? "s" : ""}.`
                : "Your account is in good standing."}
            </p>
          </div>
          <div className="bw-hero-actions">
            {openBalance > 0 && worst ? (
              <Link className="btn primary" href={invoicePayHref(worst)}>
                Pay {dollars(openBalance)}
              </Link>
            ) : null}
          </div>
        </section>

        {/* KPI row */}
        {!loading && s ? (
          <section className="bw-kpi-grid">
            <div className="billing-card bw-kpi">
              <div className="bw-kpi-label">Current balance</div>
              <div className={`bw-kpi-value ${openBalance > 0 ? "neg" : ""}`}>{dollars(openBalance)}</div>
              <div className="bw-kpi-sub">{nextOpenInvoiceDueSummary(allInvoices) || (openBalance === 0 ? "No balance due" : "")}</div>
              {openBalance > 0 && worst ? (
                <div className="bw-kpi-cta"><Link className="btn primary" href={invoicePayHref(worst)}>Pay now</Link></div>
              ) : null}
            </div>
            <div className="billing-card bw-kpi">
              <div className="bw-kpi-label">Next autopay</div>
              <div className="bw-kpi-value">{s?.autoBillingEnabled ? (s.billingDayOfMonth ? `Day ${s.billingDayOfMonth}` : "Enabled") : "Off"}</div>
              <div className="bw-kpi-sub">{nextBill || (s?.autoBillingEnabled ? "Auto-billing on" : "Autopay is off")}</div>
            </div>
            <div className="billing-card bw-kpi">
              <div className="bw-kpi-label">Payment method</div>
              <div className="bw-kpi-value">
                {defaultPm ? `${defaultPm.brand || "Card"} ···${defaultPm.last4 || "••••"}` : "None"}
              </div>
              <div className="bw-kpi-sub">
                {defaultPm?.expMonth && defaultPm?.expYear ? `Expires ${defaultPm.expMonth}/${String(defaultPm.expYear).slice(-2)}` : s?.defaultPaymentMethodId ? "Default" : "No card on file"}
              </div>
              <div className="bw-kpi-cta"><Link className="btn ghost" href="/billing/payments">{defaultPm ? "Manage" : "Add card"}</Link></div>
            </div>
            <div className="billing-card bw-kpi">
              <div className="bw-kpi-label">Estimated next invoice</div>
              <div className="bw-kpi-value">{invoicePreview.status === "success" ? dollars(invoicePreview.data?.totalCents) : "—"}</div>
              <div className="bw-kpi-sub">{invoicePreview.status === "success" ? `${formatDate(invoicePreview.data.periodStart)} – ${formatDate(invoicePreview.data.periodEnd)}` : "Preview pending"}</div>
              <div className="bw-kpi-cta"><a className="btn ghost" href="#estimate">View estimate</a></div>
            </div>
            <div className="billing-card bw-kpi">
              <div className="bw-kpi-label">Active services</div>
              <div className="bw-kpi-value">{usage.status === "success" ? String(usage.data.extensionCount || 0) : "—"}</div>
              <div className="bw-kpi-sub">{usage.status === "success" ? `${usage.data.localPhoneNumberCount + usage.data.tollFreePhoneNumberCount} phone numbers` : "Extensions"}</div>
            </div>
            <div className="billing-card bw-kpi">
              <div className="bw-kpi-label">Billing health</div>
              <div className={`bw-kpi-value ${worst ? (worst.status === "FAILED" || worst.status === "OVERDUE" ? "neg" : "") : "pos"}`}>
                {worst ? invoiceStatusLabel(worst.status) : "Good standing"}
              </div>
              <div className="bw-kpi-sub">{worst ? (worst.dueDate ? `Due ${formatDate(worst.dueDate)}` : "Open balance") : "Thank you!"}</div>
            </div>
          </section>
        ) : null}

        {/* Unpaid banner */}
        {!loading && worst ? <FailedPaymentBanner invoice={worst} /> : null}

        {/* Body grid: estimate · timeline · recent */}
        <section className="bw-main-grid">
          <div className="billing-card" id="estimate">
            <div className="bw-section-head">
              <h3>Estimated next invoice preview</h3>
              <Link className="btn ghost" href="/billing/invoices">View full estimate</Link>
            </div>
            {invoicePreview.status === "loading" ? <LoadingSkeleton rows={3} /> : null}
            {invoicePreview.status === "error" ? <ErrorState message={invoicePreview.error} /> : null}
            {invoicePreview.status === "success" && invoicePreview.data?.lineItems?.length ? (
              <div className="bw-estimate-table-wrap">
                <table className="bw-estimate-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Qty</th>
                      <th>Unit price</th>
                      <th>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoicePreview.data.lineItems.map((item, idx) => (
                      <tr key={idx}>
                        <td>{item.description}</td>
                        <td className="num">{item.quantity ?? "—"}</td>
                        <td className="num">{item.unitPriceCents != null ? dollars(item.unitPriceCents) : "—"}</td>
                        <td className={`num ${item.amountCents < 0 ? "neg" : ""}`}>
                          {item.amountCents < 0 ? `(${dollars(-item.amountCents)})` : dollars(item.amountCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3}>Estimated total</td>
                      <td className="num">{dollars(invoicePreview.data.totalCents)}</td>
                    </tr>
                  </tfoot>
                </table>
                {invoicePreview.data.taxCents > 0 ? (
                  <p className="muted" style={{ marginTop: 8 }}>Includes {dollars(invoicePreview.data.taxCents)} in taxes and fees.</p>
                ) : null}
              </div>
            ) : (
              <div className="state-box">Estimate not available.</div>
            )}
          </div>

          <div className="billing-card">
            <div className="bw-section-head"><h3>Billing timeline</h3></div>
            {timeline.status === "loading" ? <LoadingSkeleton rows={3} /> : null}
            {timeline.status === "success" && timeline.data?.events?.length ? (
              <BillingActivityList events={timeline.data.events} />
            ) : (
              <div className="state-box">No recent billing activity.</div>
            )}
          </div>

          <div className="billing-card">
            <div className="bw-section-head">
              <h3>Recent invoices</h3>
              <Link className="btn ghost" href="/billing/invoices">View all</Link>
            </div>
            {!loading && allInvoices.slice(0, 5).length ? (
              <div className="bw-invoice-list">
                {allInvoices.slice(0, 5).map((inv) => (
                  <Link className="bw-invoice-row" key={inv.id} href={invoiceDetailHref(inv.id)}>
                    <div className="bw-invoice-id">
                      <strong>{inv.invoiceNumber || inv.id.slice(0, 8)}</strong>
                      <small className="muted">{inv.periodStart && inv.periodEnd ? `${formatDate(inv.periodStart)} – ${formatDate(inv.periodEnd)}` : "—"}</small>
                    </div>
                    <span className={`billing-status-pill ${invoiceStatusClass(inv.status)}`}>
                      {invoiceStatusLabel(inv.status)}
                    </span>
                    <div className="bw-invoice-amt">{dollars(inv.totalCents)}</div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="state-box">No invoices yet.</div>
            )}
          </div>
        </section>

        {/* Trust & security footer */}
        <section className="bw-trust">
          <div className="bw-trust-item"><strong>Secure & Encrypted</strong><span>256-bit SSL protection</span></div>
          <div className="bw-trust-item"><strong>PCI Compliant</strong><span>Your data is safe with us</span></div>
          <div className="bw-trust-item"><strong>AutoPay Protection</strong><span>Retry and reminders</span></div>
          <div className="bw-trust-item"><strong>Trusted</strong><span>Reliable payments</span></div>
          <div className="bw-trust-accept">We accept <span>VISA</span> <span>MASTERCARD</span> <span>AMEX</span> <span>DISCOVER</span></div>
          <div className="bw-trust-sola">Secured by SOLA · Your payment data is encrypted and securely processed.</div>
        </section>

        {/* Quick links */}
        <div className="bw-quick-links">
          <Link className="btn ghost" href="/billing/invoices">Invoices</Link>
          <Link className="btn ghost" href="/billing/payments">Payment methods</Link>
          <Link className="btn ghost" href="/billing/receipts">Receipts</Link>
          <PermissionGate permission="can_view_settings_billing" fallback={null}>
            <Link className="btn ghost" href="/billing/settings">Billing settings</Link>
          </PermissionGate>
        </div>
      </div>
    </PermissionGate>
  );
}
