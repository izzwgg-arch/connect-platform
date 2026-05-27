"use client";

/**
 * InvoiceEditor — full admin invoice editor.
 *
 * Features:
 *  - Edit invoice metadata (service period, issue date, due date, notes, billing email)
 *  - Add / edit / remove line items (all types supported)
 *  - Live total recalculation
 *  - Paid invoice edit guard: requires explicit confirmation
 *  - Save changes via PUT /admin/billing/invoices/:id (metadata) and
 *    PUT /admin/billing/invoices/:id/line-items (line items)
 *  - Audit badge showing source (MANUAL vs SYSTEM)
 */

import { useState, useCallback, type ChangeEvent } from "react";
import { apiGet, apiPost, apiPut } from "../../../../../services/apiClient";
import "./invoiceEditorStyles.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LineItemType =
  | "EXTENSION"
  | "PHONE_NUMBER"
  | "SMS_PACKAGE"
  | "SALES_TAX"
  | "E911_FEE"
  | "REGULATORY_FEE"
  | "CREDIT"
  | "DISCOUNT"
  | "MANUAL_ADJUSTMENT"
  | "TRUNK"
  | "DID"
  | "ONE_TIME"
  | "CUSTOM";

export const LINE_ITEM_TYPE_LABELS: Record<LineItemType, string> = {
  EXTENSION: "Extension",
  PHONE_NUMBER: "Phone Number",
  SMS_PACKAGE: "SMS Package",
  SALES_TAX: "Sales Tax",
  E911_FEE: "E911 Fee",
  REGULATORY_FEE: "Regulatory Fee",
  CREDIT: "Credit",
  DISCOUNT: "Discount",
  MANUAL_ADJUSTMENT: "Manual Adjustment",
  TRUNK: "Trunk",
  DID: "DID",
  ONE_TIME: "One-Time",
  CUSTOM: "Custom",
};

const TAX_TYPES: LineItemType[] = ["SALES_TAX", "E911_FEE", "REGULATORY_FEE"];

export type EditableLineItem = {
  _key: string;
  type: LineItemType;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxable: boolean;
};

