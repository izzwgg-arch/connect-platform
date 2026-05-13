"use client";

import { useEffect, useRef, useState } from "react";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiDelete, apiGet, apiPost } from "../../../../services/apiClient";
import { DetailCard } from "../../../../components/DetailCard";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { BillingPageChrome, billingErrorMessage } from "../../../../components/BillingActionToast";

declare global {
  interface Window {
    setAccount?: (key: string, softwareName: string, softwareVersion: string) => void;
    getTokens?: (success: () => void, failure: () => void, timeoutMs: number) => void;
  }
}

export default function BillingPaymentsPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState("");
  const [cardMessage, setCardMessage] = useState("");
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [solaPublicConfig, setSolaPublicConfig] = useState<any>(null);
  const [ifieldsReady, setIfieldsReady] = useState(false);
  const submittedRef = useRef(false);

  const methods = useAsyncResource(() => apiGet<any[]>("/billing/payment-methods"), [refreshKey]);
  const rows = methods.status === "success" ? methods.data : [];

  function showToast(kind: "ok" | "err", text: string) {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3200);
  }

  function refresh() {
    setRefreshKey((k) => k + 1);
  }

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
    if (existing) { configure(); return; }
    const script = document.createElement("script");
    script.id = scriptId;
    script.src = `https://cdn.cardknox.com/ifields/${version}/ifields.min.js`;
    script.async = true;
    script.onload = configure;
    script.onerror = () => setCardMessage("Unable to load the secure card form. Please contact support.");
    document.body.appendChild(script);
  }, [solaPublicConfig]);

  const ifieldsVersion = solaPublicConfig?.ifieldsVersion || "3.4.2602.2001";

  return (
    <PermissionGate permission="can_view_billing_payments" fallback={<div className="state-box">You do not have payment access.</div>}>
      <BillingPageChrome toast={toast}>
        <div className="stack compact-stack billing-admin-shell">
          <PageHeader title="Payment Methods" subtitle="Saved payment cards. Raw card numbers are never stored — only PCI-compliant tokens." />

          {/* Saved cards summary */}
          <section className="billing-tenant-hero">
            <div>
              <span className="eyebrow">Cards on file</span>
              <h2>{rows.length ? "Payment method ready" : "No card on file"}</h2>
              <p className="muted">
                Card details are tokenized by a PCI-compliant payment processor and never stored directly in ConnectComms.
              </p>
            </div>
            <div className="billing-hero-metrics">
              <span><strong>{String(rows.length)}</strong><small>Saved cards</small></span>
              <span><strong>{rows.some((m) => m.isDefault) ? "Yes" : "No"}</strong><small>Default card</small></span>
            </div>
          </section>

          {/* Add a card */}
          <DetailCard title="Add a card">
            <p className="muted" style={{ marginBottom: 12 }}>
              Your card details are entered directly into a secure hosted form and never touch ConnectComms servers.
            </p>
            {!solaPublicConfig?.enabled || !solaPublicConfig?.ifieldsKey ? (
              <div className="billing-status-pill warn">
                Online card entry is not yet configured for this account. Contact support to add a card.
              </div>
            ) : (
              <form
                className="billing-form"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (submittedRef.current) return;
                  const form = event.currentTarget;
                  setBusy("ifields");
                  setCardMessage("");
                  if (!window.getTokens) {
                    setBusy("");
                    setCardMessage("The secure card form is not ready yet. Please wait a moment and try again.");
                    return;
                  }
                  window.getTokens(async () => {
                    submittedRef.current = true;
                    const formData = new FormData(form);
                    const xSut = String(formData.get("xCardNum") || "");
                    if (!xSut) {
                      setBusy("");
                      submittedRef.current = false;
                      setCardMessage("The secure form did not return a card token. Verify the card number and try again.");
                      return;
                    }
                    try {
                      await apiPost("/billing/payment-methods/sola/save", {
                        xSut,
                        cardholderName: String(formData.get("cardholderName") || ""),
                        billingZip: String(formData.get("billingZip") || ""),
                        makeDefault: rows.length === 0,
                      });
                      showToast("ok", "Card saved successfully.");
                      refresh();
                    } catch (err: any) {
                      setCardMessage(billingErrorMessage(err, "Unable to save this card."));
                    } finally {
                      setBusy("");
                      submittedRef.current = false;
                    }
                  }, () => {
                    setBusy("");
                    setCardMessage("The secure form could not tokenize the card. Verify the card details and try again.");
                  }, 30000);
                }}
              >
                <label>Cardholder name <input name="cardholderName" autoComplete="cc-name" placeholder="Jane Smith" /></label>
                <label>Billing ZIP <input name="billingZip" autoComplete="postal-code" placeholder="10950" /></label>
                <label>
                  Card number
                  <iframe
                    className="sola-ifield-frame"
                    title="Secure card number"
                    data-ifields-id="card-number"
                    data-ifields-placeholder="Card Number"
                    src={`https://cdn.cardknox.com/ifields/${ifieldsVersion}/ifield.htm`}
                  />
                </label>
                <label>
                  CVV
                  <iframe
                    className="sola-ifield-frame"
                    title="Secure CVV"
                    data-ifields-id="cvv"
                    data-ifields-placeholder="CVV"
                    src={`https://cdn.cardknox.com/ifields/${ifieldsVersion}/ifield.htm`}
                  />
                </label>
                <input name="xCardNum" data-ifields-id="card-number-token" type="hidden" />
                <input name="xCVV" data-ifields-id="cvv-token" type="hidden" />
                {cardMessage ? <div className="billing-status-pill bad">{cardMessage}</div> : null}
                <button
                  className="btn primary"
                  type="submit"
                  disabled={busy === "ifields" || !ifieldsReady}
                >
                  {busy === "ifields" ? "Securing…" : ifieldsReady ? "Save card" : "Loading secure form…"}
                </button>
              </form>
            )}
          </DetailCard>

          {/* Saved cards list */}
          {methods.status === "loading" ? <LoadingSkeleton rows={4} /> : null}
          {methods.status === "error" ? <ErrorState message={methods.error} /> : null}
          {methods.status === "success" && rows.length === 0 ? (
            <EmptyState title="No payment methods" message="Add a card above to enable autopay and invoice payments." />
          ) : null}
          {methods.status === "success" && rows.length > 0 ? (
            <DetailCard title="Saved cards">
              <div className="billing-line-list">
                {rows.map((method) => (
                  <div key={method.id}>
                    <span>
                      {method.brand || "Card"} ending in {method.last4 || "••••"}
                      <small>
                        {method.cardholderName || ""}
                        {method.expMonth && method.expYear ? ` · exp ${method.expMonth}/${method.expYear}` : ""}
                        {method.lastUsedAt ? ` · last used ${new Date(method.lastUsedAt).toLocaleDateString()}` : ""}
                      </small>
                    </span>
                    <strong>{method.isDefault ? "Default" : "Backup"}</strong>
                    <div className="row-actions">
                      {!method.isDefault ? (
                        <button
                          className="btn ghost"
                          type="button"
                          disabled={!!busy}
                          onClick={async () => {
                            setBusy(`default-${method.id}`);
                            try {
                              await apiPost(`/billing/payment-methods/${method.id}/default`, {});
                              showToast("ok", "Default card updated.");
                              refresh();
                            } catch (err) {
                              showToast("err", billingErrorMessage(err, "Could not set default."));
                            } finally {
                              setBusy("");
                            }
                          }}
                        >
                          {busy === `default-${method.id}` ? "Saving…" : "Make default"}
                        </button>
                      ) : null}
                      {confirmRemoveId === method.id ? (
                        <>
                          <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>Remove this card?</span>
                          <button
                            className="btn danger"
                            type="button"
                            disabled={!!busy}
                            onClick={async () => {
                              setBusy(`remove-${method.id}`);
                              try {
                                await apiDelete(`/billing/payment-methods/${method.id}`);
                                showToast("ok", "Card removed.");
                                setConfirmRemoveId(null);
                                refresh();
                              } catch (err) {
                                showToast("err", billingErrorMessage(err, "Could not remove card."));
                              } finally {
                                setBusy("");
                              }
                            }}
                          >
                            {busy === `remove-${method.id}` ? "Removing…" : "Confirm remove"}
                          </button>
                          <button className="btn ghost" type="button" onClick={() => setConfirmRemoveId(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn ghost"
                          type="button"
                          onClick={() => setConfirmRemoveId(method.id)}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </DetailCard>
          ) : null}
        </div>
      </BillingPageChrome>
    </PermissionGate>
  );
}
