"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CardknoxIFieldsForm, type CardknoxBillingFields } from "../../../../components/billing/CardknoxIFieldsForm";
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
  const [invoice, setInvoice] = useState<InvoicePayView | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loadError, setLoadError] = useState("");
  const [payError, setPayError] = useState("");
  const [paid, setPaid] = useState(false);
  const [saveCard, setSaveCard] = useState(false);
  const [enableAutopay, setEnableAutopay] = useState(false);

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
    setPayError("");
    const res = await fetch(`${apiBase}/billing/platform/invoices/pay/${encodeURIComponent(token)}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        xSut: payload.cardToken,
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
          : err === "card_tokenization_failed" || err === "card_save_failed"
            ? "We could not verify this card. Check the number and try again."
            : "Payment could not be completed. Please try again or contact support.",
      );
      return;
    }
    setPaid(true);
  }

  const result = search.get("result");

  return (
    <main className="billing-pay-page">
      <div className="billing-pay-card">
        <header className="billing-pay-header">
          <p className="billing-pay-eyebrow">Secure payment</p>
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
            <h2>Payment received</h2>
            <p>
              Thank you. {invoice ? <>Invoice <strong>{invoice.invoiceNumber}</strong> is marked paid.</> : "Your payment was successful."}
            </p>
            <p className="muted">A receipt will be emailed if billing email is on file for this account.</p>
          </section>
        ) : loadError ? (
          <section className="billing-pay-error">
            <p>{loadError}</p>
          </section>
        ) : !invoice || !config ? (
          <p className="muted">Loading invoice…</p>
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
                <strong>{dollars(invoice.balanceDueCents)}</strong>
              </div>
              {invoice.lineItems?.length ? (
                <ul className="billing-pay-lines">
                  {invoice.lineItems.slice(0, 8).map((li, i) => (
                    <li key={i}>
                      <span>{li.description}</span>
                      <span>{dollars(li.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
            <CardknoxIFieldsForm
              ifieldsKey={config.ifieldsKey}
              variant="customer"
              showBillingAddress
              showEmail
              showSaveOptions
              saveCard={saveCard}
              enableAutopay={enableAutopay}
              onSaveCardChange={setSaveCard}
              onEnableAutopayChange={setEnableAutopay}
              submitLabel={`Pay ${dollars(invoice.balanceDueCents)}`}
              busyLabel="Processing…"
              errorMessage={payError}
              onSubmitCardToken={submitPayment}
            />
          </>
        )}

        <footer className="billing-pay-footer muted">
          Payments are processed securely. Connect Communications never stores your full card number or CVV.
        </footer>
      </div>
    </main>
  );
}
