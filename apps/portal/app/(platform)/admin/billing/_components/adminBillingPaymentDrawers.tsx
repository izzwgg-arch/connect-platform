"use client";



import { useEffect, useRef, useState } from "react";

import { useAsyncResource } from "../../../../../hooks/useAsyncResource";

import { apiGet, apiPost } from "../../../../../services/apiClient";

import { ErrorState } from "../../../../../components/ErrorState";

import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";

import { billingErrorMessage } from "../../../../../components/BillingActionToast";

import { BillingActionPanel } from "../../../../../components/billing/BillingActionPanel";

import { BillingActivityList } from "../../../../../components/billing/BillingActivityList";

import { BillingFinanceChip } from "../../../../../components/billing/BillingFinanceChip";

import {

  CardknoxIFieldsForm,

  type CardknoxBillingFields,

} from "../../../../../components/billing/CardknoxIFieldsForm";

import {

  dollars,

  formatDateTime,

  transactionFinanceStatusTone,

  transactionStatusLabel,

} from "../../../../../lib/billingUi";



type AdminPaymentMethod = {

  id: string;

  brand: string | null;

  last4: string | null;

  expMonth: number | null;

  expYear: number | null;

  cardholderName: string | null;

  isDefault: boolean;

};



type AdminSolaPublicConfig = { configured: boolean; enabled: boolean; ifieldsKey: string | null; mode: string | null };



type NewCardPayload = { cardToken: string; billing: CardknoxBillingFields };

function newOneTimeChargeOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `otc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function billingXExp(billing: CardknoxBillingFields): string | null {
  const month = billing.expMonth.replace(/\D/g, "").padStart(2, "0").slice(-2);
  const yearDigits = billing.expYear.replace(/\D/g, "");
  const year = yearDigits.length >= 4 ? yearDigits.slice(-2) : yearDigits.padStart(2, "0");
  if (!/^(0[1-9]|1[0-2])$/.test(month) || !/^\d{2}$/.test(year)) return null;
  return `${month}${year}`;
}



type TxDetail = {

  id: string;

  amountCents: number;

  status: string;

  createdAt: string;

  responseMessage: string | null;

  responseCode: string | null;

  processorTransactionId: string | null;

  tenant: { id: string; name: string };

  invoice: { id: string; invoiceNumber: string | null; status: string; totalCents: number; balanceDueCents: number } | null;

  paymentMethod: { id: string; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null; cardholderName: string | null } | null;

  events?: { id: string; type: string; message: string | null; createdAt: string }[];

};



function cardLabel(m: { brand: string | null; last4: string | null; expMonth?: number | null; expYear?: number | null; cardholderName?: string | null }) {

  const brand = m.brand || "Card";

  const last4 = m.last4 ? `···${m.last4}` : "";

  const exp = m.expMonth && m.expYear ? ` · ${m.expMonth}/${String(m.expYear).slice(-2)}` : "";

  return `${brand} ${last4}${exp}`;

}



function parseAmountToCents(raw: string): number | null {

  const cleaned = raw.replace(/[^0-9.]/g, "");

  if (!cleaned) return null;

  const n = Number.parseFloat(cleaned);

  if (!Number.isFinite(n) || n <= 0) return null;

  return Math.round(n * 100);

}



function PaySectionTitle({ children }: { children: string }) {

  return (

    <p style={{ fontSize: 12, fontWeight: 650, color: "var(--text-dim)", margin: "0 0 8px", letterSpacing: "0.02em" }}>

      {children}

    </p>

  );

}



export function OneTimeChargeDrawer({

  tenantId,

  tenantName,

  isLiveCharge,

  initialPaymentMethodId,

  initialDescription,

  initialAmountCents,

  initialChargeMode,

  onClose,

  onSuccess,

}: {

  tenantId: string;

  tenantName: string;

  isLiveCharge: boolean;

  initialPaymentMethodId?: string | null;

  initialDescription?: string;

  initialAmountCents?: number;

  initialChargeMode?: "none" | "card_on_file" | "new_card";

  onClose: () => void;

  onSuccess: () => void;

}) {

  const [step, setStep] = useState<"form" | "confirm" | "done">("form");

  const [description, setDescription] = useState(initialDescription ?? "");

  const [amount, setAmount] = useState(initialAmountCents ? (initialAmountCents / 100).toFixed(2) : "");

  const [operatorNote, setOperatorNote] = useState("");

  const [invoiceMemo, setInvoiceMemo] = useState("");

  const [serviceStartDate, setServiceStartDate] = useState("");

  const [serviceEndDate, setServiceEndDate] = useState("");

  const [chargeMode, setChargeMode] = useState<"none" | "card_on_file" | "new_card">(initialChargeMode ?? "card_on_file");

  const [paymentMethodId, setPaymentMethodId] = useState("");

  const [saveCard, setSaveCard] = useState(true);

  const [makeDefault, setMakeDefault] = useState(false);

  const [busy, setBusy] = useState(false);

  const [tokenizing, setTokenizing] = useState(false);

  const [error, setError] = useState("");

  const [cardFormError, setCardFormError] = useState("");

  const [resultSummary, setResultSummary] = useState("");

  const [billingPreview, setBillingPreview] = useState<CardknoxBillingFields | null>(null);

  const [ifieldsReady, setIfieldsReady] = useState(false);

  const [solaConfig, setSolaConfig] = useState<AdminSolaPublicConfig | null>(null);

  const tokenizeRef = useRef<(() => void) | null>(null);

  const chargePendingRef = useRef(false);
  const submitInFlightRef = useRef(false);
  const chargeOperationIdRef = useRef<string>(newOneTimeChargeOperationId());



  const pmData = useAsyncResource<{ methods: AdminPaymentMethod[] }>(

    () => apiGet(`/admin/billing/platform/tenants/${tenantId}/payment-methods`),

    [tenantId],

  );

  const methods = pmData.status === "success" ? pmData.data.methods : [];



  useEffect(() => {

    if (initialPaymentMethodId) {

      setPaymentMethodId(initialPaymentMethodId);

      setChargeMode("card_on_file");

    } else if (methods.length && !paymentMethodId) {

      const def = methods.find((m) => m.isDefault) || methods[0];

      setPaymentMethodId(def.id);

    }

  }, [methods, paymentMethodId, initialPaymentMethodId]);



  useEffect(() => {

    let active = true;

    apiGet<AdminSolaPublicConfig>(`/admin/billing/platform/tenants/${tenantId}/sola/public-config`)

      .then((cfg) => { if (active) setSolaConfig(cfg); })

      .catch(() => { if (active) setSolaConfig({ configured: false, enabled: false, ifieldsKey: null, mode: null }); });

    return () => { active = false; };

  }, [tenantId]);



  useEffect(() => {

    if (chargeMode !== "new_card") {
      setBillingPreview(null);
      setCardFormError("");
    }
  }, [chargeMode]);



  const amountCents = parseAmountToCents(amount) ?? 0;

  const gatewayConfigured = !!solaConfig?.configured && !!solaConfig?.enabled;

  const ifieldsKeyMissing = gatewayConfigured && !solaConfig?.ifieldsKey;

  const canUseNewCard = gatewayConfigured && !!solaConfig?.ifieldsKey;

  const canProceedForm = description.trim().length > 0 && amountCents > 0

    && (chargeMode === "none" || (chargeMode === "card_on_file" && !!paymentMethodId) || (chargeMode === "new_card" && canUseNewCard));



  async function postCharge(payload: NewCardPayload | null) {
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = {
        description: description.trim(),
        amountCents,
        operatorNote: operatorNote.trim() || undefined,
        invoiceMemo: invoiceMemo.trim() || undefined,
        serviceStartDate: serviceStartDate || undefined,
        serviceEndDate: serviceEndDate || undefined,
        chargeMode,
        confirmLive: isLiveCharge ? true : undefined,
        operationId: chargeOperationIdRef.current,
      };
      if (chargeMode === "card_on_file") body.paymentMethodId = paymentMethodId;
      if (chargeMode === "new_card") {
        if (!payload?.cardToken) {
          setError("Enter the card in the form, then try again.");
          return;
        }
        const xExp = billingXExp(payload.billing);
        if (!xExp) {
          setError("Enter a valid expiration month and year.");
          return;
        }
        body.xSut = payload.cardToken;
        body.xExp = xExp;
        body.cardholderName = payload.billing.cardholderName.trim() || undefined;
        body.billingZip = payload.billing.billingZip.trim() || undefined;
        body.saveCard = saveCard;
        body.makeDefault = makeDefault;
      }
      const res = await apiPost<{ invoice: { invoiceNumber: string; status: string }; transaction: { status: string } | null }>(
        `/admin/billing/platform/tenants/${tenantId}/one-time-charges`,
        body,
      );
      const invNum = res.invoice?.invoiceNumber || "Invoice";
      const txStatus = res.transaction?.status;
      if (chargeMode === "new_card" && txStatus && txStatus !== "APPROVED") {
        setError(`Charge declined (${transactionStatusLabel(txStatus)}). The invoice may still be open — check Invoices.`);
        setStep("confirm");
        return;
      }
      setResultSummary(
        txStatus
          ? `${invNum} · ${transactionStatusLabel(txStatus)}`
          : `${invNum} created — collect payment later from the invoice register.`,
      );
      setStep("done");
      onSuccess();
    } catch (err) {
      setError(billingErrorMessage(err, "Unable to complete this charge."));
    } finally {
      setBusy(false);
      setTokenizing(false);
      submitInFlightRef.current = false;
      chargeOperationIdRef.current = newOneTimeChargeOperationId();
    }
  }

  function submitCharge() {
    if (submitInFlightRef.current || busy || tokenizing) return;
    submitInFlightRef.current = true;
    if (chargeMode === "new_card") {
      if (!canUseNewCard) {
        setError("Payment gateway is not configured for this company.");
        submitInFlightRef.current = false;
        return;
      }
      if (!ifieldsReady) {
        setError("Secure card form is still loading. Wait a moment and try again.");
        submitInFlightRef.current = false;
        return;
      }
      setError("");
      chargePendingRef.current = true;
      setTokenizing(true);
      tokenizeRef.current?.();
      return;
    }
    void postCharge(null);
  }

  function handleReview() {
    setError("");
    setCardFormError("");
    if (chargeMode === "new_card") {
      if (!canUseNewCard) {
        setError(ifieldsKeyMissing
          ? "Payment gateway is enabled but the secure card key is missing. Add the iFields key in Company billing setup."
          : "Payment gateway is not configured for this company.");
        return;
      }
      if (!ifieldsReady) {
        setError("Secure card form is still loading. Wait a moment and try again.");
        return;
      }
      const form = document.getElementById("billing-one-time-ifields-form") as HTMLFormElement | null;
      if (!form) {
        setError("Secure card form is not ready.");
        return;
      }
      const fd = new FormData(form);
      const name = String(fd.get("cardholderName") || "").trim();
      if (!name) {
        setCardFormError("Cardholder name is required.");
        return;
      }
      setBillingPreview({
        cardholderName: name,
        expMonth: String(fd.get("expMonth") || ""),
        expYear: String(fd.get("expYear") || ""),
        billingEmail: String(fd.get("billingEmail") || ""),
        billingPhone: String(fd.get("billingPhone") || ""),
        billingAddress1: String(fd.get("billingAddress1") || ""),
        billingAddress2: String(fd.get("billingAddress2") || ""),
        billingCity: String(fd.get("billingCity") || ""),
        billingState: String(fd.get("billingState") || ""),
        billingZip: String(fd.get("billingZip") || ""),
        billingCountry: String(fd.get("billingCountry") || "US"),
      });
    }
    setStep("confirm");
  }

  function handleCardTokenized(payload: { cardToken: string; billing: CardknoxBillingFields }) {
    setTokenizing(false);
    setCardFormError("");
    if (!payload.cardToken || payload.cardToken.length < 8) {
      const msg = "Could not secure the card. Check the number and try again.";
      if (chargePendingRef.current) setError(msg);
      else setCardFormError(msg);
      chargePendingRef.current = false;
      submitInFlightRef.current = false;
      return;
    }
    if (chargePendingRef.current) {
      chargePendingRef.current = false;
      void postCharge({ cardToken: payload.cardToken, billing: payload.billing });
      return;
    }
    submitInFlightRef.current = false;
    setCardFormError("Unexpected card tokenization. Try again.");
  }

  const confirmPaymentLabel = chargeMode === "none"
    ? "Invoice only"
    : chargeMode === "card_on_file"
      ? cardLabel(methods.find((m) => m.id === paymentMethodId) || { brand: "Card", last4: null })
      : billingPreview
        ? `${billingPreview.cardholderName} · new card`
        : "New card";
  const isInvoiceOnly = chargeMode === "none";
  const panelTitle = step === "done"
    ? (isInvoiceOnly ? "Invoice created" : "Charge complete")
    : (isInvoiceOnly ? "Create invoice" : "Charge customer");
  const panelSubtitle = step === "done"
    ? (isInvoiceOnly ? "The one-time invoice was created." : "The one-time charge was processed.")
    : "Create a one-time invoice and optionally collect payment now.";
  const confirmButtonLabel = isInvoiceOnly
    ? "Create invoice"
    : tokenizing
      ? "Securing card..."
      : busy
        ? "Processing..."
        : isLiveCharge
          ? "Charge now (live)"
          : "Charge now";

  const oneTimeCardForm = chargeMode === "new_card" && canUseNewCard && solaConfig?.ifieldsKey ? (
    <div style={{ marginTop: 12 }}>
      {solaConfig.mode === "sandbox" ? (
        <p className="muted" style={{ fontSize: 12, margin: "0 0 10px" }}>Sandbox gateway — use test cards only.</p>
      ) : null}
      <CardknoxIFieldsForm
        formId="billing-one-time-ifields-form"
        ifieldsKey={solaConfig.ifieldsKey}
        variant="admin"
        hideSubmit
        tokenizeRef={tokenizeRef}
        onReadyChange={setIfieldsReady}
        disabled={tokenizing || busy}
        showBillingAddress
        showEmail
        showPhone={false}
        errorMessage={step === "form" ? cardFormError : null}
        onTokenizeError={(msg) => {
          setTokenizing(false);
          submitInFlightRef.current = false;
          const wasCharge = chargePendingRef.current;
          chargePendingRef.current = false;
          if (wasCharge) setError(msg);
          else setCardFormError(msg);
        }}
        secureNote={(
          <p className="billing-pay-secure-note" style={{ margin: "0 0 12px", fontSize: 12 }}>
            Card number and CVV are entered in PCI-compliant fields hosted by our payment processor. Connect never sees or stores the full card number or CVV.
          </p>
        )}
        onSubmitCardToken={async (payload) => {
          handleCardTokenized({ cardToken: payload.cardToken, billing: payload.billing });
        }}
        childrenAfterCard={(
          <div className="billing-pay-checks" style={{ marginTop: 4 }}>
            <label className="billing-checkbox" style={{ flexDirection: "row", alignItems: "center", gap: 8, fontWeight: 500 }}>
              <input type="checkbox" checked={saveCard} onChange={(e) => setSaveCard(e.target.checked)} disabled={tokenizing || busy} />
              Save card on file after charge
            </label>
            {saveCard ? (
              <label className="billing-checkbox" style={{ flexDirection: "row", alignItems: "center", gap: 8, fontWeight: 500 }}>
                <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} disabled={tokenizing || busy} />
                Set as default payment method
              </label>
            ) : null}
          </div>
        )}
      />
      {!ifieldsReady && step === "form" ? (
        <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>Initializing secure card fields…</p>
      ) : null}
    </div>
  ) : chargeMode === "new_card" ? (
    <p className="muted" style={{ fontSize: 13, margin: "8px 0 0" }}>
      {ifieldsKeyMissing
        ? "Payment gateway is enabled but the secure card capture key is not set. Add the iFields public key in Admin Billing → Company billing setup → Payment gateway."
        : "Payment gateway is not configured for this company."}
    </p>
  ) : null;

  return (

    <BillingActionPanel

      layout="drawer"

      drawerWidth="min(560px, 100vw)"

      variant={step === "confirm" && isLiveCharge && !isInvoiceOnly ? "danger" : "default"}

      onClose={() => { if (!busy && !tokenizing) onClose(); }}

      eyebrow={tenantName}

      title={panelTitle}

      subtitle={panelSubtitle}

      footer={

        step === "done" ? (

          <button className="btn primary" type="button" onClick={onClose}>Close</button>

        ) : step === "confirm" ? (

          <>

            <button className="btn ghost" type="button" disabled={busy} onClick={() => setStep("form")}>← Back</button>

            <button

              className="btn danger"

              type="button"

              disabled={busy || tokenizing}

              onClick={() => submitCharge()}

            >

              {confirmButtonLabel}

            </button>

          </>

        ) : (

          <>

            <button className="btn ghost" type="button" onClick={onClose} disabled={tokenizing}>Cancel</button>

            <button

              className="btn primary"

              type="button"

              disabled={!canProceedForm || tokenizing}

              onClick={handleReview}

            >

              Review charge →

            </button>

          </>

        )

      }

    >

      {step === "done" ? (

        <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "color-mix(in srgb, #39d98a 90%, var(--text))" }}>{resultSummary}</p>

      ) : step === "confirm" ? (

        <>

          <PaySectionTitle>Confirm payment</PaySectionTitle>

          <dl className="billing-pay-drawer-kv">

            <div><dt>Company</dt><dd>{tenantName}</dd></div>

            <div><dt>Description</dt><dd>{description}</dd></div>

            <div><dt>Amount</dt><dd>{dollars(amountCents)}</dd></div>

            {(serviceStartDate || serviceEndDate) ? (
              <div><dt>Service period</dt><dd>{serviceStartDate || "—"} – {serviceEndDate || "—"}</dd></div>
            ) : null}

            <div><dt>Payment</dt><dd>{confirmPaymentLabel}</dd></div>

            {chargeMode === "new_card" && saveCard ? (

              <div><dt>Save card</dt><dd>Yes{makeDefault ? " · set as default" : ""}</dd></div>

            ) : null}

          </dl>

          {isLiveCharge && !isInvoiceOnly ? (

            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#f87171" }}>

              This is a live charge — funds will move on the customer&apos;s card.

            </p>

          ) : isInvoiceOnly ? (

            <p className="muted" style={{ margin: 0, fontSize: 13 }}>No card charge will run. This only creates the invoice.</p>

          ) : (

            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Sandbox mode — no real funds move.</p>

          )}

          {error ? <p style={{ color: "#f87171", fontSize: 13, marginTop: 10 }}>{error}</p> : null}

        </>

      ) : (

        <div className="billing-pay-form-grid">

          <section>

            <PaySectionTitle>Payment summary</PaySectionTitle>

            <p className="muted" style={{ fontSize: 13, margin: "0 0 12px" }}>{tenantName}</p>

            <label>

              Description

              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Rush install fee" maxLength={240} />

            </label>

            <div className="billing-pay-form-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label>
                Service start <span className="muted">(optional)</span>
                <input type="date" value={serviceStartDate} onChange={(e) => setServiceStartDate(e.target.value)} />
              </label>
              <label>
                Service end <span className="muted">(optional)</span>
                <input type="date" value={serviceEndDate} onChange={(e) => setServiceEndDate(e.target.value)} />
              </label>
            </div>

            <label>

              Amount (USD)

              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />

            </label>

            <label>

              Operator note <span className="muted">(optional)</span>

              <input value={operatorNote} onChange={(e) => setOperatorNote(e.target.value)} placeholder="Logged on activity" maxLength={500} />

            </label>

            <label>

              Invoice memo <span className="muted">(optional)</span>

              <input value={invoiceMemo} onChange={(e) => setInvoiceMemo(e.target.value)} placeholder="Shown internally on invoice metadata" maxLength={500} />

            </label>

          </section>



          <section style={{ marginTop: 16 }}>

            <PaySectionTitle>Payment method</PaySectionTitle>

            <fieldset className="billing-pay-charge-modes" style={{ border: "none", margin: 0, padding: 0 }}>

              <label className="billing-pay-charge-mode">

                <input type="radio" name="chargeMode" checked={chargeMode === "card_on_file"} onChange={() => setChargeMode("card_on_file")} />

                <span><strong>Charge card on file</strong><span>Use a saved payment method</span></span>

              </label>

              <label className="billing-pay-charge-mode">

                <input type="radio" name="chargeMode" checked={chargeMode === "new_card"} onChange={() => setChargeMode("new_card")} />

                <span><strong>Charge a new card</strong><span>Secure Cardknox iFields — card data never touches Connect</span></span>

              </label>

              <label className="billing-pay-charge-mode">

                <input type="radio" name="chargeMode" checked={chargeMode === "none"} onChange={() => setChargeMode("none")} />

                <span><strong>Create invoice only</strong><span>Collect later via payment link or register</span></span>

              </label>

            </fieldset>



            {chargeMode === "card_on_file" ? (

              pmData.status === "loading" ? <LoadingSkeleton rows={2} /> : methods.length === 0 ? (

                <p className="muted" style={{ fontSize: 13, margin: "8px 0 0" }}>No saved cards — add a payment method or charge a new card.</p>

              ) : (

                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>

                  {methods.map((m) => (

                    <label key={m.id} className="billing-pay-charge-mode" style={{ cursor: "pointer" }}>

                      <input type="radio" name="pm" checked={paymentMethodId === m.id} onChange={() => setPaymentMethodId(m.id)} />

                      <span><strong>{cardLabel(m)}</strong>{m.isDefault ? <span> · Default</span> : null}</span>

                    </label>

                  ))}

                </div>

              )

            ) : null}




          </section>



          {error ? <p style={{ color: "#f87171", fontSize: 13, margin: "12px 0 0" }}>{error}</p> : null}

        </div>

      )}

      {step !== "done" && chargeMode === "new_card" ? (
        <section className={step === "confirm" ? "billing-ifields-offscreen" : undefined} aria-hidden={step === "confirm" ? true : undefined}>
          {step === "form" ? <PaySectionTitle>Billing details &amp; card</PaySectionTitle> : null}
          {oneTimeCardForm}
        </section>
      ) : null}

    </BillingActionPanel>

  );

}



export function PaymentTransactionDrawer({

  txId,

  isLiveCharge,

  onClose,

  onUpdated,

}: {

  txId: string;

  isLiveCharge: boolean;

  onClose: () => void;

  onUpdated: () => void;

}) {

  const [refundOpen, setRefundOpen] = useState(false);

  const [refundReason, setRefundReason] = useState("");

  const [busy, setBusy] = useState<string | null>(null);

  const [toast, setToast] = useState("");



  const data = useAsyncResource<TxDetail>(() => apiGet(`/admin/billing/transactions/${txId}`), [txId]);

  const tx = data.status === "success" ? data.data : null;



  async function emailPaymentLink() {

    if (!tx?.invoice?.id) return;

    setBusy("email");

    try {

      await apiPost(`/billing/platform/invoices/${tx.invoice.id}/email-payment-link`, {});

      setToast("Payment link queued.");

    } catch (err) {

      setToast(billingErrorMessage(err, "Could not email payment link."));

    } finally {

      setBusy(null);

    }

  }



  async function retryPayment() {

    if (!tx?.invoice?.id) return;

    setBusy("retry");

    try {

      await apiPost(`/admin/billing/invoices/${tx.invoice.id}/retry-payment`, {});

      setToast("Retry submitted.");

      onUpdated();

    } catch (err) {

      setToast(billingErrorMessage(err, "Retry failed."));

    } finally {

      setBusy(null);

    }

  }



  async function submitRefund() {

    setBusy("refund");

    try {

      await apiPost(`/admin/billing/transactions/${txId}/refund`, {

        reason: refundReason.trim() || undefined,

        confirmLive: isLiveCharge ? true : undefined,

      });

      setToast("Refund submitted.");

      setRefundOpen(false);

      onUpdated();

    } catch (err) {

      setToast(billingErrorMessage(err, "Refund failed."));

    } finally {

      setBusy(null);

    }

  }



  const canRefund = tx?.status === "APPROVED";

  const canRetry = tx?.invoice && (tx.status === "DECLINED" || tx.status === "ERROR");



  return (

    <>

      <BillingActionPanel

        layout="drawer"

        drawerWidth="min(480px, 100vw)"

        onClose={onClose}

        eyebrow={tx?.tenant?.name || "Transaction"}

        title="Payment details"

        subtitle={tx ? formatDateTime(tx.createdAt) : ""}

        footer={

          <button className="btn ghost" type="button" onClick={onClose}>Close</button>

        }

      >

        {data.status === "loading" ? <LoadingSkeleton rows={5} /> : null}

        {data.status === "error" ? <ErrorState message={data.error} /> : null}

        {tx ? (

          <>

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>

              <BillingFinanceChip status={tx.status} label={transactionStatusLabel(tx.status)} tone={transactionFinanceStatusTone(tx.status)} />

              <strong style={{ fontSize: 22, fontVariantNumeric: "tabular-nums" }}>{dollars(tx.amountCents)}</strong>

            </div>

            <dl className="billing-pay-drawer-kv">

              <div><dt>Payment method</dt><dd>{tx.paymentMethod ? cardLabel(tx.paymentMethod) : "—"}</dd></div>

              <div><dt>Invoice</dt><dd>{tx.invoice?.invoiceNumber || "—"}</dd></div>

              {tx.responseMessage ? <div><dt>Processor message</dt><dd>{tx.responseMessage}</dd></div> : null}

            </dl>

            {toast ? <p className="muted" style={{ fontSize: 13 }} role="status">{toast}</p> : null}

            <div className="row-actions" style={{ flexWrap: "wrap", gap: 8, marginBottom: 14 }}>

              {canRefund ? (

                <button className="btn ghost" type="button" disabled={!!busy} onClick={() => setRefundOpen(true)}>Refund payment</button>

              ) : null}

              {canRetry ? (

                <button className="btn primary" type="button" disabled={!!busy} onClick={() => void retryPayment()}>

                  {busy === "retry" ? "Retrying…" : "Retry payment"}

                </button>

              ) : null}

              {tx.invoice?.id ? (

                <button className="btn ghost" type="button" disabled={!!busy} onClick={() => void emailPaymentLink()}>

                  {busy === "email" ? "Sending…" : "Email payment link"}

                </button>

              ) : null}

            </div>

            {tx.events && tx.events.length > 0 ? (

              <>

                <p style={{ fontSize: 12, fontWeight: 650, color: "var(--text-dim)", margin: "0 0 8px" }}>Activity</p>

                <BillingActivityList events={tx.events.map((e) => ({ ...e, id: e.id }))} />

              </>

            ) : null}

          </>

        ) : null}

      </BillingActionPanel>



      {refundOpen && tx ? (

        <BillingActionPanel

          layout="center"

          centerWidth="min(420px, 96vw)"

          variant="danger"

          onClose={() => { if (!busy) setRefundOpen(false); }}

          eyebrow={tx.tenant?.name}

          title="Refund this payment?"

          subtitle={`Refunds ${dollars(tx.amountCents)} to the customer's card via the processor.`}

          footer={

            <>

              <button className="btn ghost" type="button" disabled={!!busy} onClick={() => setRefundOpen(false)}>Cancel</button>

              <button className="btn danger" type="button" disabled={!!busy} onClick={() => void submitRefund()}>

                {busy === "refund" ? "Refunding…" : isLiveCharge ? "Confirm live refund" : "Confirm refund"}

              </button>

            </>

          }

        >

          <label className="billing-pay-form-grid" style={{ display: "block" }}>

            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-dim)" }}>Reason (optional)</span>

            <input value={refundReason} onChange={(e) => setRefundReason(e.target.value)} maxLength={500} placeholder="e.g. Customer dispute" style={{ width: "100%", marginTop: 6 }} />

          </label>

        </BillingActionPanel>

      ) : null}

    </>

  );

}

