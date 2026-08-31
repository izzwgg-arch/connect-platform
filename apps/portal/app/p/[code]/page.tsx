"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { CardknoxIFieldsForm, type CardknoxBillingFields } from "../../../components/billing/CardknoxIFieldsForm";
import { PaymentTrustBadge } from "../../../components/billing/PaymentTrustBadge";
import { PayCardTop } from "../../../components/billing/PayCardTop";
import { PayInvoiceList, type PayInvoiceLine } from "../../../components/billing/PayInvoiceList";
import { useAppContext } from "../../../hooks/useAppContext";
import { readAuthToken } from "../../../services/session";
import { resolveSameOriginApiBase } from "../../../lib/publicApiBase";
import "../../pay/invoice/[token]/pay-invoice.css";
import "./pay-link.css";

/** Same-origin on purpose — this page is served on more than one hostname and a
 *  hardcoded domain makes every fetch here a CORS failure on the other one. */
const apiBase = resolveSameOriginApiBase(process.env.NEXT_PUBLIC_API_URL);

type PayLinkInvoiceRow = {
  invoiceId?: string;
  invoiceNumber: string;
  status: string;
  alreadyPaid: boolean;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  issueDate?: string | null;
  subtotalCents?: number;
  taxCents?: number;
  totalCents: number;
  balanceDueCents: number;
  lineItems?: PayInvoiceLine[];
};

type PayLinkView = {
  code: string;
  companyName: string;
  linkStatus: string;
  currency: string;
  totalDueCents: number;
  canPay: boolean;
  invoices: PayLinkInvoiceRow[];
};

type PublicConfig = {
  ifieldsKey: string;
  ifieldsVersion: string;
  mode: string;
  canPay: boolean;
};

type PayTheme = "light" | "dark";

function dollars(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents || 0) / 100);
}

function billingXExp(billing: CardknoxBillingFields): string | null {
  const month = billing.expMonth.replace(/\D/g, "").padStart(2, "0").slice(-2);
  const yearDigits = billing.expYear.replace(/\D/g, "");
  const year = yearDigits.length >= 4 ? yearDigits.slice(-2) : yearDigits.padStart(2, "0");
  if (!/^(0[1-9]|1[0-2])$/.test(month) || !/^\d{2}$/.test(year)) return null;
  return `${month}${year}`;
}


function normalizePayTheme(value: string | null | undefined): PayTheme | null {
  return value === "dark" || value === "light" ? value : null;
}

