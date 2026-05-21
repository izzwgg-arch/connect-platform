"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import "../../../admin/billing/_components/billingPhase3.css";
import "../../../admin/billing/_components/billingPhase4.css";
import "../../../admin/billing/_components/billingPhase5.css";
import "./invoicePrint.css";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
import { apiGet, apiPost, getPortalApiBaseUrl } from "../../../../../services/apiClient";
import { ErrorState } from "../../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { BillingPageChrome, billingErrorMessage } from "../../../../../components/BillingActionToast";
import {
  billingEventIcon,
  billingEventLabel,
  dollars,
  formatDate,
  formatDateTime,
  invoiceStatusClass,
  invoiceStatusLabel,
  transactionStatusClass,
  transactionStatusLabel,
} from "../../../../../lib/billingUi";

type InvoiceLineItem = {
  id?: string;
  type?: string | null;
  description?: string | null;
  quantity?: number | string | null;
  unitPriceCents?: number | null;
  amountCents?: number | null;
};

type TotalsRow = {
  id: string;
  label: string;
  valueCents: number;
  tone?: "default" | "credit" | "tax" | "paid" | "due";
};

function invoicePortalUrl(id: string) {
  const base = typeof window !== "undefined" ? window.location.origin : "https://app.connectcomunications.com";
  return `${base}/billing/invoices/${encodeURIComponent(id)}`;
}

function publicPayUrl(row: any) {
  const url = String(row?.publicPayUrl || "").trim();
  if (url) return url;
  return invoicePortalUrl(row.id);
}

function openPdf(id: string) {
  const token = localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  window.open(`${getPortalApiBaseUrl()}/billing/platform/invoices/${encodeURIComponent(id)}/pdf${qs}`, "_blank", "noopener,noreferrer");
}

function normalizeText(value: unknown) {
  return String(value || "").toLowerCase();
}

function classifyLineItem(item: InvoiceLineItem): { label: string; tone: "service" | "tax" | "fee" | "credit" } {
  const raw = `${item.type || ""} ${item.description || ""}`;
  const text = normalizeText(raw);
  if (text.includes("discount") || text.includes("credit")) return { label: "Credit", tone: "credit" };
  if (text.includes("e911") || text.includes("911")) return { label: "E911", tone: "fee" };
  if (text.includes("usf") || text.includes("fusf") || text.includes("universal service")) return { label: "USF", tone: "fee" };
  if (text.includes("trs") || text.includes("relay")) return { label: "TRS", tone: "fee" };
  if (text.includes("regulatory") || text.includes("recovery") || text.includes("surcharge")) return { label: "Regulatory", tone: "fee" };
  if (text.includes("tax")) return { label: "Tax", tone: "tax" };
  return { label: "Service", tone: "service" };
}

function sumApprovedPayments(transactions: any[]) {
  return transactions
    .filter((tx) => String(tx.status || "").toUpperCase() === "APPROVED")
    .reduce((sum, tx) => sum + Number(tx.amountCents || 0), 0);
}

function buildTotalsRows(row: any, lineItems: InvoiceLineItem[], transactions: any[]): TotalsRow[] {
  const subtotal = Number(row.subtotalCents ?? 0);
  const total = Number(row.totalCents ?? 0);
  const taxFromInvoice = Number(row.taxCents ?? 0);
  const paid = Math.max(0, total - Number(row.balanceDueCents ?? total), sumApprovedPayments(transactions));
  const discount = Math.abs(
    lineItems
      .filter((item) => classifyLineItem(item).tone === "credit")
      .reduce((sum, item) => sum + Math.min(0, Number(item.amountCents || 0)), 0),
  );
  const feeTotal = lineItems
    .filter((item) => classifyLineItem(item).tone === "fee")
    .reduce((sum, item) => sum + Math.max(0, Number(item.amountCents || 0)), 0);
  const taxTotal = taxFromInvoice || lineItems
    .filter((item) => classifyLineItem(item).tone === "tax")
    .reduce((sum, item) => sum + Math.max(0, Number(item.amountCents || 0)), 0);

  const rows: TotalsRow[] = [
    { id: "subtotal", label: "Service subtotal", valueCents: subtotal },
  ];
  if (discount > 0) rows.push({ id: "discount", label: "Discounts / credits", valueCents: -discount, tone: "credit" });
  if (feeTotal > 0) rows.push({ id: "fees", label: "Telecom fees & surcharges", valueCents: feeTotal, tone: "tax" });
  if (taxTotal > 0) rows.push({ id: "tax", label: "Taxes", valueCents: taxTotal, tone: "tax" });
  rows.push({ id: "paid", label: "Amount paid", valueCents: -paid, tone: "paid" });
  rows.push({ id: "due", label: "Balance due", valueCents: Number(row.balanceDueCents ?? total), tone: "due" });
  return rows;
}

