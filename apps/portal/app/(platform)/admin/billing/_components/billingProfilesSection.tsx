"use client";

/**
 * BillingProfilesSection — manage recurring sub-invoices (billing profiles) for a tenant.
 *
 * Designed for MSP/reseller tenants where each end-client gets its own invoice
 * charged to its own payment method (often imported from Sola).
 */

import { useState, useCallback, useRef, type ChangeEvent } from "react";
import { apiGet, apiPost, apiPut, apiDelete } from "../../../../../services/apiClient";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
import { dollars, invoiceStatusLabel } from "../../../../../lib/billingUi";
import { LINE_ITEM_TYPE_LABELS, type EditableLineItem, type LineItemType } from "./invoiceEditor";
import "./invoiceEditorStyles.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PaymentMethodSummary = {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: string | null;
  expYear: string | null;
  isImported: boolean;
  isDefault: boolean;
  active: boolean;
};

type ProfileLineItem = {
  type: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
};

type BillingProfile = {
  id: string;
  tenantId: string;
  label: string;
  paymentMethodId: string | null;
  autoBillingEnabled: boolean;
  billingEmail: string | null;
  notes: string | null;
  lineItemsJson: ProfileLineItem[] | null;
  createdAt: string;
  updatedAt: string;
  paymentMethod: PaymentMethodSummary | null;
  lastInvoice: {
    id: string;
    invoiceNumber: string;
    status: string;
    totalCents: number;
    periodStart: string;
    periodEnd: string;
    createdAt: string;
  } | null;
};

type PreviewLineItem = {
  type: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  taxable: boolean;
};

