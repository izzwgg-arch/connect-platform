"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import IField, { CARD_TYPE, CVV_TYPE, type ErrorData, type TokenData } from "@cardknox/react-ifields";

export type CardknoxBillingFields = {
  cardholderName: string;
  billingEmail: string;
  billingPhone: string;
  billingAddress1: string;
  billingAddress2: string;
  billingCity: string;
  billingState: string;
  billingZip: string;
  billingCountry: string;
};

export type CardknoxIFieldsFormProps = {
  ifieldsKey: string;
  variant?: "admin" | "customer";
  disabled?: boolean;
  showBillingAddress?: boolean;
  showEmail?: boolean;
  showPhone?: boolean;
  showSaveOptions?: boolean;
  saveCard?: boolean;
  enableAutopay?: boolean;
  onSaveCardChange?: (v: boolean) => void;
  onEnableAutopayChange?: (v: boolean) => void;
  submitLabel?: string;
  busyLabel?: string;
  secureNote?: ReactNode;
  errorMessage?: string | null;
  /** When true, omit the built-in submit button (parent triggers tokenization via `tokenizeRef`). */
  hideSubmit?: boolean;
  formId?: string;
  onReadyChange?: (ready: boolean) => void;
  /** Parent calls `tokenizeRef.current?.()` to tokenize (e.g. admin drawer review step). */
  tokenizeRef?: React.MutableRefObject<(() => void) | null>;
  onTokenizeError?: (message: string) => void;
  childrenAfterCard?: ReactNode;
  onSubmitCardToken: (payload: {
    cardToken: string;
    billing: CardknoxBillingFields;
    saveCard: boolean;
    enableAutopay: boolean;
  }) => void | Promise<void>;
};

const EMPTY_BILLING: CardknoxBillingFields = {
  cardholderName: "",
  billingEmail: "",
  billingPhone: "",
  billingAddress1: "",
  billingAddress2: "",
  billingCity: "",
  billingState: "",
  billingZip: "",
  billingCountry: "US",
};

