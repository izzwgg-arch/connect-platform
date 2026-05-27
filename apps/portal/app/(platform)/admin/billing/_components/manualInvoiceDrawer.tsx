"use client";

/**
 * ManualInvoiceDrawer — lets admin create a manual invoice with custom line items,
 * service period, and optional immediate payment marking.
 *
 * Calls POST /admin/billing/invoices/manual.
 */

import { useState, useCallback, type ChangeEvent } from "react";
import { apiPost } from "../../../../../services/apiClient";
import { LINE_ITEM_TYPE_LABELS, type EditableLineItem, type LineItemType } from "./invoiceEditor";
import "./invoiceEditorStyles.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ManualInvoiceTenant = {
  id: string;
  name: string;
};

type ManualInvoiceDrawerProps = {
  tenant: ManualInvoiceTenant;
  onClose: () => void;
  onCreated?: (invoice: { id: string; invoiceNumber: string }) => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function netDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

let _keyCounter = 0;
function nextKey() {
  return `li-m-${++_keyCounter}-${Date.now()}`;
}

function newLineItem(): EditableLineItem {
  return {
    _key: nextKey(),
    type: "CUSTOM",
    description: "",
    quantity: 1,
    unitPriceCents: 0,
    taxable: true,
  };
}

const TAX_TYPES: LineItemType[] = ["SALES_TAX", "E911_FEE", "REGULATORY_FEE"];

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ManualInvoiceDrawer({
  tenant,
  onClose,
  onCreated,
}: ManualInvoiceDrawerProps) {
  const [periodStart, setPeriodStart] = useState(todayIso());
  const [periodEnd, setPeriodEnd] = useState(todayIso());
  const [issueDate, setIssueDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState(netDays(15));
  const [notes, setNotes] = useState("");
  const [billingEmail, setBillingEmail] = useState("");
  const [status, setStatus] = useState<"DRAFT" | "OPEN">("OPEN");
  const [markPaid, setMarkPaid] = useState(false);
  const [lineItems, setLineItems] = useState<EditableLineItem[]>([newLineItem()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const totals = calcTotals(lineItems);

  const addItem = useCallback(() => {
    setLineItems((prev) => [...prev, newLineItem()]);
  }, []);

  const updateItem = useCallback(
    (key: string, field: keyof EditableLineItem, value: unknown) => {
      setLineItems((prev) =>
        prev.map((li) => (li._key === key ? { ...li, [field]: value } : li)),
      );
    },
    [],
  );

  const removeItem = useCallback((key: string) => {
    setLineItems((prev) => prev.filter((li) => li._key !== key));
  }, []);

  const handleCreate = useCallback(async () => {
    if (!lineItems.length) {
      setError("Add at least one line item.");
      return;
    }
    for (const li of lineItems) {
      if (!li.description.trim()) {
        setError("All line items must have a description.");
        return;
      }
    }

    setError(null);
    setSubmitting(true);

    try {
      const result = await apiPost<{ id: string; invoiceNumber: string }>(
        "/admin/billing/invoices/manual",
        {
          tenantId: tenant.id,
          periodStart: `${periodStart}T00:00:00Z`,
          periodEnd: `${periodEnd}T00:00:00Z`,
          issueDate: `${issueDate}T00:00:00Z`,
          dueDate: `${dueDate}T00:00:00Z`,
          notes: notes.trim() || null,
          billingEmail: billingEmail.trim() || null,
          status,
          markPaidImmediately: markPaid,
          lineItems: lineItems.map((li) => ({
            type: li.type,
            description: li.description.trim(),
            quantity: li.quantity,
            unitPriceCents: li.unitPriceCents,
            taxable: li.taxable,
          })),
        },
      );

      setSuccess(
        `Invoice ${result.invoiceNumber} created${markPaid ? " and marked paid" : ""}.`,
      );

      setTimeout(() => {
        onCreated?.(result);
        onClose();
      }, 1500);
    } catch (err: unknown) {
      const e = err as { error?: string; message?: string };
      setError(e?.message ?? "Failed to create invoice. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }, [
    tenant.id,
    periodStart,
    periodEnd,
    issueDate,
    dueDate,
    notes,
    billingEmail,
    status,
    markPaid,
    lineItems,
    onCreated,
    onClose,
  ]);

  return (
    <div
      className="manual-inv-drawer__overlay inv-editor"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="manual-inv-drawer__panel">
        {/* Header */}
        <div className="manual-inv-drawer__header">
          <h3 className="manual-inv-drawer__title">
            Create Manual Invoice — {tenant.name}
          </h3>
          <button className="manual-inv-drawer__close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="manual-inv-drawer__body">
          {/* Service period */}
          <div className="inv-editor__section">
            <div className="inv-editor__section-head">
              <h4 className="inv-editor__section-title">Service Period & Dates</h4>
            </div>
            <div className="inv-editor__section-body">
              <div className="inv-editor__meta-grid">
                <div className="inv-editor__field">
                  <label className="inv-editor__label">Service Period Start</label>
                  <input
                    type="date"
                    className="inv-editor__input"
                    value={periodStart}
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
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setDueDate(e.target.value)
                    }
                  />
                </div>
                <div className="inv-editor__field" style={{ gridColumn: "1 / -1" }}>
                  <label className="inv-editor__label">
                    Billing Email Override (optional)
                  </label>
                  <input
                    type="email"
                    className="inv-editor__input"
                    value={billingEmail}
                    placeholder="Leave blank to use tenant default"
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
                    placeholder="Internal memo or customer note"
                    onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                      setNotes(e.target.value)
                    }
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Line items */}
          <div className="inv-editor__section">
            <div className="inv-editor__section-head">
              <h4 className="inv-editor__section-title">Line Items</h4>
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
                    const amt = Math.round(li.quantity * li.unitPriceCents);
                    return (
                      <tr key={li._key}>
                        <td>
                          <select
                            value={li.type}
                            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                              updateItem(li._key, "type", e.target.value as LineItemType)
                            }
                          >
                            {(Object.keys(LINE_ITEM_TYPE_LABELS) as LineItemType[]).map((t) => (
                              <option key={t} value={t}>
                                {LINE_ITEM_TYPE_LABELS[t]}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="text"
                            value={li.description}
                            placeholder="Description"
                            onChange={(e: ChangeEvent<HTMLInputElement>) =>
                              updateItem(li._key, "description", e.target.value)
                            }
                          />
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <input
                            type="number"
                            value={li.quantity}
                            min={0}
                            step={0.5}
                            style={{ textAlign: "center" }}
                            onChange={(e: ChangeEvent<HTMLInputElement>) =>
                              updateItem(li._key, "quantity", parseFloat(e.target.value) || 0)
                            }
                          />
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <input
                            type="number"
                            value={(li.unitPriceCents / 100).toFixed(2)}
                            min={0}
                            step={0.01}
                            style={{ textAlign: "right" }}
                            onChange={(e: ChangeEvent<HTMLInputElement>) => {
                              const dollars = parseFloat(e.target.value) || 0;
                              updateItem(li._key, "unitPriceCents", Math.round(dollars * 100));
                            }}
                          />
                        </td>
                        <td className="inv-editor__li-amt">{fmt(amt)}</td>
                        <td>
                          <button
                            className="inv-editor__li-delete"
                            onClick={() => removeItem(li._key)}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div style={{ padding: "0 16px" }}>
                <button className="inv-editor__add-line-btn" onClick={addItem}>
                  + Add line item
                </button>
              </div>

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
              </div>
            </div>
          </div>

          {/* Options */}
          <div className="inv-editor__section">
            <div className="inv-editor__section-head">
              <h4 className="inv-editor__section-title">Options</h4>
            </div>
            <div className="inv-editor__section-body">
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div className="inv-editor__field">
                  <label className="inv-editor__label">Invoice Status</label>
                  <select
                    className="inv-editor__input"
                    value={status}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                      setStatus(e.target.value as "DRAFT" | "OPEN")
                    }
                  >
                    <option value="OPEN">Open (send to customer)</option>
                    <option value="DRAFT">Draft (hold, do not send)</option>
                  </select>
                </div>

                <label
                  style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}
                >
                  <input
                    type="checkbox"
                    checked={markPaid}
                    onChange={(e) => setMarkPaid(e.target.checked)}
                  />
                  Mark as paid immediately (payment already received outside Connect)
                </label>
                {markPaid && (
                  <div
                    style={{
                      background: "var(--ie-bg-success)",
                      border: "1px solid #bbf7d0",
                      borderRadius: 6,
                      padding: "10px 14px",
                      fontSize: 12,
                      color: "var(--ie-text-success)",
                    }}
                  >
                    Invoice will be created with status PAID. Use the external payment
                    drawer afterwards to attach the payment record with full details.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Feedback */}
          {error && <div className="inv-editor__error">⚠ {error}</div>}
          {success && <div className="inv-editor__success">✓ {success}</div>}
        </div>

        {/* Footer */}
        <div className="manual-inv-drawer__footer">
          <button
            className="inv-editor__btn inv-editor__btn--secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            className="inv-editor__btn inv-editor__btn--primary"
            onClick={() => void handleCreate()}
            disabled={submitting || !!success}
          >
            {submitting ? "Creating…" : "Create Invoice"}
          </button>
        </div>
      </div>
    </div>
  );
}
