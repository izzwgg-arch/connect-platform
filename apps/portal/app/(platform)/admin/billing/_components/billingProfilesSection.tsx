"use client";

/**
 * BillingProfilesSection — manage recurring sub-invoices (billing profiles) for a tenant.
 *
 * Designed for MSP/reseller tenants where each end-client gets its own invoice
 * charged to its own payment method (often imported from Sola).
 *
 * Each profile stores a label, an assigned card, autopay toggle, billing email,
 * and a set of recurring line items. The worker generates + charges a separate
 * invoice per profile on the same monthly billing schedule as the main tenant.
 */

import { useState, useCallback, useRef, type ChangeEvent } from "react";
import { apiGet, apiPost, apiPut, apiDelete } from "../../../../../services/apiClient";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
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
function nextKey() {
  return `bp-li-${++_keyCounter}-${Date.now()}`;
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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
  if (!pm) return "No card assigned";
  const brand = pm.brand || "Card";
  const l4 = pm.last4 ? ` •••• ${pm.last4}` : "";
  const imported = pm.isImported ? " (imported)" : "";
  return `${brand}${l4}${imported}`;
}

function statusBadge(status: string) {
  const cls: Record<string, string> = {
    PAID: "billing-chip--green",
    OPEN: "billing-chip--blue",
    OVERDUE: "billing-chip--orange",
    FAILED: "billing-chip--red",
    VOID: "billing-chip--gray",
    DRAFT: "billing-chip--gray",
  };
  return (
    <span className={`billing-chip ${cls[status.toUpperCase()] ?? "billing-chip--gray"}`}>
      {status}
    </span>
  );
}

const TAX_TYPES: string[] = ["SALES_TAX", "E911_FEE", "REGULATORY_FEE"];

function calcTotals(items: EditableLineItem[]): { subtotal: number; tax: number; total: number } {
  let sub = 0;
  let tax = 0;
  for (const item of items) {
    const amt = Math.round(item.quantity * item.unitPriceCents);
    if (TAX_TYPES.includes(item.type)) {
      tax += amt;
    } else {
      sub += amt;
    }
  }
  return { subtotal: sub, tax, total: sub + tax };
}

function editableToProfileLineItem(li: EditableLineItem): ProfileLineItem {
  return { type: li.type, description: li.description, quantity: li.quantity, unitPriceCents: li.unitPriceCents };
}

function profileToEditable(li: ProfileLineItem): EditableLineItem {
  return { _key: nextKey(), type: (li.type || "CUSTOM") as LineItemType, description: li.description, quantity: li.quantity, unitPriceCents: li.unitPriceCents, taxable: true };
}

