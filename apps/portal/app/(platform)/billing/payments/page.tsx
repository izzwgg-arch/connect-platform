"use client";

import { useEffect, useState } from "react";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiDelete, apiGet, apiPost } from "../../../../services/apiClient";
import { DetailCard } from "../../../../components/DetailCard";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";

declare global {
  interface Window {
    setAccount?: (key: string, softwareName: string, softwareVersion: string) => void;
    getTokens?: (success: () => void, failure: () => void, timeoutMs: number) => void;
  }
}

export default function BillingPaymentsPage() {
  const [showAdvancedTokenForm, setShowAdvancedTokenForm] = useState(false);
  const [busy, setBusy] = useState("");
  const [cardMessage, setCardMessage] = useState("");
  const [solaPublicConfig, setSolaPublicConfig] = useState<any>(null);
  const [ifieldsReady, setIfieldsReady] = useState(false);
  const methods = useAsyncResource(() => apiGet<any[]>("/billing/payment-methods"), []);
  const rows = methods.status === "success" ? methods.data : [];

  useEffect(() => {
    let active = true;
    apiGet<any>("/billing/sola/public-config")
      .then((config) => { if (active) setSolaPublicConfig(config); })
      .catch(() => { if (active) setSolaPublicConfig(null); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!solaPublicConfig?.enabled || !solaPublicConfig?.ifieldsKey) return;
    const version = solaPublicConfig.ifieldsVersion || "3.4.2602.2001";
    const scriptId = `cardknox-ifields-${version}`;
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
    const configure = () => {
      if (window.setAccount) {
        window.setAccount(solaPublicConfig.ifieldsKey, "ConnectComms", "1.0.0");
        setIfieldsReady(true);
      }
    };
    if (existing) {
      configure();
      return;
    }
    const script = document.createElement("script");
    script.id = scriptId;
    script.src = `https://cdn.cardknox.com/ifields/${version}/ifields.min.js`;
    script.async = true;
    script.onload = configure;
    script.onerror = () => setCardMessage("Unable to load the secure SOLA card form. Use advanced token entry or contact support.");
    document.body.appendChild(script);
  }, [solaPublicConfig]);

  return (
    <PermissionGate permission="can_view_reports" fallback={<div className="state-box">You do not have payment access.</div>}>
      <div className="stack compact-stack billing-admin-shell">
        <PageHeader title="Payment Methods" subtitle="Saved SOLA tokenized cards. Raw card numbers are never stored in ConnectComms." />
        <section className="billing-tenant-hero">
          <div>
            <span className="eyebrow">Card on file</span>
            <h2>{rows.length ? "Payment method ready" : "Add a SOLA card"}</h2>
            <p className="muted">ConnectComms saves only SOLA/Cardknox vault tokens and masked card details. Full card numbers never touch ConnectComms storage.</p>
          </div>
          <div className="billing-hero-metrics">
            <span><strong>{String(rows.length)}</strong><small>Cards saved</small></span>
            <span><strong>{rows.some((method) => method.isDefault) ? "Yes" : "No"}</strong><small>Default card</small></span>
          </div>
        </section>
        <DetailCard title="Secure SOLA Card Setup">
          <p className="muted">Enter card details in SOLA-hosted iFields. The card number and CVV stay inside SOLA iframes, and ConnectComms receives only a single-use token to vault the card.</p>
          {!solaPublicConfig?.enabled || !solaPublicConfig?.ifieldsKey ? (
            <div className="billing-status-pill warn">SOLA iFields is not enabled for this tenant. Ask an admin to add the tenant iFields public key in Admin Billing.</div>
          ) : (
            <form className="billing-form" onSubmit={async (event) => {
              event.preventDefault();
              const form = event.currentTarget;
              setBusy("ifields");
              setCardMessage("");
              if (!window.getTokens) {
                setBusy("");
                setCardMessage("The secure SOLA form is not ready yet. Please wait a moment and try again.");
                return;
              }
              window.getTokens(async () => {
                const formData = new FormData(form);
                const xSut = String(formData.get("xCardNum") || "");
                if (!xSut) {
                  setBusy("");
                  setCardMessage("SOLA did not return a card token. Check the card number and try again.");
                  return;
                }
                try {
                  await apiPost("/billing/payment-methods/sola/save", {
                    xSut,
                    cardholderName: String(formData.get("cardholderName") || ""),
                    billingZip: String(formData.get("billingZip") || ""),
                    makeDefault: true
                  });
                  window.location.reload();
                } catch (err: any) {
                  setCardMessage(err?.message || "Unable to save this SOLA card.");
                  setBusy("");
                }
              }, () => {
                setBusy("");
                setCardMessage("SOLA could not tokenize the card. Please verify the fields and try again.");
              }, 30000);
            }}>
              <label>Cardholder name <input name="cardholderName" autoComplete="cc-name" placeholder="Jane Smith" /></label>
              <label>Billing ZIP <input name="billingZip" autoComplete="postal-code" placeholder="10950" /></label>
              <label>Card number
                <iframe className="sola-ifield-frame" title="Secure card number" data-ifields-id="card-number" data-ifields-placeholder="Card Number" src={`https://cdn.cardknox.com/ifields/${solaPublicConfig.ifieldsVersion || "3.4.2602.2001"}/ifield.htm`} />
              </label>
              <label>CVV
                <iframe className="sola-ifield-frame" title="Secure CVV" data-ifields-id="cvv" data-ifields-placeholder="CVV" src={`https://cdn.cardknox.com/ifields/${solaPublicConfig.ifieldsVersion || "3.4.2602.2001"}/ifield.htm`} />
              </label>
              <input name="xCardNum" data-ifields-id="card-number-token" type="hidden" />
              <input name="xCVV" data-ifields-id="cvv-token" type="hidden" />
              {cardMessage ? <div className="billing-status-pill bad">{cardMessage}</div> : null}
              <button className="btn primary" type="submit" disabled={busy === "ifields" || !ifieldsReady}>{busy === "ifields" ? "Securing..." : ifieldsReady ? "Save Secure Card" : "Loading secure form..."}</button>
            </form>
          )}
          <button className="btn ghost" type="button" onClick={() => setShowAdvancedTokenForm((value) => !value)}>
            {showAdvancedTokenForm ? "Hide advanced token entry" : "Use advanced SUT token entry"}
          </button>
          {showAdvancedTokenForm ? (
            <form className="billing-form" onSubmit={async (event) => {
              event.preventDefault();
              setBusy("save-card");
              try {
                const form = new FormData(event.currentTarget);
                await apiPost("/billing/payment-methods/sola/save", {
                  xSut: String(form.get("xSut") || ""),
                  cardholderName: String(form.get("cardholderName") || ""),
                  billingZip: String(form.get("billingZip") || ""),
                  makeDefault: true
                });
                window.location.reload();
              } finally {
                setBusy("");
              }
            }}>
              <label>Cardholder name <input name="cardholderName" placeholder="Jane Smith" /></label>
              <label>Billing ZIP <input name="billingZip" placeholder="10950" /></label>
              <label>SOLA secure token <input name="xSut" placeholder="SUT from SOLA iFields" required /></label>
              <button className="btn primary" type="submit" disabled={!!busy}>{busy === "save-card" ? "Saving..." : "Save Tokenized Card"}</button>
            </form>
          ) : null}
        </DetailCard>
        {methods.status === "loading" ? <LoadingSkeleton rows={4} /> : null}
        {methods.status === "error" ? <ErrorState message={methods.error} /> : null}
        {methods.status === "success" && rows.length === 0 ? <EmptyState title="No payment methods" message="Add a SOLA card-on-file token to enable auto billing and invoice payments." /> : null}
        {methods.status === "success" && rows.length > 0 ? (
          <DetailCard title="Saved Cards">
            <div className="billing-line-list">
              {rows.map((method) => (
                <div key={method.id}>
                  <span>
                    {method.brand || "Card"} ending {method.last4 || "----"}
                    <small>{method.cardholderName || "No cardholder"} · exp {[method.expMonth, method.expYear].filter(Boolean).join("/") || "-"} · last used {method.lastUsedAt ? new Date(method.lastUsedAt).toLocaleString() : "never"}</small>
                  </span>
                  <strong>{method.isDefault ? "Default" : "Backup"}</strong>
                  <div className="row-actions">
                    {!method.isDefault ? <button className="btn ghost" type="button" onClick={() => apiPost(`/billing/payment-methods/${method.id}/default`, {}).then(() => window.location.reload())}>Make Default</button> : null}
                    <button className="btn danger" type="button" onClick={() => apiDelete(`/billing/payment-methods/${method.id}`).then(() => window.location.reload())}>Remove</button>
                  </div>
                </div>
              ))}
            </div>
          </DetailCard>
        ) : null}
      </div>
    </PermissionGate>
  );
}
