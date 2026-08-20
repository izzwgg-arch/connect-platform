"use client";

import "./paymentMethods.css";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiDelete, apiGet, apiPost } from "../../../../services/apiClient";
import { DetailCard } from "../../../../components/DetailCard";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { BillingPageChrome, billingErrorMessage } from "../../../../components/BillingActionToast";

/* Card ENTRY does not happen on this page. Adding a card goes through
   /billing/payments/add-card — the same Sola-branded payment surface used by
   every pay page on the platform (CardknoxIFieldsForm + PaymentTrustBadge).
   This page only lists saved cards and manages default/remove. Never bring a
   second hand-rolled card form back here. */

export default function BillingPaymentsPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [solaConfig, setSolaConfig] = useState<{ enabled?: boolean; ifieldsKey?: string | null } | null>(null);

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
      .then((config) => { if (active) setSolaConfig(config); })
      .catch(() => { if (active) setSolaConfig(null); });
    return () => { active = false; };
  }, []);

  const cardEntryUnavailable = solaConfig != null && !(solaConfig.enabled && solaConfig.ifieldsKey);

  return (
    <PermissionGate permission="can_view_billing_payments" fallback={<div className="state-box">You do not have payment access.</div>}>
      <BillingPageChrome toast={toast}>
        <div className="stack compact-stack billing-admin-shell billing-payments-page">
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

          {/* Add a card — happens on the platform's standard secure payment page */}
          <DetailCard title="Add a card">
            <p className="muted" style={{ marginBottom: 12 }}>
              Cards are added on our secure payment page — the same one used for invoice payments. Card details never touch ConnectComms servers.
            </p>
            {cardEntryUnavailable ? (
              <div className="billing-status-pill warn">
                Online card entry is not yet configured for this account. Contact support to add a card.
              </div>
            ) : (
              <Link className="btn primary" href="/billing/payments/add-card">Add a card</Link>
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
