"use client";

import Image from "next/image";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCircle2, ChevronDown, CreditCard, Lock, Moon, ShieldCheck } from "lucide-react";
import { CardknoxIFieldsForm, type CardknoxBillingFields } from "../../../../components/billing/CardknoxIFieldsForm";
import { useAppContext } from "../../../../hooks/useAppContext";
import "./pay-invoice.css";

const apiBase = (process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api").replace(/\/$/, "");

type InvoicePayView = {
  invoiceNumber: string;
  companyName: string;
  status: string;
  canPay: boolean;
  currency: string;
  totalCents: number;
  balanceDueCents: number;
  dueDate: string;
  lineItems: Array<{ description: string; quantity: number; amountCents: number }>;
};

type PublicConfig = {
  ifieldsKey: string;
  ifieldsVersion: string;
  mode: string;
  canPay: boolean;
};

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

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

export default function PublicBillingInvoicePayPage() {
  const params = useParams<{ token: string }>();
  const search = useSearchParams();
  const token = params?.token;
  const { theme } = useAppContext();
  const payTheme = theme === "dark" ? "dark" : "light";
  const [invoice, setInvoice] = useState<InvoicePayView | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loadError, setLoadError] = useState("");
  const [payError, setPayError] = useState("");
  const [paid, setPaid] = useState(false);
  const [saveCard, setSaveCard] = useState(false);
  const [enableAutopay, setEnableAutopay] = useState(false);
  const submitInFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoadError("");
    const [invRes, cfgRes] = await Promise.all([
      fetch(`${apiBase}/billing/platform/invoices/pay/${encodeURIComponent(token)}`),
      fetch(`${apiBase}/billing/platform/invoices/pay/${encodeURIComponent(token)}/public-config`),
    ]);
    const invJson = await invRes.json().catch(() => null);
    const cfgJson = await cfgRes.json().catch(() => null);
    if (!invRes.ok) {
      setLoadError(String(invJson?.error || "This payment link is invalid or has expired."));
      return;
    }
    if (!cfgRes.ok || !cfgJson?.ifieldsKey) {
      setLoadError("Online payment is not available for this invoice right now. Please contact billing support.");
      return;
    }
    setInvoice(invJson as InvoicePayView);
    setConfig(cfgJson as PublicConfig);
    if (invJson.status === "PAID") setPaid(true);
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

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
      const res = await fetch(`${apiBase}/billing/platform/invoices/pay/${encodeURIComponent(token)}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          xSut: payload.cardToken,
          xExp,
          cardholderName: payload.billing.cardholderName,
          billingZip: payload.billing.billingZip,
          billingEmail: payload.billing.billingEmail,
          saveCard: payload.saveCard,
          enableAutopay: payload.enableAutopay,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.approved) {
        const err = String(json?.error || "payment_failed");
        setPayError(
          err === "invoice_already_paid"
            ? "This invoice has already been paid."
            : err === "charge_in_progress"
              ? "A payment is already processing for this invoice. Please wait a moment."
              : err === "card_tokenization_failed" || err === "card_save_failed"
                ? "We could not verify this card. Check the number and try again."
                : "Payment could not be completed. Please try again or contact support.",
        );
        return;
      }
      setPaid(true);
    } finally {
      submitInFlightRef.current = false;
    }
  }

  const result = search.get("result");
  const amountDue = dollars(invoice?.balanceDueCents || 0);

  return (
    <main className="billing-pay-page" data-pay-theme={payTheme}>
      <div className="billing-pay-bg" aria-hidden="true" />
      <div className="billing-pay-shell">
        <header className="billing-pay-topbar" aria-label="Connect payment navigation">
          <div className="billing-pay-brand">
            <Image src="/connect-logo.png" alt="Connect Communications" width={150} height={42} priority />
          </div>
          <nav className="billing-pay-nav" aria-label="Main navigation">
            <span>Dashboard</span>
            <span>Services</span>
            <span className="active">Billing</span>
            <span>Support</span>
          </nav>
          <div className="billing-pay-actions" aria-label="Account controls">
            <button type="button" aria-label="Theme" title="Theme"><Moon size={16} /></button>
            <button type="button" aria-label="Notifications" title="Notifications"><Bell size={16} /></button>
            <span className="billing-pay-avatar">JS</span>
            <span className="billing-pay-user">Jane Smith</span>
            <ChevronDown size={16} />
          </div>
        </header>

        <section className="billing-pay-card" aria-label="Secure invoice payment">
          <header className="billing-pay-header">
            <p className="billing-pay-eyebrow"><Lock size={14} /> Secure payment</p>
            <h1>{invoice?.companyName || "Invoice payment"}</h1>
            {invoice ? (
              <p className="billing-pay-sub">
                Invoice <strong>{invoice.invoiceNumber}</strong>
                {invoice.dueDate ? <> · Due {fmtDate(invoice.dueDate)}</> : null}
              </p>
            ) : null}
          </header>

          {result === "success" || paid ? (
            <section className="billing-pay-success">
              <CheckCircle2 size={26} />
              <div>
                <h2>Payment received</h2>
                <p>
                  Thank you. {invoice ? <>Invoice <strong>{invoice.invoiceNumber}</strong> is marked paid.</> : "Your payment was successful."}
                </p>
                <p className="muted">A receipt will be emailed if billing email is on file for this account.</p>
              </div>
            </section>
          ) : loadError ? (
            <section className="billing-pay-error">
              <p>{loadError}</p>
            </section>
          ) : !invoice || !config ? (
            <section className="billing-pay-loading">
              <span />
              <p>Loading secure invoice…</p>
            </section>
          ) : !invoice.canPay ? (
            <section className="billing-pay-error">
              <p>
                {invoice.status === "VOID"
                  ? "This invoice has been voided and cannot be paid."
                  : "This invoice does not have a balance due."}
              </p>
            </section>
          ) : (
            <>
              <section className="billing-pay-summary">
                <div className="billing-pay-amount">
                  <span>Amount due</span>
                  <strong>{amountDue}</strong>
                </div>
                <div className="billing-pay-currency">
                  <span>{invoice.currency || "USD"}</span>
                  <span>{amountDue}</span>
                </div>
              </section>
              <CardknoxIFieldsForm
                ifieldsKey={config.ifieldsKey}
                variant="customer"
                fieldTheme={payTheme}
                showBillingAddress
                showEmail
                showSaveOptions
                saveCard={saveCard}
                enableAutopay={enableAutopay}
                onSaveCardChange={setSaveCard}
                onEnableAutopayChange={setEnableAutopay}
                submitLabel={`Pay ${amountDue}`}
                busyLabel="Processing…"
                errorMessage={payError}
                secureNote={(
                  <div className="billing-pay-secure-note">
                    <ShieldCheck size={20} />
                    <p>Your card details are entered directly and securely with our payment processor. We never store your full card number or CVV.</p>
                  </div>
                )}
                childrenAfterCard={<CardFieldHint />}
                onSubmitCardToken={submitPayment}
              />
              <p className="billing-pay-microcopy">
                Payments are processed securely. Connect Communications never stores your full card number or CVV.
              </p>
            </>
          )}

          <footer className="billing-pay-trust-strip">
            <div className="billing-pay-trust-cell sola">
              <span>Secured &amp; Powered by</span>
              <strong><span className="sola-mark" aria-hidden="true" /> SOLA</strong>
            </div>
            <div className="billing-pay-trust-cell security">
              <ShieldCheck size={24} />
              <div>
                <strong>Secure payment</strong>
                <span>256-bit SSL encryption</span>
              </div>
            </div>
            <div className="billing-pay-trust-cell brands">
              <span>We accept</span>
              <div aria-label="Accepted payment brands">
                <b className="brand-visa">Visa</b>
                <b className="brand-mastercard">Mastercard</b>
                <b className="brand-amex">AmEx</b>
                <b className="brand-discover">Discover</b>
                <b className="brand-apple">Apple Pay</b>
              </div>
            </div>
          </footer>
        </section>
      </div>
    </main>
  );
}

function CardFieldHint() {
  return (
    <p className="billing-card-field-hint">
      <CreditCard size={14} />
      Card number and CVV stay inside PCI-hosted secure fields.
    </p>
  );
}