export type BillingProfilesTenant = {
  id: string;
  name: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _keyCounter = 0;
function nextKey() { return `bp-li-${++_keyCounter}-${Date.now()}`; }

function fmt(cents: number): string {
  return dollars(cents);
}

function firstOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function lastOfMonth(): string {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return last.toISOString().slice(0, 10);
}

function cardLabel(pm: PaymentMethodSummary | null): string {
  if (!pm) return "No card";
  const brand = pm.brand || "Card";
  const l4 = pm.last4 ? ` ···· ${pm.last4}` : "";
  return `${brand}${l4}`;
}

function invStatusPillClass(status: string): string {
  if (status === "PAID") return "good";
  if (status === "FAILED" || status === "OVERDUE") return "bad";
  if (status === "VOID") return "";
  return "warn";
}

const TAX_TYPES: string[] = ["SALES_TAX", "E911_FEE", "REGULATORY_FEE"];

function calcTotals(items: EditableLineItem[]) {
  let sub = 0; let tax = 0;
  for (const item of items) {
    const amt = Math.round(item.quantity * item.unitPriceCents);
    if (TAX_TYPES.includes(item.type)) tax += amt; else sub += amt;
  }
  return { subtotal: sub, tax, total: sub + tax };
}

function editableToProfile(li: EditableLineItem): ProfileLineItem {
  return { type: li.type, description: li.description, quantity: li.quantity, unitPriceCents: li.unitPriceCents };
}

function profileToEditable(li: ProfileLineItem): EditableLineItem {
  return { _key: nextKey(), type: (li.type || "CUSTOM") as LineItemType, description: li.description, quantity: li.quantity, unitPriceCents: li.unitPriceCents, taxable: true };
}

function previewToEditable(li: PreviewLineItem): EditableLineItem {
  const knownTypes = Object.keys(LINE_ITEM_TYPE_LABELS) as LineItemType[];
  const type = knownTypes.includes(li.type as LineItemType) ? (li.type as LineItemType) : "CUSTOM";
  return { _key: nextKey(), type, description: li.description, quantity: li.quantity, unitPriceCents: li.unitPriceCents, taxable: li.taxable };
}

function newLineItem(): EditableLineItem {
  return { _key: nextKey(), type: "CUSTOM", description: "", quantity: 1, unitPriceCents: 0, taxable: true };
}

// ---------------------------------------------------------------------------
// Profile Drawer (create / edit)
// ---------------------------------------------------------------------------

function ProfileDrawer({
  tenant,
  profile,
  onClose,
  onSaved,
}: {
  tenant: BillingProfilesTenant;
  profile?: BillingProfile | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!profile;
  const [label, setLabel] = useState(profile?.label ?? "");
  const [paymentMethodId, setPaymentMethodId] = useState(profile?.paymentMethodId ?? "");
  const [autoBilling, setAutoBilling] = useState(profile?.autoBillingEnabled ?? false);
  const [billingEmail, setBillingEmail] = useState(profile?.billingEmail ?? "");
  const [notes, setNotes] = useState(profile?.notes ?? "");
  const [lineItems, setLineItems] = useState<EditableLineItem[]>(
    profile?.lineItemsJson?.length ? profile.lineItemsJson.map(profileToEditable) : [newLineItem()]
  );
  const [submitting, setSubmitting] = useState(false);
  const [loadingBill, setLoadingBill] = useState(false);
  const [periodStart, setPeriodStart] = useState(firstOfMonth());
  const [periodEnd, setPeriodEnd] = useState(lastOfMonth());
  const [error, setError] = useState<string | null>(null);
  const lastLoadedRef = useRef<string | null>(null);

  const pmData = useAsyncResource<{ methods: PaymentMethodSummary[] }>(
    () => apiGet(`/admin/billing/platform/tenants/${tenant.id}/payment-methods`),
    [tenant.id],
  );
  const paymentMethods = pmData.status === "success" ? pmData.data.methods : [];

  const addItem = useCallback(() => setLineItems((p) => [...p, newLineItem()]), []);

  const loadStandardBill = useCallback(async () => {
    if (!periodStart || !periodEnd) return;
    setLoadingBill(true);
    setError(null);
    try {
      const res = await apiGet<{ lineItems: PreviewLineItem[] }>(
        `/admin/billing/platform/tenants/${tenant.id}/invoice-preview?serviceStartDate=${periodStart}&serviceEndDate=${periodEnd}`
      );
      if (res.lineItems?.length) {
        setLineItems(res.lineItems.map(previewToEditable));
        lastLoadedRef.current = `${periodStart}:${periodEnd}`;
      } else {
        setError("No standard line items found for this period.");
      }
    } catch {
      setError("Failed to load standard bill.");
    } finally {
      setLoadingBill(false);
    }
  }, [tenant.id, periodStart, periodEnd]);

  const updateItem = useCallback((key: string, field: keyof EditableLineItem, value: unknown) => {
    setLineItems((p) => p.map((li) => li._key === key ? { ...li, [field]: value } : li));
  }, []);

  const removeItem = useCallback((key: string) => {
    setLineItems((p) => p.filter((li) => li._key !== key));
  }, []);

  const totals = calcTotals(lineItems);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim()) { setError("Client name is required."); return; }
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        label: label.trim(),
        paymentMethodId: paymentMethodId || null,
        autoBillingEnabled: autoBilling,
        billingEmail: billingEmail.trim() || null,
        notes: notes.trim() || null,
        lineItemsJson: lineItems.filter(li => li.description.trim()).map(editableToProfile),
      };
      if (isEdit && profile) {
        await apiPut(`/admin/billing/platform/tenants/${tenant.id}/billing-profiles/${profile.id}`, body);
      } else {
        await apiPost(`/admin/billing/platform/tenants/${tenant.id}/billing-profiles`, body);
      }
      onSaved();
    } catch (err: any) {
      setError(err?.body?.message || err?.body?.error || err?.message || "Save failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="manual-inv-drawer__overlay inv-editor"
      onClick={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}
    >
      <div className="manual-inv-drawer__panel">
        <div className="manual-inv-drawer__header">
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ie-text-muted)", marginBottom: 2 }}>
              {tenant.name}
            </div>
            <h3 className="manual-inv-drawer__title">
              {isEdit ? "Edit Billing Profile" : "Add Billing Profile"}
            </h3>
          </div>
          <button className="manual-inv-drawer__close" type="button" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <form className="manual-inv-drawer__body" onSubmit={(e) => void handleSubmit(e)}>
          {error && (
            <div style={{ background: "var(--ie-bg-danger)", border: "1px solid #fca5a5", borderRadius: 6, padding: "10px 14px", fontSize: 13, color: "var(--ie-text-danger)" }}>
              {error}
            </div>
          )}

          {/* Client label */}
          <div className="inv-editor__section">
            <div className="inv-editor__section-head">
              <h4 className="inv-editor__section-title">Profile details</h4>
            </div>
            <div className="inv-editor__section-body">
              <div className="inv-editor__meta-grid">
                <div className="inv-editor__field" style={{ gridColumn: "1 / -1" }}>
                  <label className="inv-editor__label">Client / Sub-account name</label>
                  <input
                    className="inv-editor__input"
                    type="text"
                    value={label}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
                    placeholder="e.g. Bookkeeping Co, Law Firm Client"
                    required
                  />
                </div>

                <div className="inv-editor__field" style={{ gridColumn: "1 / -1" }}>
                  <label className="inv-editor__label">Payment method</label>
                  <select
                    className="inv-editor__input"
                    value={paymentMethodId}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => setPaymentMethodId(e.target.value)}
                  >
                    <option value="">— None (manual charge only) —</option>
                    {paymentMethods.map((pm) => (
                      <option key={pm.id} value={pm.id}>
                        {cardLabel(pm)}{pm.isImported ? " (imported)" : ""}{pm.isDefault ? " ★ default" : ""}
                      </option>
                    ))}
                  </select>
                  {pmData.status === "success" && paymentMethods.length === 0 && (
                    <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ie-text-muted)" }}>
                      No payment methods found. Import cards from Sola first.
                    </p>
                  )}
                </div>

                <div className="inv-editor__field">
                  <label className="inv-editor__label">Billing email <span style={{ fontWeight: 400 }}>(optional)</span></label>
                  <input
                    className="inv-editor__input"
                    type="email"
                    value={billingEmail}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setBillingEmail(e.target.value)}
                    placeholder="client@example.com"
                  />
                </div>

                <div className="inv-editor__field">
                  <label className="inv-editor__label" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={autoBilling}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setAutoBilling(e.target.checked)}
                      style={{ width: 16, height: 16, cursor: "pointer" }}
                    />
                    Enable autopay for this profile
                  </label>
                  <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ie-text-muted)" }}>
                    When on, this profile is charged automatically each billing cycle.
                  </p>
                </div>

                <div className="inv-editor__field" style={{ gridColumn: "1 / -1" }}>
                  <label className="inv-editor__label">Notes <span style={{ fontWeight: 400 }}>(optional)</span></label>
                  <textarea
                    className="inv-editor__input inv-editor__textarea"
                    value={notes}
                    onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
                    placeholder="Internal notes about this client"
                    rows={2}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Line items */}
          <div className="inv-editor__section">
            <div className="inv-editor__section-head">
              <h4 className="inv-editor__section-title">Recurring line items</h4>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  className="inv-editor__input"
                  type="date"
                  value={periodStart}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => { setPeriodStart(e.target.value); lastLoadedRef.current = null; }}
                  style={{ width: 130, padding: "4px 8px", fontSize: 12 }}
                  title="Period start for standard bill"
                />
                <span style={{ fontSize: 11, color: "var(--ie-text-muted)" }}>→</span>
                <input
                  className="inv-editor__input"
                  type="date"
                  value={periodEnd}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => { setPeriodEnd(e.target.value); lastLoadedRef.current = null; }}
                  style={{ width: 130, padding: "4px 8px", fontSize: 12 }}
                  title="Period end for standard bill"
                />
                <button
                  type="button"
                  className="btn ghost"
                  style={{ fontSize: 12, padding: "4px 12px", whiteSpace: "nowrap" }}
                  disabled={loadingBill || !periodStart || !periodEnd}
                  onClick={() => void loadStandardBill()}
                  title="Load line items from this tenant's pricing profile"
                >
                  {loadingBill ? "Loading…" : "⚡ Standard bill"}
                </button>
              </div>
            </div>
            <div className="inv-editor__section-body" style={{ padding: 0 }}>
              <table className="inv-editor__li-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Description</th>
                    <th style={{ textAlign: "right", width: 56 }}>Qty</th>
                    <th style={{ textAlign: "right", width: 100 }}>Unit price</th>
                    <th style={{ textAlign: "right", width: 90 }}>Amount</th>
                    <th style={{ width: 32 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((li) => (
                    <tr key={li._key}>
                      <td>
                        <select
                          className="inv-editor__input"
                          style={{ fontSize: 12 }}
                          value={li.type}
                          onChange={(e: ChangeEvent<HTMLSelectElement>) => updateItem(li._key, "type", e.target.value)}
                        >
                          {Object.entries(LINE_ITEM_TYPE_LABELS).map(([k, v]) => (
                            <option key={k} value={k}>{v}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className="inv-editor__input"
                          type="text"
                          value={li.description}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => updateItem(li._key, "description", e.target.value)}
                          placeholder="Description"
                          style={{ fontSize: 12 }}
                        />
                      </td>
                      <td>
                        <input
                          className="inv-editor__input"
                          type="number"
                          min={1}
                          style={{ width: 50, textAlign: "right", fontSize: 12 }}
                          value={li.quantity}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => updateItem(li._key, "quantity", Math.max(1, parseInt(e.target.value, 10) || 1))}
                        />
                      </td>
                      <td>
                        <input
                          className="inv-editor__input"
                          type="number"
                          min={0}
                          step={0.01}
                          style={{ width: 90, textAlign: "right", fontSize: 12 }}
                          value={(li.unitPriceCents / 100).toFixed(2)}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => updateItem(li._key, "unitPriceCents", Math.round((parseFloat(e.target.value) || 0) * 100))}
                        />
                      </td>
                      <td style={{ textAlign: "right", fontSize: 13 }}>
                        {fmt(li.quantity * li.unitPriceCents)}
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={() => removeItem(li._key)}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ie-text-muted)", fontSize: 16, padding: "0 4px", lineHeight: 1 }}
                          title="Remove"
                        >×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ padding: "10px 20px", borderTop: "1px solid var(--ie-border)" }}>
                <button type="button" className="btn ghost" style={{ fontSize: 13 }} onClick={addItem}>
                  + Add line item
                </button>
              </div>
            </div>

            {/* Totals */}
            <div style={{ padding: "12px 20px 16px", borderTop: "1px solid var(--ie-border)", display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
              <div style={{ display: "flex", gap: 48, fontSize: 13, color: "var(--ie-text-muted)" }}>
                <span>Subtotal</span><span>{fmt(totals.subtotal)}</span>
              </div>
              {totals.tax > 0 && (
                <div style={{ display: "flex", gap: 48, fontSize: 13, color: "var(--ie-text-muted)" }}>
                  <span>Tax / fees</span><span>{fmt(totals.tax)}</span>
                </div>
              )}
              <div style={{ display: "flex", gap: 48, fontSize: 15, fontWeight: 700 }}>
                <span>Monthly total</span><span>{fmt(totals.total)}</span>
              </div>
            </div>
          </div>

          <div className="manual-inv-drawer__footer">
            <button type="button" className="btn ghost" disabled={submitting} onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={submitting}>
              {submitting ? "Saving…" : isEdit ? "Save changes" : "Create profile"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Charge Now Dialog
// ---------------------------------------------------------------------------

function ChargeNowDialog({
  profile,
  tenantId,
  onClose,
  onCharged,
}: {
  profile: BillingProfile;
  tenantId: string;
  onClose: () => void;
  onCharged: () => void;
}) {
  const [periodStart, setPeriodStart] = useState(firstOfMonth());
  const [periodEnd, setPeriodEnd] = useState(lastOfMonth());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

  const lineItems: ProfileLineItem[] = Array.isArray(profile.lineItemsJson) ? profile.lineItemsJson : [];
  const total = lineItems.reduce((s, li) => s + li.quantity * li.unitPriceCents, 0);

  async function submit() {
    setBusy(true);
    setResult(null);
    try {
      await apiPost(`/admin/billing/platform/tenants/${tenantId}/billing-profiles/${profile.id}/charge-now`, { periodStart, periodEnd });
      setResult({ type: "ok", msg: "Invoice created and card charged successfully." });
      setTimeout(onCharged, 1400);
    } catch (err: any) {
      const msg = err?.body?.message || err?.body?.error || err?.message || "Charge failed.";
      setResult({ type: "err", msg: String(msg) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="manual-inv-drawer__overlay inv-editor"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="manual-inv-drawer__panel" style={{ maxWidth: 420 }}>
        <div className="manual-inv-drawer__header">
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ie-text-muted)", marginBottom: 2 }}>
              {profile.label}
            </div>
            <h3 className="manual-inv-drawer__title">Charge now</h3>
          </div>
          <button className="manual-inv-drawer__close" type="button" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        </div>

        <div className="manual-inv-drawer__body">
          {result ? (
            <div style={{
              padding: "14px 16px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
              background: result.type === "ok" ? "var(--ie-bg-success)" : "var(--ie-bg-danger)",
              color: result.type === "ok" ? "var(--ie-text-success)" : "var(--ie-text-danger)",
              border: `1px solid ${result.type === "ok" ? "#86efac" : "#fca5a5"}`,
            }}>
              {result.msg}
            </div>
          ) : (
            <>
              <p style={{ margin: 0, fontSize: 14, color: "var(--ie-text-muted)", lineHeight: 1.5 }}>
                Create an invoice for <strong style={{ color: "var(--ie-text)" }}>{profile.label}</strong> and charge{" "}
                <strong style={{ color: "var(--ie-text)" }}>{cardLabel(profile.paymentMethod)}</strong> immediately.
              </p>

              <div className="inv-editor__section">
                <div className="inv-editor__section-head">
                  <h4 className="inv-editor__section-title">Service period</h4>
                </div>
                <div className="inv-editor__section-body">
                  <div className="inv-editor__meta-grid">
                    <div className="inv-editor__field">
                      <label className="inv-editor__label">Start</label>
                      <input className="inv-editor__input" type="date" value={periodStart} onChange={(e: ChangeEvent<HTMLInputElement>) => setPeriodStart(e.target.value)} />
                    </div>
                    <div className="inv-editor__field">
                      <label className="inv-editor__label">End</label>
                      <input className="inv-editor__input" type="date" value={periodEnd} onChange={(e: ChangeEvent<HTMLInputElement>) => setPeriodEnd(e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ background: "var(--ie-bg-subtle)", borderRadius: 8, padding: "12px 16px", border: "1px solid var(--ie-border)" }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ie-text-muted)", marginBottom: 6 }}>Invoice total</div>
                <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>{fmt(total)}</div>
                <div style={{ fontSize: 12, color: "var(--ie-text-muted)", marginTop: 2 }}>
                  {lineItems.length} line item{lineItems.length !== 1 ? "s" : ""}
                  {profile.paymentMethod ? ` · ${cardLabel(profile.paymentMethod)}` : ""}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="manual-inv-drawer__footer">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
            {result?.type === "ok" ? "Close" : "Cancel"}
          </button>
          {!result && (
            <button type="button" className="btn primary" disabled={busy || !periodStart || !periodEnd} onClick={() => void submit()}>
              {busy ? "Charging…" : "Charge now"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main section component
// ---------------------------------------------------------------------------

export function BillingProfilesSection({ tenant }: { tenant: BillingProfilesTenant }) {
  const [showDrawer, setShowDrawer] = useState<"add" | BillingProfile | null>(null);
  const [chargeTarget, setChargeTarget] = useState<BillingProfile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BillingProfile | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const data = useAsyncResource<BillingProfile[]>(
    () => apiGet(`/admin/billing/platform/tenants/${tenant.id}/billing-profiles`),
    [tenant.id, reloadTick],
  );

  function reload() {
    setShowDrawer(null);
    setChargeTarget(null);
    setReloadTick((n) => n + 1);
  }

  async function handleDelete(profile: BillingProfile) {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await apiDelete(`/admin/billing/platform/tenants/${tenant.id}/billing-profiles/${profile.id}`);
      setDeleteTarget(null);
      setReloadTick((n) => n + 1);
    } catch (err: any) {
      setDeleteError(err?.body?.message || err?.body?.error || err?.message || "Delete failed.");
    } finally {
      setDeleteBusy(false);
    }
  }

  const profiles = data.status === "success" ? data.data : [];

  return (
    <div className="billing-flat-rate-card billing-p8-scope" style={{ marginTop: 16 }}>
      {/* Header */}
      <div className="billing-flat-rate-card__head">
        <div>
          <h3>Billing Profiles</h3>
          <p>Sub-invoices for individual clients within this tenant. Each profile has its own payment method and recurring line items.</p>
        </div>
        <button className="btn primary billing-pricing-page__action" type="button" onClick={() => setShowDrawer("add")}>
          + Add profile
        </button>
      </div>

      {/* Loading */}
      {data.status === "loading" && (
        <p style={{ margin: 0, fontSize: 13, color: "var(--billing-muted, var(--text-dim))" }}>Loading profiles…</p>
      )}

      {/* Error */}
      {data.status === "error" && (
        <p style={{ margin: 0, fontSize: 13, color: "var(--billing-danger, #dc2626)" }}>Failed to load billing profiles.</p>
      )}

      {/* Empty state */}
      {data.status === "success" && profiles.length === 0 && (
        <div style={{
          padding: "28px 0",
          textAlign: "center",
          border: "1.5px dashed var(--billing-border, var(--border))",
          borderRadius: 10,
          color: "var(--billing-muted, var(--text-dim))",
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>No billing profiles yet</div>
          <div style={{ fontSize: 12 }}>Click <strong>+ Add profile</strong> to set up sub-invoices for your clients.</div>
          <div style={{ fontSize: 11, marginTop: 6, opacity: 0.65 }}>
            Tip: assign imported Sola cards to profiles so each client is charged automatically.
          </div>
        </div>
      )}

      {/* Profile table */}
      {data.status === "success" && profiles.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 4 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1.5px solid var(--billing-border, var(--border))", color: "var(--billing-muted, var(--text-dim))", textAlign: "left" }}>
                <th style={{ padding: "7px 10px", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>Client</th>
                <th style={{ padding: "7px 10px", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>Payment method</th>
                <th style={{ padding: "7px 10px", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", textAlign: "center" }}>Autopay</th>
                <th style={{ padding: "7px 10px", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", textAlign: "right" }}>Monthly</th>
                <th style={{ padding: "7px 10px", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>Last invoice</th>
                <th style={{ padding: "7px 10px", width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((profile) => {
                const lineItems: ProfileLineItem[] = Array.isArray(profile.lineItemsJson) ? profile.lineItemsJson : [];
                const total = lineItems.reduce((s, li) => s + li.quantity * li.unitPriceCents, 0);
                return (
                  <tr key={profile.id} style={{ borderBottom: "1px solid color-mix(in srgb, var(--billing-border, var(--border)) 60%, transparent)" }}>
                    <td style={{ padding: "9px 10px", fontWeight: 600 }}>{profile.label}</td>
                    <td style={{ padding: "9px 10px", color: "var(--billing-muted, var(--text-dim))", fontSize: 13 }}>
                      {profile.paymentMethod ? (
                        <>
                          {cardLabel(profile.paymentMethod)}
                          {profile.paymentMethod.isImported && (
                            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, background: "color-mix(in srgb, var(--accent) 12%, transparent)", color: "var(--accent)", borderRadius: 4, padding: "1px 5px", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                              imported
                            </span>
                          )}
                        </>
                      ) : (
                        <span style={{ color: "var(--billing-muted, var(--text-dim))", fontStyle: "italic" }}>None</span>
                      )}
                    </td>
                    <td style={{ padding: "9px 10px", textAlign: "center" }}>
                      <span style={{ fontWeight: 600, fontSize: 12, color: profile.autoBillingEnabled ? "var(--billing-good, #16a34a)" : "var(--billing-muted, var(--text-dim))" }}>
                        {profile.autoBillingEnabled ? "On" : "Off"}
                      </span>
                    </td>
                    <td style={{ padding: "9px 10px", textAlign: "right", fontWeight: 600 }}>
                      {total > 0 ? fmt(total) : <span style={{ color: "var(--billing-muted, var(--text-dim))" }}>—</span>}
                    </td>
                    <td style={{ padding: "9px 10px" }}>
                      {profile.lastInvoice ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <span className={`billing-status-pill ${invStatusPillClass(profile.lastInvoice.status)}`} style={{ fontSize: 11 }}>
                            {invoiceStatusLabel(profile.lastInvoice.status)}
                          </span>
                          <span style={{ color: "var(--billing-muted, var(--text-dim))", fontSize: 12 }}>
                            {profile.lastInvoice.invoiceNumber}
                          </span>
                        </span>
                      ) : (
                        <span style={{ color: "var(--billing-muted, var(--text-dim))", fontSize: 12, fontStyle: "italic" }}>None yet</span>
                      )}
                    </td>
                    <td style={{ padding: "9px 10px" }}>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <button className="btn ghost" type="button" style={{ fontSize: 12, padding: "3px 10px" }} onClick={() => setChargeTarget(profile)}>
                          Charge
                        </button>
                        <button className="btn ghost" type="button" style={{ fontSize: 12, padding: "3px 10px" }} onClick={() => setShowDrawer(profile)}>
                          Edit
                        </button>
                        <button
                          className="btn ghost"
                          type="button"
                          style={{ fontSize: 12, padding: "3px 10px", color: "var(--billing-danger, #dc2626)" }}
                          onClick={() => { setDeleteTarget(profile); setDeleteError(null); }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div
          className="manual-inv-drawer__overlay inv-editor"
          onClick={(e) => { if (e.target === e.currentTarget && !deleteBusy) setDeleteTarget(null); }}
        >
          <div className="manual-inv-drawer__panel" style={{ maxWidth: 400 }}>
            <div className="manual-inv-drawer__header">
              <h3 className="manual-inv-drawer__title">Delete profile?</h3>
              <button className="manual-inv-drawer__close" type="button" onClick={() => setDeleteTarget(null)} disabled={deleteBusy} aria-label="Close">✕</button>
            </div>
            <div className="manual-inv-drawer__body">
              <p style={{ margin: 0, fontSize: 14, color: "var(--ie-text-muted)" }}>
                Delete billing profile <strong style={{ color: "var(--ie-text)" }}>{deleteTarget.label}</strong>? This cannot be undone. Existing paid invoices are kept.
              </p>
              {deleteError && (
                <div style={{ fontSize: 13, color: "var(--ie-text-danger)", padding: "8px 12px", background: "var(--ie-bg-danger)", borderRadius: 6, border: "1px solid #fca5a5" }}>
                  {deleteError}
                </div>
              )}
            </div>
            <div className="manual-inv-drawer__footer">
              <button className="btn ghost" type="button" disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button
                className="btn primary"
                type="button"
                disabled={deleteBusy}
                style={{ background: "var(--billing-danger, #dc2626)", borderColor: "var(--billing-danger, #dc2626)" }}
                onClick={() => void handleDelete(deleteTarget)}
              >
                {deleteBusy ? "Deleting…" : "Delete profile"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Profile drawer */}
      {showDrawer !== null && (
        <ProfileDrawer
          tenant={tenant}
          profile={showDrawer === "add" ? null : showDrawer}
          onClose={() => setShowDrawer(null)}
          onSaved={reload}
        />
      )}

      {/* Charge-now dialog */}
      {chargeTarget && (
        <ChargeNowDialog
          profile={chargeTarget}
          tenantId={tenant.id}
          onClose={() => setChargeTarget(null)}
          onCharged={() => { setChargeTarget(null); setReloadTick((n) => n + 1); }}
        />
      )}
    </div>
  );
}
