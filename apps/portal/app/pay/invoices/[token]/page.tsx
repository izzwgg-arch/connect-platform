"use client";

/* One page, several invoices, one card entry. The card is verified once and
   each invoice is then charged in due-date order — every invoice keeps its own
   receipt and record, and the page reports the outcome per invoice rather than
   a single yes/no that could hide a half-success. */

import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { CardknoxIFieldsForm, type CardknoxBillingFields } from "../../../../components/billing/CardknoxIFieldsForm";
import { PaymentTrustBadge } from "../../../../components/billing/PaymentTrustBadge";
import { PayCardTop } from "../../../../components/billing/PayCardTop";
import { PayInvoiceList, type PayInvoiceLine } from "../../../../components/billing/PayInvoiceList";
import { useAppContext } from "../../../../hooks/useAppContext";
import { resolveSameOriginApiBase } from "../../../../lib/publicApiBase";
import "../../invoice/[token]/pay-invoice.css";

/** Same-origin on purpose — this page is served on more than one hostname and a
 *  hardcoded domain makes every fetch here a CORS failure on the other one. */
const apiBase = resolveSameOriginApiBase(process.env.NEXT_PUBLIC_API_URL);

type InvoiceRow = {
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  dueDate: string;
  issueDate?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  totalCents: number;
  subtotalCents?: number;
  taxCents?: number;
  balanceDueCents: number;
  payable: boolean;
  lineItems?: PayInvoiceLine[];
};

type MultiPayView = {
  companyName: string;
  currency: string;
  invoices: InvoiceRow[];
  combinedDueCents: number;
  canPay: boolean;
};

type PublicConfig = {
  ifieldsKey: string;
  ifieldsVersion: string;
  mode: string;
  canPay: boolean;
};