export default function PublicBillingPayLinkPage() {
  const params = useParams<{ code: string }>();
  const search = useSearchParams();
  const code = params?.code;
  const { theme } = useAppContext();
  const [systemTheme, setSystemTheme] = useState<PayTheme>("light");
  const queryTheme = normalizePayTheme(search.get("theme"));
  const appTheme = normalizePayTheme(theme);
  const payTheme = queryTheme ?? appTheme ?? systemTheme;
  const [view, setView] = useState<PayLinkView | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loadError, setLoadError] = useState("");
  const [payError, setPayError] = useState("");
  const [paid, setPaid] = useState(false);
  const [paidInvoices, setPaidInvoices] = useState<string[]>([]);
  const [paymentCompleted, setPaymentCompleted] = useState(false);
  const [saveCard, setSaveCard] = useState(false);
  const submitInFlightRef = useRef(false);
  const result = search.get("result");

  const load = useCallback(async () => {
    if (!code) return;
    setLoadError("");
    const [viewRes, cfgRes] = await Promise.all([
      fetch(`${apiBase}/billing/platform/pay-links/${encodeURIComponent(code)}`),
      fetch(`${apiBase}/billing/platform/pay-links/${encodeURIComponent(code)}/public-config`),
    ]);
    const viewJson = await viewRes.json().catch(() => null);
    const cfgJson = await cfgRes.json().catch(() => null);
    if (!viewRes.ok) {
      const err = String(viewJson?.error || "");
      setLoadError(
        err === "pay_link_expired"
          ? "This payment link has expired. Please contact billing for a new link."
          : "This payment link is invalid or no longer available.",
      );
      return;
    }
    setView(viewJson as PayLinkView);
    if (viewJson.linkStatus === "COMPLETED" || (viewJson.totalDueCents <= 0 && viewJson.invoices?.length)) {
      setPaid(true);
      return;
    }
    if (!cfgRes.ok || !cfgJson?.ifieldsKey) {
      setLoadError("Online payment is not available right now. Please contact billing support.");
      return;
    }
    setConfig(cfgJson as PublicConfig);
  }, [code]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemTheme = () => setSystemTheme(media.matches ? "dark" : "light");
    syncSystemTheme();
    media.addEventListener("change", syncSystemTheme);
    return () => media.removeEventListener("change", syncSystemTheme);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousRootHeight = root.style.height;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyHeight = body.style.height;
    root.style.overflow = "auto";
    root.style.height = "auto";
    body.style.overflow = "auto";
    body.style.height = "auto";
    return () => {
      root.style.overflow = previousRootOverflow;
      root.style.height = previousRootHeight;
      body.style.overflow = previousBodyOverflow;
      body.style.height = previousBodyHeight;
    };
  }, []);

  useEffect(() => {
    if (!paymentCompleted && result !== "success") return;
    const target = readAuthToken() ? "/dashboard" : "/login";
    const timeout = window.setTimeout(() => {
      window.location.assign(target);
    }, 3000);
    return () => window.clearTimeout(timeout);
  }, [paymentCompleted, result]);

  async function submitPayment(payload: {
    cardToken: string;
    billing: CardknoxBillingFields;
    saveCard: boolean;
    enableAutopay: boolean;
  }) {
    if (!code) return;
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setPayError("");
    try {
      const xExp = billingXExp(payload.billing);
      if (!xExp) {
        setPayError("Enter a valid expiration month and year.");
        return;
      }
      const res = await fetch(`${apiBase}/billing/platform/pay-links/${encodeURIComponent(code)}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          xSut: payload.cardToken,
          xExp,
          cardholderName: payload.billing.cardholderName,
          billingZip: payload.billing.billingZip,
          billingEmail: payload.billing.billingEmail,
          saveCard: payload.saveCard,
          enableAutopay: payload.saveCard,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.approved) {
        const err = String(json?.error || "payment_failed");
        setPayError(
          err === "pay_link_already_paid" || err === "no_balance_due"
            ? "These invoices have already been paid."
            : err === "charge_in_progress"
              ? "A payment is already processing for this link. Please wait a moment."
              : err === "card_tokenization_failed"
                ? "We could not verify this card. Check the number and try again."
                : err === "card_declined" && json?.message
                  ? String(json.message)
                  : "Payment could not be completed. Please try again or contact support.",
        );
        return;
      }
      setPaidInvoices(Array.isArray(json?.paidInvoices) ? json.paidInvoices : []);
      setPaid(true);
      setPaymentCompleted(true);
    } finally {
      submitInFlightRef.current = false;
    }
  }

  const amountDue = dollars(view?.totalDueCents || 0);
  const openCount = view ? view.invoices.filter((i) => !i.alreadyPaid).length : 0;

  return (
    <main className="billing-pay-page" data-pay-theme={payTheme}>
      <div className="billing-pay-bg" aria-hidden="true" />
      <div className="billing-pay-shell">
        <section className="billing-pay-card" aria-label="Secure invoice payment">
          <PayCardTop />
          <header className="billing-pay-header">
            <h1>{view?.companyName || "Invoice payment"}</h1>
            {view ? (
              <p className="billing-pay-sub">
                {openCount > 0
                  ? <>{openCount} open invoice{openCount === 1 ? "" : "s"} · one payment</>
                  : <>Invoice payment</>}
              </p>
            ) : null}
          </header>

          {result === "success" || paid ? (
            <section className="billing-pay-success">
              <CheckCircle2 size={26} />
              <div>
                <h2>Payment received</h2>
                <p>
                  Thank you.{" "}
                  {paidInvoices.length > 0
                    ? <>Invoices <strong>{paidInvoices.join(", ")}</strong> are marked paid.</>
                    : "All invoices on this link are paid."}
                </p>
                <p className="muted">
                  A separate receipt is emailed for each invoice if billing email is on file. You will be redirected shortly.
                </p>
              </div>
            </section>
          ) : loadError ? (
            <section className="billing-pay-error">
              <p>{loadError}</p>
            </section>
          ) : !view || !config ? (
            <section className="billing-pay-loading">
              <span />
              <p>Loading secure payment…</p>
            </section>
          ) : !view.canPay ? (
            <section className="billing-pay-error">
              <p>There is no balance due on this payment link.</p>
            </section>
          ) : (
            <>
              <section className="billing-pay-summary">
                <div className="billing-pay-amount">
                  <span>Total due</span>
                  <strong>
                    {amountDue}
                    <span className="billing-pay-cur">{view.currency || "USD"}</span>
                  </strong>
                </div>
              </section>

              <PayInvoiceList
                rows={view.invoices.map((inv) => ({
                  invoiceId: inv.invoiceId ?? null,
                  invoiceNumber: inv.invoiceNumber,
                  dueDate: inv.dueDate,
                  issueDate: inv.issueDate ?? null,
                  periodStart: inv.periodStart,
                  periodEnd: inv.periodEnd,
                  totalCents: inv.totalCents,
                  balanceDueCents: inv.balanceDueCents,
                  payable: !inv.alreadyPaid,
                  lineItems: inv.lineItems || [],
                }))}
                heading={`Invoices (${view.invoices.length})`}
                pdfHref={(row) =>
                  row.invoiceId && code
                    ? `${apiBase}/billing/platform/pay-links/${encodeURIComponent(code)}/invoice/${encodeURIComponent(row.invoiceId)}/pdf`
                    : null
                }
              />
              <CardknoxIFieldsForm
                ifieldsKey={config.ifieldsKey}
                variant="customer"
                fieldTheme={payTheme}
                showBillingAddress
                showEmail
                showSaveOptions
                autoEnableAutopayWhenSaving
                saveCard={saveCard}
                onSaveCardChange={setSaveCard}
                submitLabel={`Pay ${amountDue}`}
                busyLabel="Processing…"
                errorMessage={payError}
                secureNote={(
                  <div className="billing-pay-secure-note">
                    <ShieldCheck size={20} />
                    <p>Connect Communications never stores your full card number or CVV.</p>
                  </div>
                )}
                onSubmitCardToken={submitPayment}
              />
            </>
          )}

          <PaymentTrustBadge theme={payTheme} />
        </section>
      </div>
    </main>
  );
}