function splitPlainText(value: unknown): string[] {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function regulatoryNotices(settings: any, row: any): string[] {
  const supportEmail = String(settings?.invoiceSupportEmail || settings?.billingEmail || "").trim();
  const supportPhone = String(settings?.invoiceSupportPhone || "").trim();
  const terms = Number(settings?.paymentTermsDays ?? 15);
  const notices = [
    "Taxes, telecom fees, and regulatory surcharges are itemized when applicable to your service, service address, jurisdiction, and configured billing profile.",
    "E911 charges, if shown, support emergency calling obligations and may vary by location, number count, or service configuration.",
    "Regulatory recovery, Federal Universal Service Fund (USF/FUSF), and Telecommunications Relay Service (TRS) related charges are displayed when applicable; they are not represented here as taxes unless labeled as taxes.",
    `Payment terms are Net ${terms} days unless a different written agreement applies. Past-due balances may be subject to collection handling or late-fee policies configured by your provider.`,
  ];

  if (supportEmail || supportPhone) {
    notices.push(`For billing questions, disputes, or remittance support, contact ${[supportEmail, supportPhone].filter(Boolean).join(" or ")}. Include invoice ${row.invoiceNumber || row.id} with your request.`);
  } else {
    notices.push(`For billing questions, disputes, or remittance support, contact your Connect billing administrator and include invoice ${row.invoiceNumber || row.id}.`);
  }

  return [...notices, ...splitPlainText(settings?.invoiceFooterNote)];
}

export default function BillingInvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const invoice = useAsyncResource(() => apiGet<any>(`/billing/platform/invoices/${params.id}`), [params.id, refreshKey]);
  const settings = useAsyncResource(() => apiGet<any>("/billing/settings"), [refreshKey]);

  const showToast = useCallback((kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const bump = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const row = invoice.status === "success" ? invoice.data : null;
  const settingsData = settings.status === "success" ? settings.data : null;
  const billingEmailSet = !!String(settingsData?.billingEmail || "").trim();
  const canPay = row && row.status !== "PAID" && row.status !== "VOID" && Number(row.balanceDueCents ?? row.totalCents ?? 0) > 0;
  const transactions: any[] = row?.transactions || [];
  const events: any[] = (row?.events || [])
    .slice()
    .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const lineItems: InvoiceLineItem[] = row?.lineItems || [];
  const period =
    row?.periodStart && row?.periodEnd
      ? `${formatDate(row.periodStart)} - ${formatDate(row.periodEnd)}`
      : null;
  const payUrl = row ? publicPayUrl(row) : "";
  const totalRows = useMemo(() => (row ? buildTotalsRows(row, lineItems, transactions) : []), [row, lineItems, transactions]);

  async function runAction(key: string, fn: () => Promise<void>) {
    setPending(key);
    try { await fn(); }
    catch (err) { showToast("err", billingErrorMessage(err, "Request failed")); }
    finally { setPending(null); }
  }

  return (
    <PermissionGate permission="can_view_billing_invoices" fallback={<div className="state-box">You do not have invoice access.</div>}>
      <BillingPageChrome toast={toast}>
        <div className="billing-html-page billing-p5-scope">
          <div className="invoice-screen-actions no-print">
            <Link className="btn ghost" href="/billing/invoices">Back to invoices</Link>
            <button className="btn ghost" type="button" onClick={() => window.print()}>Print / save PDF</button>
            {row ? <button className="btn ghost" type="button" onClick={() => openPdf(row.id)}>Download PDF</button> : null}
            {billingEmailSet && row ? (
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
                {pending === "email-inv" ? "Sending..." : "Email invoice"}
              </button>
            ) : null}
          </div>

          {invoice.status === "loading" && !invoice.refreshing ? <LoadingSkeleton rows={6} /> : null}
          {invoice.status === "error" ? <ErrorState message={invoice.error} /> : null}
          {settings.status === "error" ? <ErrorState message={settings.error} /> : null}

          {row ? (
            <article className="invoice-document" aria-label={`Invoice ${row.invoiceNumber || row.id}`}>
              <header className="invoice-hero">
                <div className="invoice-brand-lockup">
                  <img src="/connect-logo.png" alt="Connect Communications" className="invoice-logo" />
                  <div>
                    <p className="invoice-eyebrow">Enterprise VoIP billing</p>
                    <h1>Invoice</h1>
                  </div>
                </div>
                <div className="invoice-identity">
                  <span className={`invoice-status ${invoiceStatusClass(row.status)}`}>{invoiceStatusLabel(row.status)}</span>
                  <strong>{row.invoiceNumber || row.id}</strong>
                  <span>Issued {formatDate(row.createdAt || row.issueDate)}</span>
                </div>
              </header>

              <section className="invoice-command-grid">
                <div className="invoice-party-card">
                  <span className="invoice-section-kicker">Bill from</span>
                  <h2>{settingsData?.invoiceCompanyName || "Connect Communications"}</h2>
                  {settingsData?.invoiceSupportEmail ? <p>{settingsData.invoiceSupportEmail}</p> : null}
                  {settingsData?.invoiceSupportPhone ? <p>{settingsData.invoiceSupportPhone}</p> : null}
                </div>
                <div className="invoice-party-card">
                  <span className="invoice-section-kicker">Bill to</span>
                  <h2>{row.tenant?.name || "Customer"}</h2>
                  {settingsData?.billingEmail ? <p>{settingsData.billingEmail}</p> : null}
                  <p>{period || "Service period on invoice"}</p>
                </div>
                <div className="invoice-payment-card">
                  <span className="invoice-section-kicker">Balance due</span>
                  <strong>{dollars(row.balanceDueCents ?? row.totalCents)}</strong>
                  <p>Due {formatDate(row.dueDate)} Â· Terms Net {settingsData?.paymentTermsDays ?? 15}</p>
                  {canPay ? (
                    <a className="invoice-pay-button no-print" href={payUrl}>
                      Pay Invoice Securely
                    </a>
                  ) : (
                    <span className="invoice-paid-note">{row.status === "PAID" ? `Paid ${row.paidAt ? formatDate(row.paidAt) : ""}` : "No payment due"}</span>
                  )}
                  <small>Manual payment URL: <span>{payUrl}</span></small>
                </div>
              </section>

              <section className="invoice-metadata-strip">
                <div><span>Invoice date</span><strong>{formatDate(row.createdAt || row.issueDate)}</strong></div>
                <div><span>Due date</span><strong>{formatDate(row.dueDate)}</strong></div>
                <div><span>Service period</span><strong>{period || "â€”"}</strong></div>
                <div><span>Total</span><strong>{dollars(row.totalCents)}</strong></div>
              </section>

              <section className="invoice-section invoice-lines-section">
                <div className="invoice-section-heading">
                  <div>
                    <span className="invoice-section-kicker">Services & usage</span>
                    <h2>Line items</h2>
                  </div>
                  <p>Voice platform services, usage, credits, taxes, and telecom surcharges itemized for review.</p>
                </div>

                <div className="invoice-lines-table">
                  <div className="invoice-lines-head">
                    <span>Description</span>
                    <span>Qty</span>
                    <span>Rate</span>
                    <span>Amount</span>
                  </div>
                  {lineItems.length > 0 ? lineItems.map((item, index) => {
                    const cls = classifyLineItem(item);
                    return (
                      <div className="invoice-line-row" key={item.id || `${item.description}-${index}`}>
                        <div>
                          <span className={`invoice-line-type ${cls.tone}`}>{cls.label}</span>
                          <strong>{item.description || "Billing item"}</strong>
                        </div>
                        <span>{String(item.quantity ?? 1)}</span>
                        <span>{dollars(item.unitPriceCents)}</span>
                        <strong>{dollars(item.amountCents)}</strong>
                      </div>
                    );
                  }) : (
                    <div className="invoice-line-empty">No line items are attached to this invoice.</div>
                  )}
                </div>
              </section>

              <section className="invoice-bottom-grid">
                <div className="invoice-section invoice-notes-card">
                  <span className="invoice-section-kicker">Payment instructions</span>
                  {splitPlainText(settingsData?.invoicePaymentInstructions).length > 0 ? (
                    splitPlainText(settingsData?.invoicePaymentInstructions).map((line) => <p key={line}>{line}</p>)
                  ) : (
                    <p>Pay securely online from this invoice page. For ACH, wire, check, or remittance instructions, contact billing support before sending payment.</p>
                  )}
                </div>

                <div className="invoice-summary-card">
                  <span className="invoice-section-kicker">Billing summary</span>
                  {totalRows.map((item) => (
                    <div className={`invoice-total-row ${item.tone || "default"}`} key={item.id}>
                      <span>{item.label}</span>
                      <strong>{dollars(item.valueCents)}</strong>
                    </div>
                  ))}
                </div>
              </section>

              <section className="invoice-section invoice-regulatory-card">
                <div className="invoice-section-heading">
                  <div>
                    <span className="invoice-section-kicker">Regulatory & billing notices</span>
                    <h2>Telecom billing disclosures</h2>
                  </div>
                </div>
                <ul>
                  {regulatoryNotices(settingsData, row).map((notice) => <li key={notice}>{notice}</li>)}
                </ul>
              </section>

              {transactions.length > 0 ? (
                <section className="invoice-section invoice-history-section no-print">
                  <div className="invoice-section-heading">
                    <div>
                      <span className="invoice-section-kicker">Payments</span>
                      <h2>Payment history</h2>
                    </div>
                  </div>
                  <div className="invoice-history-list">
                    {transactions.map((tx) => (
                      <div className="invoice-history-row" key={tx.id}>
                        <span>{dollars(tx.amountCents)} Â· {formatDateTime(tx.createdAt)}</span>
                        <span className={`billing-status-pill ${transactionStatusClass(tx.status)}`}>{transactionStatusLabel(tx.status)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              <section className="invoice-section invoice-history-section no-print">
                <div className="invoice-section-heading">
                  <div>
                    <span className="invoice-section-kicker">Audit trail</span>
                    <h2>Activity</h2>
                  </div>
                </div>
                {events.length > 0 ? (
                  <div className="invoice-timeline">
                    {events.map((e) => (
                      <div className="invoice-timeline-row" key={e.id}>
                        <span aria-hidden>{billingEventIcon(e.type)}</span>
                        <div>
                          <strong>{billingEventLabel(e.type)}</strong>
                          <small>{formatDateTime(e.createdAt)}</small>
                          {e.message ? <p>{e.message}</p> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="invoice-muted">Payments, emails, and status changes will appear here.</p>
                )}
              </section>
            </article>
          ) : null}
        </div>
      </BillingPageChrome>
    </PermissionGate>
  );
}