export type InvoiceEditorInvoice = {
  id: string;
  tenantId: string;
  invoiceNumber: string;
  status: string;
  totalCents: number;
  subtotalCents: number;
  taxCents: number;
  amountPaidCents: number;
  balanceDueCents: number;
  periodStart: string;
  periodEnd: string;
  issueDate: string;
  dueDate: string;
  notes?: string | null;
  billingEmail?: string | null;
  source?: string | null;
  createdByUserId?: string | null;
  lineItems?: Array<{
    id: string;
    type: string;
    description: string;
    quantity: number;
    unitPriceCents: number;
    amountCents: number;
    taxable: boolean;
  }>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function toDateInput(iso: string): string {
  return iso ? iso.slice(0, 10) : "";
}

function calcTotals(items: EditableLineItem[]): {
  subtotal: number;
  tax: number;
  total: number;
} {
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

let _keyCounter = 0;
function nextKey() {
  return `li-${++_keyCounter}-${Date.now()}`;
}

function invoiceToLineItems(invoice: InvoiceEditorInvoice): EditableLineItem[] {
  return (invoice.lineItems ?? []).map((li) => ({
    _key: nextKey(),
    type: li.type as LineItemType,
    description: li.description,
    quantity: li.quantity,
    unitPriceCents: li.unitPriceCents,
    taxable: li.taxable,
  }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type InvoiceEditorProps = {
  invoice: InvoiceEditorInvoice;
  onSaved?: (updated: InvoiceEditorInvoice) => void;
  onCancel?: () => void;
};

export function InvoiceEditor({ invoice, onSaved, onCancel }: InvoiceEditorProps) {
  const isPaid = invoice.status === "PAID";
  const isVoid = invoice.status === "VOID";

  // Meta state
  const [periodStart, setPeriodStart] = useState(toDateInput(invoice.periodStart));
  const [periodEnd, setPeriodEnd] = useState(toDateInput(invoice.periodEnd));
  const [issueDate, setIssueDate] = useState(toDateInput(invoice.issueDate));
  const [dueDate, setDueDate] = useState(toDateInput(invoice.dueDate));
  const [notes, setNotes] = useState(invoice.notes ?? "");
  const [billingEmail, setBillingEmail] = useState(invoice.billingEmail ?? "");

  // Line items state
  const [lineItems, setLineItems] = useState<EditableLineItem[]>(() =>
    invoiceToLineItems(invoice),
  );

  // UX state
  const [paidEditConfirmed, setPaidEditConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const totals = calcTotals(lineItems);

  // ---------------------------------------------------------------------------
  // Line item mutations
  // ---------------------------------------------------------------------------

  const addLineItem = useCallback(() => {
    setLineItems((prev) => [
      ...prev,
      {
        _key: nextKey(),
        type: "CUSTOM",
        description: "",
        quantity: 1,
        unitPriceCents: 0,
        taxable: true,
      },
    ]);
  }, []);

  const updateLineItem = useCallback(
    (key: string, field: keyof EditableLineItem, value: unknown) => {
      setLineItems((prev) =>
        prev.map((li) => (li._key === key ? { ...li, [field]: value } : li)),
      );
    },
    [],
  );

  const removeLineItem = useCallback((key: string) => {
    setLineItems((prev) => prev.filter((li) => li._key !== key));
  }, []);

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (isVoid) return;
    if (isPaid && !paidEditConfirmed) {
      setError(
        "This invoice is marked PAID. Check the box above to confirm you intend to edit it.",
      );
      return;
    }
    setError(null);
    setSuccess(null);
    setSaving(true);

    try {
      const allowPaidEdit = isPaid ? true : undefined;

      // 1. Update metadata
      await apiPut(`/admin/billing/invoices/${invoice.id}`, {
        periodStart: periodStart ? `${periodStart}T00:00:00Z` : undefined,
        periodEnd: periodEnd ? `${periodEnd}T00:00:00Z` : undefined,
        issueDate: issueDate ? `${issueDate}T00:00:00Z` : undefined,
        dueDate: dueDate ? `${dueDate}T00:00:00Z` : undefined,
        notes: notes || null,
        billingEmail: billingEmail || null,
        allowPaidEdit,
      });

      // 2. Replace line items
      const updated = await apiPut<InvoiceEditorInvoice>(
        `/admin/billing/invoices/${invoice.id}/line-items`,
        {
          lineItems: lineItems.map((li) => ({
            type: li.type,
            description: li.description,
            quantity: li.quantity,
            unitPriceCents: li.unitPriceCents,
            taxable: li.taxable,
          })),
          allowPaidEdit,
        },
      );

      setSuccess("Invoice saved successfully.");
      onSaved?.((updated as any).invoice ?? updated);
    } catch (err: unknown) {
      const e = err as { message?: string; error?: string };
      if (e?.error === "invoice_paid_edit_requires_confirmation") {
        setError("Check the confirmation box to edit a paid invoice.");
      } else {
        setError(e?.message ?? "Failed to save. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  }, [
    invoice.id,
    isVoid,
    isPaid,
    paidEditConfirmed,
    periodStart,
    periodEnd,
    issueDate,
    dueDate,
    notes,
    billingEmail,
    lineItems,
    onSaved,
  ]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const statusBadgeClass = {
    PAID: "inv-editor__badge--paid",
    OPEN: "inv-editor__badge--open",
    VOID: "inv-editor__badge--void",
    DRAFT: "inv-editor__badge--open",
    OVERDUE: "inv-editor__badge--overdue",
    FAILED: "inv-editor__badge--overdue",
  }[invoice.status] ?? "inv-editor__badge--open";

  return (
    <div className="inv-editor">
      {/* Header */}
      <div className="inv-editor__header">
        <h2 className="inv-editor__title">Edit Invoice</h2>
        <span className={`inv-editor__badge ${statusBadgeClass}`}>
          {invoice.status}
        </span>
        <span style={{ fontSize: 13, color: "var(--ie-text-muted)" }}>
          {invoice.invoiceNumber}
        </span>
        {invoice.source === "MANUAL" && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              background: "var(--ie-bg-subtle)",
              border: "1px solid var(--ie-border)",
              borderRadius: 12,
              padding: "2px 8px",
              color: "var(--ie-text-muted)",
            }}
          >
            MANUAL
          </span>
        )}
      </div>

      {/* Paid warning */}
      {isPaid && (
        <div className="inv-editor__warn-banner">
          <span style={{ fontSize: 18 }}>⚠️</span>
          <div>
            <strong>Paid invoice.</strong> Changes to line items will recalculate
            the balance due. Existing payment history is preserved. An audit
            entry will be created for every change.
            <br />
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={paidEditConfirmed}
                onChange={(e) => setPaidEditConfirmed(e.target.checked)}
              />
              <span style={{ fontSize: 13 }}>
                I understand and confirm editing this paid invoice.
              </span>
            </label>
          </div>
        </div>
      )}

      {isVoid && (
        <div className="inv-editor__warn-banner">
          <span style={{ fontSize: 18 }}>🚫</span>
          <strong>Void invoices cannot be edited.</strong>
        </div>
      )}

      {/* Metadata section */}
      <div className="inv-editor__section">
        <div className="inv-editor__section-head">
          <h3 className="inv-editor__section-title">Invoice Details</h3>
        </div>
        <div className="inv-editor__section-body">
          <div className="inv-editor__meta-grid">
            <div className="inv-editor__field">
              <label className="inv-editor__label">Service Period Start</label>
              <input
                type="date"
                className="inv-editor__input"
                value={periodStart}
                disabled={isVoid}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setPeriodStart(e.target.value)
                }
              />
            </div>
            <div className="inv-editor__field">
              <label className="inv-editor__label">Service Period End</label>
              <input
                type="date"
                className="inv-editor__input"
                value={periodEnd}
                disabled={isVoid}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setPeriodEnd(e.target.value)
                }
              />
            </div>
            <div className="inv-editor__field">
              <label className="inv-editor__label">Invoice Date</label>
              <input
                type="date"
                className="inv-editor__input"
                value={issueDate}
                disabled={isVoid}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setIssueDate(e.target.value)
                }
              />
            </div>
            <div className="inv-editor__field">
              <label className="inv-editor__label">Due Date</label>
              <input
                type="date"
                className="inv-editor__input"
                value={dueDate}
                disabled={isVoid}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setDueDate(e.target.value)
                }
              />
            </div>
            <div className="inv-editor__field" style={{ gridColumn: "1 / -1" }}>
              <label className="inv-editor__label">Billing Email (override)</label>
              <input
                type="text"
                className="inv-editor__input"
                value={billingEmail}
                placeholder="Leave blank to use tenant default (comma-separate for multiple)"
                disabled={isVoid}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setBillingEmail(e.target.value)
                }
              />
            </div>
            <div className="inv-editor__field" style={{ gridColumn: "1 / -1" }}>
              <label className="inv-editor__label">Notes / Memo</label>
              <textarea
                className="inv-editor__input inv-editor__textarea"
                value={notes}
                disabled={isVoid}
                placeholder="Internal notes or customer-facing memo"
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                  setNotes(e.target.value)
                }
              />
            </div>
          </div>
        </div>
      </div>

      {/* Line items section */}
      <div className="inv-editor__section">
        <div className="inv-editor__section-head">
          <h3 className="inv-editor__section-title">Line Items</h3>
        </div>
        <div className="inv-editor__section-body" style={{ padding: "0 0 16px" }}>
          <table className="inv-editor__li-table">
            <thead>
              <tr>
                <th style={{ width: 130 }}>Type</th>
                <th>Description</th>
                <th style={{ width: 70, textAlign: "center" }}>Qty</th>
                <th style={{ width: 110, textAlign: "right" }}>Unit Price</th>
                <th style={{ width: 100, textAlign: "right" }}>Amount</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {lineItems.map((li) => {
                const amount = Math.round(li.quantity * li.unitPriceCents);
                return (
                  <tr key={li._key}>
                    <td>
                      <select
                        value={li.type}
                        disabled={isVoid}
                        onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                          updateLineItem(li._key, "type", e.target.value as LineItemType)
                        }
                      >
                        {(Object.keys(LINE_ITEM_TYPE_LABELS) as LineItemType[]).map(
                          (t) => (
                            <option key={t} value={t}>
                              {LINE_ITEM_TYPE_LABELS[t]}
                            </option>
                          ),
                        )}
                      </select>
                    </td>
                    <td>
                      <input
                        type="text"
                        value={li.description}
                        disabled={isVoid}
                        placeholder="Description"
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          updateLineItem(li._key, "description", e.target.value)
                        }
                      />
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <input
                        type="number"
                        value={li.quantity}
                        disabled={isVoid}
                        min={0}
                        step={0.5}
                        style={{ textAlign: "center" }}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          updateLineItem(li._key, "quantity", parseFloat(e.target.value) || 0)
                        }
                      />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <input
                        type="number"
                        value={(li.unitPriceCents / 100).toFixed(2)}
                        disabled={isVoid}
                        min={0}
                        step={0.01}
                        style={{ textAlign: "right" }}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const dollars = parseFloat(e.target.value) || 0;
                          updateLineItem(li._key, "unitPriceCents", Math.round(dollars * 100));
                        }}
                      />
                    </td>
                    <td className="inv-editor__li-amt">{fmt(amount)}</td>
                    <td>
                      <button
                        className="inv-editor__li-delete"
                        disabled={isVoid}
                        title="Remove line item"
                        onClick={() => removeLineItem(li._key)}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {!isVoid && (
            <div style={{ padding: "0 16px" }}>
              <button className="inv-editor__add-line-btn" onClick={addLineItem}>
                + Add line item
              </button>
            </div>
          )}

          {/* Totals */}
          <div className="inv-editor__totals" style={{ paddingRight: 48 }}>
            <div className="inv-editor__totals-row">
              <span className="label">Subtotal</span>
              <span className="amount">{fmt(totals.subtotal)}</span>
            </div>
            {totals.tax > 0 && (
              <div className="inv-editor__totals-row">
                <span className="label">Tax & Fees</span>
                <span className="amount">{fmt(totals.tax)}</span>
              </div>
            )}
            <div className="inv-editor__totals-row inv-editor__totals-row--total">
              <span className="label">Total</span>
              <span className="amount">{fmt(totals.total)}</span>
            </div>
            {invoice.amountPaidCents > 0 && (
              <>
                <div className="inv-editor__totals-row">
                  <span className="label">Paid</span>
                  <span className="amount" style={{ color: "var(--ie-text-success)" }}>
                    −{fmt(invoice.amountPaidCents)}
                  </span>
                </div>
                <div className="inv-editor__totals-row">
                  <span className="label">Balance Due</span>
                  <span
                    className="amount"
                    style={{
                      color:
                        Math.max(0, totals.total - invoice.amountPaidCents) > 0
                          ? "var(--ie-text-danger)"
                          : "var(--ie-text-success)",
                    }}
                  >
                    {fmt(Math.max(0, totals.total - invoice.amountPaidCents))}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Feedback */}
      {error && <div className="inv-editor__error">⚠ {error}</div>}
      {success && <div className="inv-editor__success">✓ {success}</div>}

      {/* Actions */}
      {!isVoid && (
        <div className="inv-editor__btn-row">
          {onCancel && (
            <button
              className="inv-editor__btn inv-editor__btn--secondary"
              onClick={onCancel}
              disabled={saving}
            >
              Cancel
            </button>
          )}
          <button
            className="inv-editor__btn inv-editor__btn--primary"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save Invoice"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lightweight invoice editor drawer wrapper
// ---------------------------------------------------------------------------

export function InvoiceEditorDrawer({
  invoiceId,
  onClose,
  onSaved,
}: {
  invoiceId: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [invoice, setInvoice] = useState<InvoiceEditorInvoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load invoice + line items
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [inv, items] = await Promise.all([
        apiGet<InvoiceEditorInvoice>(`/admin/billing/invoices/${invoiceId}`),
        apiGet<InvoiceEditorInvoice["lineItems"]>(
          `/admin/billing/invoices/${invoiceId}/line-items`,
        ),
      ]);
      setInvoice({ ...(inv as InvoiceEditorInvoice), lineItems: items as InvoiceEditorInvoice["lineItems"] });
    } catch {
      setLoadError("Failed to load invoice.");
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useState(() => { void load(); });

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.4)",
        zIndex: 900,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "flex-end",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "var(--ie-bg, #fff)",
          width: 700,
          maxWidth: "96vw",
          height: "100vh",
          overflowY: "auto",
          boxShadow: "-4px 0 32px rgba(0,0,0,.15)",
          padding: 32,
          boxSizing: "border-box",
        }}
        className="inv-editor"
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Invoice Editor</span>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "var(--ie-text-muted)" }}
          >
            ×
          </button>
        </div>

        {loading && <div style={{ color: "var(--ie-text-muted)", fontSize: 14 }}>Loading…</div>}
        {loadError && <div style={{ color: "var(--ie-text-danger)", fontSize: 14 }}>{loadError}</div>}
        {invoice && (
          <InvoiceEditor
            invoice={invoice}
            onCancel={onClose}
            onSaved={() => {
              onSaved?.();
              onClose();
            }}
          />
        )}
      </div>
    </div>
  );
}
