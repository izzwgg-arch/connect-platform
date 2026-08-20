"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, Lock, ShieldCheck } from "lucide-react";
import { CardknoxIFieldsForm, type CardknoxBillingFields } from "../../../../../components/billing/CardknoxIFieldsForm";
import { PaymentTrustBadge } from "../../../../../components/billing/PaymentTrustBadge";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { billingErrorMessage } from "../../../../../components/BillingActionToast";
import { useAppContext } from "../../../../../hooks/useAppContext";
import { apiGet, apiPost } from "../../../../../services/apiClient";
import "../../../../pay/invoice/[token]/pay-invoice.css";
import "./add-card.css";

/* Adding a card uses the SAME payment surface as the public pay pages
   (CardknoxIFieldsForm + PaymentTrustBadge + pay-invoice.css) on purpose —
   customers must never meet a second, different-looking card form. Only the
   submit differs: the token is SAVED (no charge) via
   /billing/payment-methods/sola/save. */

type SolaPublicConfig = {
  enabled?: boolean;
  ifieldsKey?: string | null;
};

/** Cardknox wants MMYY; the shared form collects month ("MM") and year ("YYYY"). */
function billingXExp(billing: CardknoxBillingFields): string | null {
  const month = billing.expMonth.replace(/\D/g, "").padStart(2, "0").slice(-2);
  const yearDigits = billing.expYear.replace(/\D/g, "");
  const year = yearDigits.length >= 4 ? yearDigits.slice(-2) : yearDigits.padStart(2, "0");
  if (!/^(0[1-9]|1[0-2])$/.test(month) || !/^\d{2}$/.test(year)) return null;
  return `${month}${year}`;
}

export default function BillingAddCardPage() {
  const router = useRouter();
  const { theme } = useAppContext();
  const payTheme: "light" | "dark" = theme === "light" ? "light" : "dark";
  const [config, setConfig] = useState<SolaPublicConfig | null>(null);
  const [hasCards, setHasCards] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  const submitInFlightRef = useRef(false);

  useEffect(() => {
    let active = true;
    Promise.all([
      apiGet<SolaPublicConfig>("/billing/sola/public-config"),
      apiGet<unknown[]>("/billing/payment-methods").catch(() => [] as unknown[]),
    ])
      .then(([cfg, methods]) => {
        if (!active) return;
        setConfig(cfg || {});
        setHasCards(Array.isArray(methods) && methods.length > 0);
      })
      .catch(() => {
        if (active) setLoadError("Could not load the secure card form. Please try again in a moment.");
      });
    return () => {
      active = false;
    };
  }, []);

  /* pay-invoice.css carries `html:has(.billing-pay-page) { overflow-y: auto }`
     for the STANDALONE pay pages. Inside the console shell the shell owns the
     scrolling, so pin the root back with inline styles (which outrank that
     rule) for as long as this page is mounted. */
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const previous = [root.style.height, root.style.overflow, body.style.height, body.style.overflow];
    root.style.height = "100%";
    root.style.overflow = "hidden";
    body.style.height = "100%";
    body.style.overflow = "hidden";
    return () => {
      root.style.height = previous[0];
      root.style.overflow = previous[1];
      body.style.height = previous[2];
      body.style.overflow = previous[3];
    };
  }, []);

  useEffect(() => {
    if (!saved) return;
    const timeout = window.setTimeout(() => router.replace("/billing/payments"), 2200);
    return () => window.clearTimeout(timeout);
  }, [saved, router]);

  async function saveCardToken(payload: { cardToken: string; billing: CardknoxBillingFields }) {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setSaveError("");
    try {
      const xExp = billingXExp(payload.billing);
      if (!xExp) {
        setSaveError("Enter a valid expiration month and year.");
        return;
      }
      await apiPost("/billing/payment-methods/sola/save", {
        xSut: payload.cardToken,
        xExp,
        cardholderName: payload.billing.cardholderName,
        billingZip: payload.billing.billingZip,
        // The first card on the account becomes the default automatically.
        makeDefault: hasCards === false,
      });
      setSaved(true);
    } catch (err) {
      setSaveError(billingErrorMessage(err, "Unable to save this card. Check the details and try again."));
    } finally {
      submitInFlightRef.current = false;
    }
  }

  const ifieldsKey = config?.enabled && config.ifieldsKey ? config.ifieldsKey : null;

  return (
    <PermissionGate permission="can_view_billing_payments" fallback={<div className="state-box">You do not have payment access.</div>}>
      <main className="billing-pay-page billing-payments-addcard" data-pay-theme={payTheme}>
        <div className="billing-pay-bg" aria-hidden="true" />
        <div className="billing-pay-shell">
          <div className="billing-pay-logo" aria-label="Loopcom">
            <Image src="/brand/loopcom/loopcom-wordmark-560.png" alt="Loopcom" width={560} height={99} priority />
          </div>

          <section className="billing-pay-card" aria-label="Add a payment card">
            <header className="billing-pay-header">
              <p className="billing-pay-eyebrow"><Lock size={14} /> Secure card entry</p>
              <h1>Add a payment card</h1>
              <p className="billing-pay-sub">
                Your card is saved for invoice payments and autopay. Nothing is charged now.
              </p>
            </header>

            {saved ? (
              <section className="billing-pay-success">
                <CheckCircle2 size={26} />
                <div>
                  <h2>Card saved</h2>
                  <p>Your card is on file and ready for payments.</p>
                  <p className="muted">Taking you back to your payment methods…</p>
                </div>
              </section>
            ) : loadError ? (
              <section className="billing-pay-error">
                <p>{loadError}</p>
              </section>
            ) : config == null ? (
              <section className="billing-pay-loading">
                <span />
                <p>Loading secure card form…</p>
              </section>
            ) : !ifieldsKey ? (
              <section className="billing-pay-error">
                <p>Online card entry is not yet configured for this account. Contact support to add a card.</p>
              </section>
            ) : (
              <CardknoxIFieldsForm
                ifieldsKey={ifieldsKey}
                variant="customer"
                fieldTheme={payTheme}
                showBillingAddress={false}
                showEmail={false}
                submitLabel="Save card"
                busyLabel="Securing…"
                errorMessage={saveError}
                onTokenizeError={setSaveError}
                secureNote={(
                  <div className="billing-pay-secure-note">
                    <ShieldCheck size={20} />
                    <p>Card details are entered in PCI-compliant fields hosted by our payment processor. Connect never sees or stores your full card number or CVV.</p>
                  </div>
                )}
                onSubmitCardToken={saveCardToken}
              />
            )}

            <PaymentTrustBadge theme={payTheme} />
          </section>

          <div className="billing-pay-back">
            <Link href="/billing/payments"><ArrowLeft size={15} /> Back to payment methods</Link>
          </div>
        </div>
      </main>
    </PermissionGate>
  );
}