type PayResult = {
  invoiceId: string;
  invoiceNumber: string | null;
  amountCents: number;
  outcome: "paid" | "declined" | "skipped_already_paid" | "skipped_period_covered" | "not_attempted" | "error";
  message?: string | null;
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

function outcomeWords(r: PayResult): { text: string; good: boolean } {
  switch (r.outcome) {
    case "paid": return { text: "Paid", good: true };
    case "skipped_already_paid": return { text: "Already paid", good: true };
    case "skipped_period_covered": return { text: r.message || "Already covered", good: true };
    case "declined": return { text: r.message ? `Declined — ${r.message}` : "Declined", good: false };
    case "not_attempted": return { text: "Not charged", good: false };
    default: return { text: r.message || "Could not be charged", good: false };
  }
}

export default function PublicBillingMultiInvoicePayPage() {
  const params = useParams<{ token: string }>();
  const search = useSearchParams();
  const token = params?.token;
  const { theme } = useAppContext();
  const [systemTheme, setSystemTheme] = useState<PayTheme>("light");
  const queryTheme = normalizePayTheme(search.get("theme"));
  const appTheme = normalizePayTheme(theme);
  const payTheme = queryTheme ?? appTheme ?? systemTheme;
  const [view, setView] = useState<MultiPayView | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loadError, setLoadError] = useState("");
  const [payError, setPayError] = useState("");
  const [results, setResults] = useState<PayResult[] | null>(null);
  const [saveCard, setSaveCard] = useState(false);
  const submitInFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoadError("");
    const [viewRes, cfgRes] = await Promise.all([
      fetch(`${apiBase}/billing/platform/invoices/pay-multi/${encodeURIComponent(token)}`),
      fetch(`${apiBase}/billing/platform/invoices/pay-multi/${encodeURIComponent(token)}/public-config`),
    ]);
    const viewJson = await viewRes.json().catch(() => null);
    const cfgJson = await cfgRes.json().catch(() => null);
    if (!viewRes.ok) {
      setLoadError("This payment link is invalid or has expired.");
      return;
    }
    if (!cfgRes.ok || !cfgJson?.ifieldsKey) {
      setLoadError("Online payment is not available right now. Please contact billing support.");
      return;
    }
    setView(viewJson as MultiPayView);
    setConfig(cfgJson as PublicConfig);
  }, [token]);

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

  async function submitPayment(payload: {
    cardToken: string;
    billing: CardknoxBillingFields;
    saveCard: boolean;
    enableAutopay: boolean;
  }) {
    if (!token) return;
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setPayError("");
    try {
      const xExp = billingXExp(payload.billing);
      if (!xExp) {
        setPayError("Enter a valid expiration month and year.");
        return;
      }
      const res = await fetch(`${apiBase}/billing/platform/invoices/pay-multi/${encodeURIComponent(token)}/pay`, {
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
      if (!res.ok) {
        const err = String(json?.error || "payment_failed");
        setPayError(
          err === "invoice_already_paid"
            ? "These invoices have already been paid."
            : err === "charge_in_progress"
              ? "A payment is already processing. Please wait a moment."
              : err === "card_tokenization_failed"
                ? "We could not verify this card. Check the number and try again."
                : "Payment could not be completed. Please try again or contact support.",
        );
        return;
      }
      const rs: PayResult[] = Array.isArray(json?.results) ? json.results : [];
      setResults(rs);
      if (!rs.some((r) => r.outcome === "paid")) {
        const declined = rs.find((r) => r.outcome === "declined");
        setPayError(declined?.message ? `The card was declined — ${declined.message}` : "The card was declined. You can try again.");
        setResults(null);
      }
    } finally {
      submitInFlightRef.current = false;
    }
  }

  const payableRows = (view?.invoices || []).filter((r) => r.payable);
  const combinedDue = dollars(view?.combinedDueCents || 0);
  const allSettled = results != null
    && results.every((r) => ["paid", "skipped_already_paid", "skipped_period_covered"].includes(r.outcome));

  return (
    <main className="billing-pay-page" data-pay-theme={payTheme}>
      <div className="billing-pay-bg" aria-hidden="true" />
      <div className="billing-pay-shell">
        <section className="billing-pay-card" aria-label="Secure combined invoice payment">
          <PayCardTop />
          <header className="billing-pay-header">
            <h1>{view?.companyName || "Invoice payment"}</h1>
            {view ? (
              <p className="billing-pay-sub">
                {payableRows.length > 0
                  ? <>{payableRows.length} open invoice{payableRows.length === 1 ? "" : "s"}, one payment</>
                  : <>Invoices</>}
              </p>
            ) : null}
          </header>

          {results ? (
            <section className={allSettled ? "billing-pay-success" : "billing-pay-error"}>
              {allSettled ? <CheckCircle2 size={26} /> : null}
              <div>
                <h2>{allSettled ? "Payment received" : "Partly paid"}</h2>
                <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
                  {results.map((r) => {
                    const w = outcomeWords(r);
                    return (
                      <li key={r.invoiceId} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "4px 0" }}>
                        <span>Invoice <strong>{r.invoiceNumber || r.invoiceId.slice(0, 8)}</strong> · {dollars(r.amountCents)}</span>
                        <span style={{ fontWeight: 600 }}>{w.good ? "✓ " : ""}{w.text}</span>
                      </li>
                    );
                  })}
                </ul>
                {!allSettled ? (
                  <p className="muted" style={{ marginTop: 10 }}>
                    Anything not charged is still owed — you can reopen this link later to finish, or contact billing support.
                  </p>
                ) : (
                  <p className="muted" style={{ marginTop: 10 }}>
                    Thank you. A receipt for each invoice will be emailed if a billing email is on file.
                  </p>
                )}
              </div>
            </section>
          ) : loadError ? (
            <section className="billing-pay-error">
              <p>{loadError}</p>
            </section>
          ) : !view || !config ? (
            <section className="billing-pay-loading">
              <span />
              <p>Loading secure invoices…</p>
            </section>
          ) : !view.canPay ? (
            <section className="billing-pay-success">
              <CheckCircle2 size={26} />
              <div>
                <h2>Nothing owing</h2>
                <p>Every invoice on this link has already been settled.</p>
              </div>
            </section>
          ) : (
            <>
              <section className="billing-pay-summary">
                <div className="billing-pay-amount">
                  <span>Total due</span>
                  <strong>
                    {combinedDue}
                    <span className="billing-pay-cur">{view.currency || "USD"}</span>
                  </strong>
                </div>
              </section>

              <PayInvoiceList
                rows={view.invoices}
                heading={`Invoices (${view.invoices.length})`}
                pdfHref={(row) =>
                  row.invoiceId && token
                    ? `${apiBase}/billing/platform/invoices/pay-multi/${encodeURIComponent(token)}/invoice/${encodeURIComponent(row.invoiceId)}/pdf`
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
                submitLabel={`Pay ${combinedDue}`}
                busyLabel="Processing…"
                errorMessage={payError}
                secureNote={(
                  <div className="billing-pay-secure-note">
                    <ShieldCheck size={20} />
                    <p>One card entry pays every invoice above. Connect Communications never stores your full card number or CVV.</p>
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