export function CardknoxIFieldsForm({
  ifieldsKey,
  variant = "customer",
  disabled = false,
  showBillingAddress = true,
  showEmail = true,
  showPhone = false,
  showSaveOptions = false,
  saveCard = false,
  enableAutopay = false,
  onSaveCardChange,
  onEnableAutopayChange,
  submitLabel = "Pay now",
  busyLabel = "Securing…",
  secureNote,
  errorMessage,
  hideSubmit = false,
  formId,
  onReadyChange,
  tokenizeRef,
  onTokenizeError,
  childrenAfterCard,
  onSubmitCardToken,
}: CardknoxIFieldsFormProps) {
  const [ifieldsReady, setIfieldsReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const cardFieldRef = useRef<{ getToken?: () => void } | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const pendingRef = useRef<CardknoxBillingFields | null>(null);

  useEffect(() => {
    onReadyChange?.(ifieldsReady);
  }, [ifieldsReady, onReadyChange]);

  const account = useMemo(
    () => ({ xKey: ifieldsKey.trim(), xSoftwareName: "ConnectComms", xSoftwareVersion: "1.0.0" }),
    [ifieldsKey],
  );

  const ifieldOptions = useMemo(
    () => ({
      autoFormat: true,
      blockNonNumericInput: true,
      iFieldstyle: {
        border: "0",
        fontSize: "14px",
        padding: "10px 12px",
        width: "100%",
        color: variant === "admin" ? "#f3f4f6" : "#111827",
        background: variant === "admin" ? "#1f2937" : "#ffffff",
      },
    }),
    [variant],
  );

  function readBilling(form: HTMLFormElement): CardknoxBillingFields {
    const fd = new FormData(form);
    return {
      cardholderName: String(fd.get("cardholderName") || ""),
      billingEmail: String(fd.get("billingEmail") || ""),
      billingPhone: String(fd.get("billingPhone") || ""),
      billingAddress1: String(fd.get("billingAddress1") || ""),
      billingAddress2: String(fd.get("billingAddress2") || ""),
      billingCity: String(fd.get("billingCity") || ""),
      billingState: String(fd.get("billingState") || ""),
      billingZip: String(fd.get("billingZip") || ""),
      billingCountry: String(fd.get("billingCountry") || "US"),
    };
  }

  async function handleCardToken(data: TokenData) {
    if (data.xTokenType !== CARD_TYPE || !data.xToken) return;
    const billing = pendingRef.current || EMPTY_BILLING;
    pendingRef.current = null;
    try {
      await onSubmitCardToken({
        cardToken: data.xToken,
        billing,
        saveCard,
        enableAutopay,
      });
    } finally {
      setBusy(false);
    }
  }

  function handleCardError(data: ErrorData) {
    pendingRef.current = null;
    setBusy(false);
    const errText = (data as unknown as { xError?: string })?.xError;
    const msg = typeof errText === "string" && errText.trim()
      ? errText.trim()
      : "Could not read the card. Check the number and try again.";
    onTokenizeError?.(msg);
  }

  function beginTokenize(form: HTMLFormElement) {
    if (busy || disabled || !ifieldsReady) return;
    pendingRef.current = readBilling(form);
    setBusy(true);
    cardFieldRef.current?.getToken?.();
  }

  useEffect(() => {
    if (!tokenizeRef) return;
    tokenizeRef.current = () => {
      if (!formRef.current) {
        onTokenizeError?.("Secure card form is not ready.");
        return;
      }
      beginTokenize(formRef.current);
    };
    return () => {
      tokenizeRef.current = null;
    };
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    beginTokenize(e.currentTarget);
  }

  const formClass = variant === "admin"
    ? "billing-form billing-ifields-form billing-ifields-form--admin"
    : "billing-form billing-pay-form billing-pay-form--light billing-ifields-form";

  return (
    <form ref={formRef} id={formId} className={formClass} onSubmit={onSubmit}>
      {secureNote ?? (
        <p className="billing-pay-secure-note">
          Card details are entered in a PCI-compliant secure field hosted by our payment processor. Connect never sees or stores your full card number or CVV.
        </p>
      )}
      <label>
        Cardholder name
        <input name="cardholderName" autoComplete="cc-name" placeholder="Jane Smith" required disabled={disabled || busy} />
      </label>
      {showEmail ? (
        <label>
          Billing email
          <input name="billingEmail" type="email" autoComplete="email" placeholder="billing@company.com" required disabled={disabled || busy} />
        </label>
      ) : null}
      {showPhone ? (
        <label>
          Phone <span className="muted">(optional)</span>
          <input name="billingPhone" type="tel" autoComplete="tel" placeholder="(555) 555-0100" disabled={disabled || busy} />
        </label>
      ) : null}
      {showBillingAddress ? (
        <>
          <label>
            Address line 1
            <input name="billingAddress1" autoComplete="billing address-line1" placeholder="123 Main St" required disabled={disabled || busy} />
          </label>
          <label>
            Address line 2 <span className="muted">(optional)</span>
            <input name="billingAddress2" autoComplete="billing address-line2" placeholder="Suite 100" disabled={disabled || busy} />
          </label>
          <div className="billing-pay-row">
            <label>
              City
              <input name="billingCity" autoComplete="billing address-level2" placeholder="New York" required disabled={disabled || busy} />
            </label>
            <label>
              State
              <input name="billingState" autoComplete="billing address-level1" placeholder="NY" maxLength={2} required disabled={disabled || busy} />
            </label>
            <label>
              ZIP
              <input name="billingZip" autoComplete="postal-code" placeholder="10001" required disabled={disabled || busy} />
            </label>
          </div>
        </>
      ) : (
        <label>
          Billing ZIP
          <input name="billingZip" autoComplete="postal-code" placeholder="10001" required disabled={disabled || busy} />
        </label>
      )}
      <label className="billing-ifields-card">
        Card number
        <span className="billing-ifields-host">
          <IField
            ref={cardFieldRef as any}
            account={account}
            type={CARD_TYPE}
            options={{ ...ifieldOptions, placeholder: "Card number" }}
            onLoad={() => setIfieldsReady(true)}
            onToken={handleCardToken}
            onError={handleCardError}
          />
        </span>
      </label>
      <label className="billing-ifields-cvv">
        CVV
        <span className="billing-ifields-host">
          <IField
            account={account}
            type={CVV_TYPE}
            options={{ ...ifieldOptions, placeholder: "CVV" }}
            onLoad={() => undefined}
            onToken={() => undefined}
            onError={() => undefined}
          />
        </span>
      </label>
      {childrenAfterCard}
      {showSaveOptions ? (
        <div className="billing-pay-checks">
          <label className="billing-checkbox">
            <input
              type="checkbox"
              checked={saveCard}
              onChange={(e) => onSaveCardChange?.(e.target.checked)}
              disabled={disabled || busy}
            />
            Save this card for future payments
          </label>
          <label className="billing-checkbox">
            <input
              type="checkbox"
              checked={enableAutopay}
              onChange={(e) => onEnableAutopayChange?.(e.target.checked)}
              disabled={disabled || busy || !saveCard}
            />
            Enable autopay on this card
          </label>
        </div>
      ) : null}
      {errorMessage ? <div className="billing-status-pill bad">{errorMessage}</div> : null}
      {!hideSubmit ? (
      <button
        className="btn primary"
        type="submit"
        disabled={disabled || busy || !ifieldsReady}
        title={!ifieldsReady ? "Waiting for the secure card form…" : undefined}
      >
        {busy ? busyLabel : ifieldsReady ? submitLabel : "Initializing secure form…"}
      </button>
      ) : null}
    </form>
  );
}