function previewLineToEditable(li: PreviewLineItem): EditableLineItem {
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

type ProfileDrawerProps = {
  tenant: BillingProfilesTenant;
  profile?: BillingProfile | null;
  onClose: () => void;
  onSaved: () => void;
};

function ProfileDrawer({ tenant, profile, onClose, onSaved }: ProfileDrawerProps) {
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
  const lastLoadedPeriodRef = useRef<string | null>(null);

  const pmData = useAsyncResource<{ methods: { id: string; brand: string | null; last4: string | null; expMonth: string | null; expYear: string | null; isImported: boolean; isDefault: boolean; active: boolean }[] }>(
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
        setLineItems(res.lineItems.map(previewLineToEditable));
        lastLoadedPeriodRef.current = `${periodStart}:${periodEnd}`;
      } else {
        setError("No standard line items found for this period.");
      }
    } catch {
      setError("Failed to load standard bill. Check the service period and try again.");
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
        lineItemsJson: lineItems.filter(li => li.description.trim()).map(editableToProfileLineItem),
      };
      if (isEdit && profile) {
        await apiPut(`/admin/billing/platform/tenants/${tenant.id}/billing-profiles/${profile.id}`, body);
      } else {
        await apiPost(`/admin/billing/platform/tenants/${tenant.id}/billing-profiles`, body);
      }
      onSaved();
    } catch (err: any) {
      const msg = err?.body?.message || err?.body?.error || err?.message || "Save failed.";
      setError(String(msg));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="invoice-editor-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="invoice-editor-drawer" style={{ maxWidth: 580 }}>
        <div className="invoice-editor-drawer__header">
          <div>
            <div className="invoice-editor-drawer__eyebrow">{tenant.name}</div>
            <h2 className="invoice-editor-drawer__title">{isEdit ? "Edit Billing Profile" : "Add Billing Profile"}</h2>
          </div>
          <button className="invoice-editor-drawer__close" type="button" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <form className="invoice-editor-drawer__body" onSubmit={(e) => void handleSubmit(e)}>
          {error && <div className="invoice-editor-error">{error}</div>}

          {/* Client label */}
          <label className="invoice-editor-field">
            <span className="invoice-editor-label">Client / Sub-account name</span>
            <input
              className="invoice-editor-input"
              type="text"
              value={label}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
              placeholder="e.g. Bookkeeping Co, Law Firm Client"
              required
            />
          </label>

          {/* Payment method */}
          <label className="invoice-editor-field">
            <span className="invoice-editor-label">Payment method</span>
            <select
              className="invoice-editor-input"
              value={paymentMethodId}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setPaymentMethodId(e.target.value)}
            >
              <option value="">— None (manual charge only) —</option>
              {paymentMethods.map((pm) => (
                <option key={pm.id} value={pm.id}>
                  {cardLabel(pm)}{pm.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
            {paymentMethods.length === 0 && pmData.status === "success" && (
              <p className="invoice-editor-hint">No payment methods found. Import cards from Sola first.</p>
            )}
          </label>

          {/* Autopay toggle */}
          <label className="invoice-editor-field invoice-editor-field--row">
            <input
              type="checkbox"
              checked={autoBilling}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setAutoBilling(e.target.checked)}
            />
            <span className="invoice-editor-label">Enable autopay for this profile</span>
          </label>

          {/* Billing email */}
          <label className="invoice-editor-field">
            <span className="invoice-editor-label">Billing email <span style={{ fontWeight: 400, color: "#64748b" }}>(optional)</span></span>
            <input
              className="invoice-editor-input"
              type="email"
              value={billingEmail}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setBillingEmail(e.target.value)}
              placeholder="client@example.com"
            />
          </label>

          {/* Notes */}
          <label className="invoice-editor-field">
            <span className="invoice-editor-label">Notes <span style={{ fontWeight: 400, color: "#64748b" }}>(optional)</span></span>
            <textarea
              className="invoice-editor-input"
              value={notes}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
              rows={2}
              placeholder="Internal notes about this billing profile"
            />
          </label>

          {/* Line items */}
          <div className="invoice-editor-section">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <span className="invoice-editor-label" style={{ margin: 0 }}>Recurring line items</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {/* Load standard bill */}
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      className="invoice-editor-input"
                      type="date"
                      value={periodStart}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => { setPeriodStart(e.target.value); lastLoadedPeriodRef.current = null; }}
                      style={{ width: 130, padding: "2px 6px", fontSize: 12 }}
                      title="Period start for standard bill preview"
                    />
                    <span style={{ fontSize: 11, color: "#64748b" }}>→</span>
                    <input
                      className="invoice-editor-input"
                      type="date"
                      value={periodEnd}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => { setPeriodEnd(e.target.value); lastLoadedPeriodRef.current = null; }}
                      style={{ width: 130, padding: "2px 6px", fontSize: 12 }}
                      title="Period end for standard bill preview"
                    />
                    <button
                      type="button"
                      className="btn ghost"
                      style={{ fontSize: 12, padding: "3px 10px", whiteSpace: "nowrap" }}
                      disabled={loadingBill || !periodStart || !periodEnd}
                      onClick={() => void loadStandardBill()}
                      title="Load line items from this tenant's pricing profile"
                    >
                      {loadingBill ? "Loading…" : "⚡ Standard bill"}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <table className="invoice-editor-line-items">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Description</th>
                  <th style={{ width: 60, textAlign: "right" }}>Qty</th>
                  <th style={{ width: 100, textAlign: "right" }}>Unit price</th>
                  <th style={{ width: 90, textAlign: "right" }}>Amount</th>
                  <th style={{ width: 32 }}></th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((li) => (
                  <tr key={li._key}>
                    <td>
                      <select
                        className="invoice-editor-input"
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
                        className="invoice-editor-input"
                        type="text"
                        value={li.description}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => updateItem(li._key, "description", e.target.value)}
                        placeholder="Description"
                        style={{ fontSize: 12 }}
                      />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <input
                        className="invoice-editor-input"
                        type="number"
                        min={1}
                        style={{ width: 55, textAlign: "right", fontSize: 12 }}
                        value={li.quantity}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => updateItem(li._key, "quantity", Math.max(1, parseInt(e.target.value, 10) || 1))}
                      />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <input
                        className="invoice-editor-input"
                        type="number"
                        min={0}
                        step={1}
                        style={{ width: 90, textAlign: "right", fontSize: 12 }}
                        value={(li.unitPriceCents / 100).toFixed(2)}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => updateItem(li._key, "unitPriceCents", Math.round((parseFloat(e.target.value) || 0) * 100))}
                      />
                    </td>
                    <td style={{ textAlign: "right", fontSize: 13, color: "#1e293b" }}>
                      {fmt(li.quantity * li.unitPriceCents)}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn ghost"
                        style={{ padding: "2px 6px", fontSize: 12, color: "#dc2626" }}
                        onClick={() => removeItem(li._key)}
                        title="Remove line item"
                      >✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <button type="button" className="btn ghost" style={{ marginTop: 8, fontSize: 13 }} onClick={addItem}>
              + Add line item
            </button>

            {/* Totals */}
            <div className="invoice-editor-totals" style={{ marginTop: 12 }}>
              <div className="invoice-editor-totals__row">
                <span>Subtotal</span><span>{fmt(totals.subtotal)}</span>
              </div>
              {totals.tax > 0 && (
                <div className="invoice-editor-totals__row">
                  <span>Tax / fees</span><span>{fmt(totals.tax)}</span>
                </div>
              )}
              <div className="invoice-editor-totals__row invoice-editor-totals__row--total">
                <strong>Monthly total</strong><strong>{fmt(totals.total)}</strong>
              </div>
            </div>
          </div>

          <div className="invoice-editor-drawer__footer">
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
// Charge Now Confirmation Dialog
// ---------------------------------------------------------------------------

