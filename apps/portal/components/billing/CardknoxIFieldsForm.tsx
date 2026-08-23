"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import IField, { CARD_TYPE, CVV_TYPE, type ErrorData, type TokenData } from "@cardknox/react-ifields";
import { ConnectSelect } from "../ConnectSelect";

export type CardknoxBillingFields = {
  cardholderName: string;
  expMonth: string;
  expYear: string;
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
  fieldTheme?: "light" | "dark";
  disabled?: boolean;
  showBillingAddress?: boolean;
  showEmail?: boolean;
  showPhone?: boolean;
  showSaveOptions?: boolean;
  autoEnableAutopayWhenSaving?: boolean;
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
  expMonth: "",
  expYear: "",
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
  fieldTheme,
  disabled = false,
  showBillingAddress = true,
  showEmail = true,
  showPhone = false,
  showSaveOptions = false,
  autoEnableAutopayWhenSaving = false,
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
  // Expiry lives in controlled state: the selects are ConnectSelects whose
  // hidden inputs feed FormData, and hidden inputs are EXEMPT from browser
  // `required` validation — so emptiness is checked explicitly below and
  // surfaced as expiryError instead of relying on reportValidity.
  const [expMonth, setExpMonth] = useState("");
  const [expYear, setExpYear] = useState("");
  const [expiryError, setExpiryError] = useState<string | null>(null);
  const cardFieldRef = useRef<{ getToken?: () => void } | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const pendingRef = useRef<CardknoxBillingFields | null>(null);
  const tokenConsumedRef = useRef(false);

  useEffect(() => {
    onReadyChange?.(ifieldsReady);
  }, [ifieldsReady, onReadyChange]);

  const account = useMemo(
    () => ({ xKey: ifieldsKey.trim(), xSoftwareName: "ConnectComms", xSoftwareVersion: "1.0.0" }),
    [ifieldsKey],
  );
  const resolvedFieldTheme = fieldTheme ?? (variant === "admin" ? "dark" : "light");

  const ifieldOptions = useMemo(
    () => ({
      autoFormat: true,
      blockNonNumericInput: true,
      iFieldstyle: {
        border: "0",
        outline: "0",
        boxShadow: "none",
        appearance: "none",
        WebkitAppearance: "none",
        MozAppearance: "textfield",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
        fontSize: "14px",
        fontWeight: "500",
        lineHeight: "46px",
        padding: "0",
        margin: "0",
        width: "100%",
        height: "46px",
        overflow: "hidden",
        resize: "none",
        color: resolvedFieldTheme === "dark" ? "#e5eefb" : "#0f172a",
        background: "transparent",
      },
    }),
    [resolvedFieldTheme],
  );

  function readBilling(form: HTMLFormElement): CardknoxBillingFields {
    const fd = new FormData(form);
    return {
      cardholderName: String(fd.get("cardholderName") || "").trim(),
      expMonth: String(fd.get("expMonth") || "").trim(),
      expYear: String(fd.get("expYear") || "").trim(),
      billingEmail: String(fd.get("billingEmail") || "").trim(),
      billingPhone: String(fd.get("billingPhone") || "").trim(),
      billingAddress1: String(fd.get("billingAddress1") || "").trim(),
      billingAddress2: String(fd.get("billingAddress2") || "").trim(),
      billingCity: String(fd.get("billingCity") || "").trim(),
      billingState: String(fd.get("billingState") || "").trim(),
      billingZip: String(fd.get("billingZip") || "").trim(),
      billingCountry: String(fd.get("billingCountry") || "US").trim(),
    };
  }

  function validateRequiredBillingFields(form: HTMLFormElement): boolean {
    // expMonth/expYear are ConnectSelects backed by hidden inputs, which the
    // browser's constraint validation skips — checked explicitly first.
    if (!expMonth.trim() || !expYear.trim()) {
      setExpiryError("Choose the card's expiration month and year.");
      return false;
    }
    setExpiryError(null);

    const requiredNames = [
      "cardholderName",
      ...(showEmail ? ["billingEmail"] : []),
      ...(showBillingAddress ? ["billingAddress1", "billingCity", "billingState", "billingZip"] : ["billingZip"]),
    ];

    for (const name of requiredNames) {
      const field = form.elements.namedItem(name);
      if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) continue;
      field.setCustomValidity(field.value.trim() ? "" : "This field is required.");
    }

    const isValid = form.checkValidity();
    if (!isValid) form.reportValidity();

    for (const name of requiredNames) {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
        field.setCustomValidity("");
      }
    }

    return isValid;
  }

  async function handleCardToken(data: TokenData) {
    if (data.xTokenType !== CARD_TYPE || !data.xToken) return;
    if (tokenConsumedRef.current) return;
    tokenConsumedRef.current = true;
    const billing = pendingRef.current || EMPTY_BILLING;
    pendingRef.current = null;
    try {
      await onSubmitCardToken({
        cardToken: data.xToken,
        billing,
        saveCard,
        enableAutopay: autoEnableAutopayWhenSaving ? saveCard : enableAutopay,
      });
    } finally {
      setBusy(false);
    }
  }

  function handleCardError(data: ErrorData) {
    pendingRef.current = null;
    tokenConsumedRef.current = false;
    setBusy(false);
    const errText = (data as unknown as { xError?: string })?.xError;
    const msg = typeof errText === "string" && errText.trim()
      ? errText.trim()
      : "Could not read the card. Check the number and try again.";
    onTokenizeError?.(msg);
  }

  function beginTokenize(form: HTMLFormElement) {
    if (busy || disabled || !ifieldsReady) return;
    if (!validateRequiredBillingFields(form)) return;
    pendingRef.current = readBilling(form);
    tokenConsumedRef.current = false;
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

  const years = useMemo(() => {
    const current = new Date().getFullYear();
    return Array.from({ length: 12 }, (_, idx) => String(current + idx));
  }, []);

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
      <label className="billing-field-cardholder">
        Cardholder name
        <input name="cardholderName" autoComplete="cc-name" placeholder="Jane Smith" required disabled={disabled || busy} />
      </label>
      <div className="billing-pay-row billing-pay-row--expiration">
        <label>
          Month
          <ConnectSelect
            name="expMonth"
            value={expMonth}
            onChange={(v) => { setExpMonth(v); setExpiryError(null); }}
            placeholder="Month"
            ariaLabel="Expiration month"
            disabled={disabled || busy}
            theme={resolvedFieldTheme}
            style={{ width: "100%" }}
            options={Array.from({ length: 12 }, (_, idx) => {
              const month = String(idx + 1).padStart(2, "0");
              return { value: month, label: month };
            })}
          />
        </label>
        <label>
          Exp. year
          <ConnectSelect
            name="expYear"
            value={expYear}
            onChange={(v) => { setExpYear(v); setExpiryError(null); }}
            placeholder="Year"
            ariaLabel="Expiration year"
            disabled={disabled || busy}
            theme={resolvedFieldTheme}
            style={{ width: "100%" }}
            options={years.map((year) => ({ value: year, label: year }))}
          />
        </label>
      </div>
      {expiryError ? (
        <p className="billing-pay-error" role="alert" style={{ margin: "4px 0 0", fontSize: 12, color: "#dc2626" }}>
          {expiryError}
        </p>
      ) : null}
      {showEmail ? (
        <label className="billing-field-email">
          Billing email
          <input name="billingEmail" type="email" autoComplete="email" placeholder="billing@company.com" required disabled={disabled || busy} />
        </label>
      ) : null}
      {showPhone ? (
        <label className="billing-field-phone">
          Phone <span className="muted">(optional)</span>
          <input name="billingPhone" type="tel" autoComplete="tel" placeholder="(555) 555-0100" disabled={disabled || busy} />
        </label>
      ) : null}
      {showBillingAddress ? (
        <>
          <label className="billing-field-address1">
            Address line 1
            <input name="billingAddress1" autoComplete="billing address-line1" placeholder="123 Main St" required disabled={disabled || busy} />
          </label>
          <label className="billing-field-address2">
            Address line 2 <span className="muted">(optional)</span>
            <input name="billingAddress2" autoComplete="billing address-line2" placeholder="Suite 100" disabled={disabled || busy} />
          </label>
          <div className="billing-pay-row billing-pay-row--address">
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
        <label className="billing-field-zip-only">
          Billing ZIP
          <input name="billingZip" autoComplete="postal-code" placeholder="10001" required disabled={disabled || busy} />
        </label>
      )}
      <label className="billing-ifields-card">
        Card number
        <span className="billing-ifields-host" aria-required="true">
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
        <span className="billing-ifields-host" aria-required="true">
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
            <span>
              {autoEnableAutopayWhenSaving ? "Save this card for future automatic payments" : "Save this card for future payments"}
              {autoEnableAutopayWhenSaving ? (
                <small>Saving this card also turns on autopay for future invoices.</small>
              ) : null}
            </span>
          </label>
          {!autoEnableAutopayWhenSaving ? (
            <label className="billing-checkbox">
              <input
                type="checkbox"
                checked={enableAutopay}
                onChange={(e) => onEnableAutopayChange?.(e.target.checked)}
                disabled={disabled || busy || !saveCard}
              />
              <span>
                Enable autopay on this card
                <small>We will charge this card automatically on your payment date each month.</small>
              </span>
            </label>
          ) : null}
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
