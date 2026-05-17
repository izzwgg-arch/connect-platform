"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
import { apiGet, apiPost } from "../../../../../services/apiClient";
import { ErrorState } from "../../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { billingErrorMessage } from "../../../../../components/BillingActionToast";
import { BillingActionPanel } from "../../../../../components/billing/BillingActionPanel";
import { BillingActivityList } from "../../../../../components/billing/BillingActivityList";
import { BillingFinanceChip } from "../../../../../components/billing/BillingFinanceChip";
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

export function OneTimeChargeDrawer({
  tenantId,
  tenantName,
  isLiveCharge,
  initialPaymentMethodId,
  onClose,
  onSuccess,
}: {
  tenantId: string;
  tenantName: string;
  isLiveCharge: boolean;
  initialPaymentMethodId?: string | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [step, setStep] = useState<"form" | "confirm" | "done">("form");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [operatorNote, setOperatorNote] = useState("");
  const [invoiceMemo, setInvoiceMemo] = useState("");
  const [chargeMode, setChargeMode] = useState<"none" | "card_on_file" | "new_card">("card_on_file");
  const [paymentMethodId, setPaymentMethodId] = useState("");
  const [saveCard, setSaveCard] = useState(true);
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resultSummary, setResultSummary] = useState("");

  const [solaConfig, setSolaConfig] = useState<AdminSolaPublicConfig | null>(null);
  const [ifieldsReady, setIfieldsReady] = useState(false);
  const submittedRef = useRef(false);

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
    if (!solaConfig?.enabled || !solaConfig?.ifieldsKey) return;
    const version = "3.4.2602.2001";
    const scriptId = `cardknox-ifields-${version}`;
    const configure = () => {
      if (window.setAccount) {
        window.setAccount(solaConfig.ifieldsKey!, "ConnectComms", "1.0.0");
        setIfieldsReady(true);
      }
    };
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (existing) { configure(); return; }
    const script = document.createElement("script");
    script.id = scriptId;
    script.src = `https://cdn.cardknox.com/ifields/${version}/ifields.min.js`;
    script.async = true;
    script.onload = configure;
    document.body.appendChild(script);
  }, [solaConfig]);

  const amountCents = parseAmountToCents(amount) ?? 0;
  const canProceedForm = description.trim().length > 0 && amountCents > 0
    && (chargeMode === "none" || (chargeMode === "card_on_file" && !!paymentMethodId) || chargeMode === "new_card");

  async function submitCharge(getSut?: () => Promise<string | null>) {
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = {
        description: description.trim(),
        amountCents,
        operatorNote: operatorNote.trim() || undefined,
        invoiceMemo: invoiceMemo.trim() || undefined,
        chargeMode,
        confirmLive: isLiveCharge ? true : undefined,
      };
      if (chargeMode === "card_on_file") body.paymentMethodId = paymentMethodId;
      if (chargeMode === "new_card") {
        const xSut = getSut ? await getSut() : null;
        if (!xSut) {
          setError("Enter a valid card in the secure form.");
          return;
        }
        body.xSut = xSut;
        body.saveCard = saveCard;
        body.makeDefault = makeDefault;
      }
      const res = await apiPost<{ invoice: { invoiceNumber: string; status: string }; transaction: { status: string } | null }>(
        `/admin/billing/platform/tenants/${tenantId}/one-time-charges`,
        body,
      );
      const invNum = res.invoice?.invoiceNumber || "Invoice";
      const txStatus = res.transaction?.status;
      setResultSummary(
        txStatus
          ? `${invNum} · ${transactionStatusLabel(txStatus)}`
          : `${invNum} created — charge when ready from the register.`,
      );
      setStep("done");
      onSuccess();
    } catch (err) {
      setError(billingErrorMessage(err, "Unable to complete this charge."));
    } finally {
      setBusy(false);
    }
  }

  const ifieldsVersion = "3.4.2602.2001";
  const canAddCard = !!solaConfig?.enabled && !!solaConfig?.ifieldsKey;

  return (
    <BillingActionPanel
      layout="drawer"
      drawerWidth="min(520px, 100vw)"
      variant={step === "confirm" && isLiveCharge ? "danger" : "default"}
      onClose={() => { if (!busy) onClose(); }}
      eyebrow={tenantName}
      title={step === "done" ? "Charge complete" : "Charge customer"}
      subtitle={
        step === "done"
          ? "The one-time charge was processed."
          : "Create a one-time invoice and optionally collect payment now."
      }
      footer={
        step === "done" ? (
          <button className="btn primary" type="button" onClick={onClose}>Close</button>
        ) : step === "confirm" ? (
          <>
            <button className="btn ghost" type="button" disabled={busy} onClick={() => setStep("form")}>← Back</button>
            <button
              className="btn danger"
              type="button"
              disabled={busy}
              onClick={() => {
                if (chargeMode !== "new_card") {
                  void submitCharge();
                  return;
                }
                const form = document.getElementById("billing-one-time-card-form") as HTMLFormElement | null;
                if (!form || !window.getTokens) {
                  setError("Secure card form is not ready.");
                  return;
                }
                setBusy(true);
                window.getTokens(async () => {
                  const fd = new FormData(form);
                  const xSut = String(fd.get("xCardNum") || "");
                  if (!xSut) {
                    setBusy(false);
                    setError("Card token missing — check the card number.");
                    return;
                  }
                  await submitCharge(async () => xSut);
                }, () => {
                  setBusy(false);
                  setError("Could not tokenize the card.");
                }, 30000);
              }}
            >
              {busy ? "Processing…" : isLiveCharge ? "Submit live charge" : "Submit charge"}
            </button>
          </>
        ) : (
          <>
            <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
            <button className="btn primary" type="button" disabled={!canProceedForm} onClick={() => setStep("confirm")}>
              Review →
            </button>
          </>
        )
      }
    >
      {step === "done" ? (
        <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "color-mix(in srgb, #39d98a 90%, var(--text))" }}>{resultSummary}</p>
      ) : step === "confirm" ? (
        <>
          <dl className="billing-pay-drawer-kv">
            <div><dt>Description</dt><dd>{description}</dd></div>
            <div><dt>Amount</dt><dd>{dollars(amountCents)}</dd></div>
            <div><dt>Payment</dt><dd>{chargeMode === "none" ? "Invoice only" : chargeMode === "card_on_file" ? cardLabel(methods.find((m) => m.id === paymentMethodId) || { brand: "Card", last4: null }) : "New card"}</dd></div>
          </dl>
          {isLiveCharge ? (
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#f87171" }}>Live gateway — funds move for real.</p>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Sandbox — no real funds move.</p>
          )}
          {error ? <p style={{ color: "#f87171", fontSize: 13, marginTop: 10 }}>{error}</p> : null}
        </>
      ) : (
        <div className="billing-pay-form-grid">
          <label>
            Description
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Rush install fee" maxLength={240} />
          </label>
          <label>
            Amount (USD)
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </label>
          <label>
            Operator note (optional)
            <input value={operatorNote} onChange={(e) => setOperatorNote(e.target.value)} placeholder="Logged on activity" maxLength={500} />
          </label>
          <label>
            Invoice memo (optional)
            <input value={invoiceMemo} onChange={(e) => setInvoiceMemo(e.target.value)} placeholder="Shown internally on invoice metadata" maxLength={500} />
          </label>

          <fieldset className="billing-pay-charge-modes" style={{ border: "none", margin: 0, padding: 0 }}>
            <legend style={{ fontSize: 12, fontWeight: 650, marginBottom: 8, color: "var(--text-dim)" }}>Collect payment</legend>
            <label className="billing-pay-charge-mode">
              <input type="radio" name="chargeMode" checked={chargeMode === "card_on_file"} onChange={() => setChargeMode("card_on_file")} />
              <span><strong>Charge card on file</strong><span>Use a saved payment method</span></span>
            </label>
            <label className="billing-pay-charge-mode">
              <input type="radio" name="chargeMode" checked={chargeMode === "new_card"} onChange={() => setChargeMode("new_card")} />
              <span><strong>Charge a new card</strong><span>Secure card form — optionally save for later</span></span>
            </label>
            <label className="billing-pay-charge-mode">
              <input type="radio" name="chargeMode" checked={chargeMode === "none"} onChange={() => setChargeMode("none")} />
              <span><strong>Create invoice only</strong><span>Collect later from the invoice register</span></span>
            </label>
          </fieldset>

          {chargeMode === "card_on_file" ? (
            pmData.status === "loading" ? <LoadingSkeleton rows={2} /> : methods.length === 0 ? (
              <p className="muted" style={{ fontSize: 13, margin: 0 }}>No saved cards — add a payment method or use a new card.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {methods.map((m) => (
                  <label key={m.id} className="billing-pay-charge-mode" style={{ cursor: "pointer" }}>
                    <input type="radio" name="pm" checked={paymentMethodId === m.id} onChange={() => setPaymentMethodId(m.id)} />
                    <span><strong>{cardLabel(m)}</strong>{m.isDefault ? <span> · Default</span> : null}</span>
                  </label>
                ))}
              </div>
            )
          ) : null}

          {chargeMode === "new_card" ? (
            canAddCard ? (
              <form
                id="billing-one-time-card-form"
                className="billing-form"
                onSubmit={(e) => e.preventDefault()}
              >
                <label>Cardholder name <input name="cardholderName" autoComplete="cc-name" /></label>
                <label>Billing ZIP <input name="billingZip" autoComplete="postal-code" /></label>
                <label>
                  Card number
                  <iframe className="sola-ifield-frame" title="Secure card number" data-ifields-id="card-number" data-ifields-placeholder="Card Number" src={`https://cdn.cardknox.com/ifields/${ifieldsVersion}/ifield.htm`} />
                </label>
                <label>
                  CVV
                  <iframe className="sola-ifield-frame" title="Secure CVV" data-ifields-id="cvv" data-ifields-placeholder="CVV" src={`https://cdn.cardknox.com/ifields/${ifieldsVersion}/ifield.htm`} />
                </label>
                <input name="xCardNum" data-ifields-id="card-number-token" type="hidden" />
                <input name="xCVV" data-ifields-id="cvv-token" type="hidden" />
                <label style={{ flexDirection: "row", alignItems: "center", gap: 8, fontWeight: 500 }}>
                  <input type="checkbox" checked={saveCard} onChange={(e) => setSaveCard(e.target.checked)} />
                  Save card on file after charge
                </label>
                {saveCard ? (
                  <label style={{ flexDirection: "row", alignItems: "center", gap: 8, fontWeight: 500 }}>
                    <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
                    Set as default
                  </label>
                ) : null}
              </form>
            ) : (
              <p className="muted" style={{ fontSize: 13, margin: 0 }}>Secure card capture is not configured for this company.</p>
            )
          ) : null}

          {error ? <p style={{ color: "#f87171", fontSize: 13, margin: 0 }}>{error}</p> : null}
        </div>
      )}
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