type ChargeNowDialogProps = {
  profile: BillingProfile;
  tenantId: string;
  onClose: () => void;
  onCharged: () => void;
};

function ChargeNowDialog({ profile, tenantId, onClose, onCharged }: ChargeNowDialogProps) {
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
      await apiPost(`/admin/billing/platform/tenants/${tenantId}/billing-profiles/${profile.id}/charge-now`, {
        periodStart,
        periodEnd,
      });
      setResult({ type: "ok", msg: "Invoice created and card charged successfully." });
      setTimeout(onCharged, 1500);
    } catch (err: any) {
      const body = err?.body;
      const msg = body?.message || body?.error || err?.message || "Charge failed.";
      setResult({ type: "err", msg: String(msg) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="invoice-editor-overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="invoice-editor-drawer" style={{ maxWidth: 440 }}>
        <div className="invoice-editor-drawer__header">
          <div>
            <div className="invoice-editor-drawer__eyebrow">{profile.label}</div>
            <h2 className="invoice-editor-drawer__title">Charge now</h2>
          </div>
          <button className="invoice-editor-drawer__close" type="button" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        </div>
        <div className="invoice-editor-drawer__body">
          {result ? (
            <div style={{ color: result.type === "ok" ? "#16a34a" : "#dc2626", padding: "12px 0", fontWeight: 500 }}>
              {result.msg}
            </div>
          ) : (
            <>
              <p style={{ margin: "0 0 16px", color: "#475569", fontSize: 14 }}>
                Create an invoice for <strong>{profile.label}</strong> and charge{" "}
                <strong>{cardLabel(profile.paymentMethod)}</strong> immediately.
              </p>
              <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
                <label className="invoice-editor-field" style={{ flex: 1 }}>
                  <span className="invoice-editor-label">Period start</span>
                  <input className="invoice-editor-input" type="date" value={periodStart} onChange={(e: ChangeEvent<HTMLInputElement>) => setPeriodStart(e.target.value)} />
                </label>
                <label className="invoice-editor-field" style={{ flex: 1 }}>
                  <span className="invoice-editor-label">Period end</span>
                  <input className="invoice-editor-input" type="date" value={periodEnd} onChange={(e: ChangeEvent<HTMLInputElement>) => setPeriodEnd(e.target.value)} />
                </label>
              </div>
              <div style={{ background: "#f8fafc", borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: "#64748b", marginBottom: 4 }}>Invoice total</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: "#1e293b" }}>{fmt(total)}</div>
                <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{lineItems.length} line item{lineItems.length !== 1 ? "s" : ""}</div>
              </div>
            </>
          )}
          <div className="invoice-editor-drawer__footer">
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main section component
// ---------------------------------------------------------------------------

type BillingProfilesSectionProps = {
  tenant: BillingProfilesTenant;
};

export function BillingProfilesSection({ tenant }: BillingProfilesSectionProps) {
  const [showDrawer, setShowDrawer] = useState<"add" | BillingProfile | null>(null);
  const [chargeTarget, setChargeTarget] = useState<BillingProfile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BillingProfile | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const reloadRef = useRef(0);

  const data = useAsyncResource<BillingProfile[]>(
    () => apiGet(`/admin/billing/platform/tenants/${tenant.id}/billing-profiles`),
    [tenant.id, reloadRef.current],
  );

  function reload() {
    reloadRef.current += 1;
    // Force re-render by updating a state that the hook depends on
    setShowDrawer(null);
    setChargeTarget(null);
  }

  async function handleDelete(profile: BillingProfile) {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await apiDelete(`/admin/billing/platform/tenants/${tenant.id}/billing-profiles/${profile.id}`);
      setDeleteTarget(null);
      reloadRef.current += 1;
    } catch (err: any) {
      const msg = err?.body?.message || err?.body?.error || err?.message || "Delete failed.";
      setDeleteError(String(msg));
    } finally {
      setDeleteBusy(false);
    }
  }

  const profiles = data.status === "success" ? data.data : [];

  return (
    <section className="billing-pricing-page billing-p8-scope" style={{ marginTop: 32 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#1e293b" }}>Billing Profiles</h3>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#64748b" }}>
            Sub-invoices for individual clients within this tenant. Each profile has its own payment method and recurring line items.
          </p>
        </div>
        <button
          className="btn primary"
          type="button"
          onClick={() => setShowDrawer("add")}
          style={{ whiteSpace: "nowrap" }}
        >
          + Add profile
        </button>
      </div>

      {/* Loading / error */}
      {data.status === "loading" && (
        <div style={{ padding: 24, color: "#64748b", fontSize: 14 }}>Loading profiles…</div>
      )}
      {data.status === "error" && (
        <div style={{ padding: 24, color: "#dc2626", fontSize: 14 }}>Failed to load billing profiles.</div>
      )}

      {/* Empty state */}
      {data.status === "success" && profiles.length === 0 && (
        <div style={{ padding: "32px 0", textAlign: "center", color: "#94a3b8", fontSize: 14, border: "1.5px dashed #e2e8f0", borderRadius: 10 }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🧾</div>
          <div style={{ fontWeight: 600, marginBottom: 4, color: "#64748b" }}>No billing profiles yet</div>
          <div>Click <strong>+ Add profile</strong> to set up sub-invoices for your clients.</div>
          <div style={{ marginTop: 8, fontSize: 12, color: "#cbd5e1" }}>
            Tip: assign imported Sola cards to profiles so each client is charged automatically.
          </div>
        </div>
      )}

      {/* Profile table */}
      {data.status === "success" && profiles.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #e2e8f0", color: "#64748b", textAlign: "left" }}>
                <th style={{ padding: "8px 12px" }}>Client</th>
                <th style={{ padding: "8px 12px" }}>Payment method</th>
                <th style={{ padding: "8px 12px", textAlign: "center" }}>Autopay</th>
                <th style={{ padding: "8px 12px", textAlign: "right" }}>Monthly total</th>
                <th style={{ padding: "8px 12px" }}>Last invoice</th>
                <th style={{ padding: "8px 12px" }}></th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((profile) => {
                const lineItems: ProfileLineItem[] = Array.isArray(profile.lineItemsJson) ? profile.lineItemsJson : [];
                const total = lineItems.reduce((s, li) => s + li.quantity * li.unitPriceCents, 0);
                return (
                  <tr key={profile.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "10px 12px", fontWeight: 600, color: "#1e293b" }}>{profile.label}</td>
                    <td style={{ padding: "10px 12px", color: profile.paymentMethod ? "#334155" : "#94a3b8" }}>
                      {cardLabel(profile.paymentMethod)}
                      {profile.paymentMethod?.isImported && (
                        <span style={{ marginLeft: 6, fontSize: 11, background: "#f0fdf4", color: "#16a34a", borderRadius: 4, padding: "1px 5px" }}>imported</span>
                      )}
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "center" }}>
                      <span style={{ color: profile.autoBillingEnabled ? "#16a34a" : "#94a3b8", fontWeight: 600 }}>
                        {profile.autoBillingEnabled ? "On" : "Off"}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, color: "#1e293b" }}>
                      {total > 0 ? fmt(total) : <span style={{ color: "#94a3b8" }}>—</span>}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      {profile.lastInvoice ? (
                        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          {statusBadge(profile.lastInvoice.status)}
                          <span style={{ color: "#64748b", fontSize: 12 }}>
                            {profile.lastInvoice.invoiceNumber} · {fmt(profile.lastInvoice.totalCents)}
                          </span>
                        </span>
                      ) : (
                        <span style={{ color: "#94a3b8" }}>None yet</span>
                      )}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button
                          className="btn ghost"
                          type="button"
                          style={{ fontSize: 12, padding: "3px 10px" }}
                          onClick={() => setChargeTarget(profile)}
                          title="Charge now"
                        >
                          Charge
                        </button>
                        <button
                          className="btn ghost"
                          type="button"
                          style={{ fontSize: 12, padding: "3px 10px" }}
                          onClick={() => setShowDrawer(profile)}
                        >
                          Edit
                        </button>
                        <button
                          className="btn ghost"
                          type="button"
                          style={{ fontSize: 12, padding: "3px 10px", color: "#dc2626" }}
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
        <div className="invoice-editor-overlay" onClick={(e) => { if (e.target === e.currentTarget && !deleteBusy) setDeleteTarget(null); }}>
          <div className="invoice-editor-drawer" style={{ maxWidth: 400 }}>
            <div className="invoice-editor-drawer__header">
              <h2 className="invoice-editor-drawer__title">Delete profile?</h2>
              <button className="invoice-editor-drawer__close" type="button" onClick={() => setDeleteTarget(null)} disabled={deleteBusy} aria-label="Close">✕</button>
            </div>
            <div className="invoice-editor-drawer__body">
              <p style={{ color: "#475569", fontSize: 14 }}>
                Delete billing profile <strong>{deleteTarget.label}</strong>? This cannot be undone. Existing paid invoices are kept.
              </p>
              {deleteError && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 8 }}>{deleteError}</div>}
              <div className="invoice-editor-drawer__footer">
                <button className="btn ghost" type="button" disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>Cancel</button>
                <button className="btn primary" type="button" disabled={deleteBusy} style={{ background: "#dc2626", borderColor: "#dc2626" }} onClick={() => void handleDelete(deleteTarget)}>
                  {deleteBusy ? "Deleting…" : "Delete profile"}
                </button>
              </div>
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
          onSaved={() => { reload(); }}
        />
      )}

      {/* Charge-now dialog */}
      {chargeTarget && (
        <ChargeNowDialog
          profile={chargeTarget}
          tenantId={tenant.id}
          onClose={() => setChargeTarget(null)}
          onCharged={() => { setChargeTarget(null); reloadRef.current += 1; }}
        />
      )}
    </section>
  );
}
