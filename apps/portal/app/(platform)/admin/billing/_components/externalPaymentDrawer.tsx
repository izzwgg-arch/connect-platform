"use client";

/**
 * ExternalPaymentDrawer — records an external/manual payment against an invoice.
 *
 * Hard rules enforced in this component:
 *  - No Cardknox/Sola wording anywhere.
 *  - Calls POST /admin/billing/invoices/:id/external-payment only.
 *  - Shows the external payment method badge clearly.
 *  - Warns about duplicate payments when the API returns duplicateWarning.
 *  - Supports full and partial amounts.
 *  - Shows duplicate warning but does NOT silently block a re-post.
 */

import { useState, useCallback, type ChangeEvent } from "react";
import { apiPost } from "../../../../../services/apiClient";
import "./invoiceEditorStyles.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExternalPaymentMethod =
  | "QUICKPAY"
  | "ZELLE"
  | "CHECK"
  | "CASH"
  | "CARD_EXTERNAL"
  | "ACH_EXTERNAL"
  | "OTHER";

const METHOD_LABELS: Record<ExternalPaymentMethod, string> = {
  QUICKPAY: "QuickPay",
  ZELLE: "Zelle",
  CHECK: "Check",
  CASH: "Cash",
  CARD_EXTERNAL: "Card (External)",
  ACH_EXTERNAL: "ACH / Bank Transfer",
  OTHER: "Other",
};

export type ExternalPaymentInvoice = {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  status: string;
  totalCents: number;
  amountPaidCents: number;
  balanceDueCents: number;
  tenant?: { name?: string };
};

type ExternalPaymentDrawerProps = {
  invoice: ExternalPaymentInvoice;
  onClose: () => void;
  onPosted?: () => void;
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ExternalPaymentDrawer({
  invoice,
  onClose,
  onPosted,
}: ExternalPaymentDrawerProps) {
  const [method, setMethod] = useState<ExternalPaymentMethod>("ZELLE");
  const [amountDollars, setAmountDollars] = useState(
    String((invoice.balanceDueCents / 100).toFixed(2)),
  );
  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [externalReference, setExternalReference] = useState("");
  const [payerName, setPayerName] = useState("");
  const [externalNotes, setExternalNotes] = useState("");
  const [sendReceiptEmail, setSendReceiptEmail] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);

  const amountCents = Math.round((parseFloat(amountDollars) || 0) * 100);
  const remainingBalance = invoice.balanceDueCents;
  const isPartial = amountCents < remainingBalance && amountCents > 0;
  const exceeds = amountCents > remainingBalance;

  const handleSubmit = useCallback(async () => {
    if (amountCents <= 0) {
      setError("Amount must be greater than $0.00.");
      return;
    }
    if (!paymentDate) {
      setError("Payment date is required.");
      return;
    }

    setError(null);
    setSubmitting(true);
    setDuplicateWarning(null);

    try {
      const result = await apiPost<{
        transaction: { id: string };
        invoice: { status: string };
        invoiceFullyPaid: boolean;
        duplicateWarning?: string;
      }>(`/admin/billing/invoices/${invoice.id}/external-payment`, {
        amountCents,
        paymentDate: `${paymentDate}T12:00:00Z`,
        method,
        externalReference: externalReference.trim() || undefined,
        payerName: payerName.trim() || undefined,
        externalNotes: externalNotes.trim() || undefined,
        sendReceiptEmail,
      });

      if (result.duplicateWarning) {
        setDuplicateWarning(result.duplicateWarning);
      }

      const label = METHOD_LABELS[method];
      setSuccess(
        result.invoiceFullyPaid
          ? `Payment posted via ${label}. Invoice is now PAID.`
          : `Partial payment posted via ${label}. Balance remaining.`,
      );

      setTimeout(() => {
        onPosted?.();
        onClose();
      }, 1800);
    } catch (err: unknown) {
      const e = err as { error?: string; message?: string };
      if (e?.error === "invoice_void_cannot_receive_payment") {
        setError("This invoice is void and cannot receive payments.");
      } else {
        setError(e?.message ?? "Failed to post payment. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    invoice.id,
    amountCents,
    paymentDate,
    method,
    externalReference,
    payerName,
    externalNotes,
    sendReceiptEmail,
    onPosted,
    onClose,
  ]);

  return (
    <div
      className="ext-pay-drawer__overlay inv-editor"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="ext-pay-drawer__panel">
        {/* Header */}
        <div className="ext-pay-drawer__header">
          <h3 className="ext-pay-drawer__title">Post External Payment</h3>
          <button className="ext-pay-drawer__close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="ext-pay-drawer__body">
          {/* External badge */}
          <div>
            <span className="ext-pay-drawer__badge">
              ⚡ External / Manual Payment
            </span>
          </div>

          {/* Invoice summary */}
          <div className="ext-pay-drawer__summary">
            <div className="ext-pay-drawer__summary-row">
              <span className="label">Invoice</span>
              <span className="value">{invoice.invoiceNumber}</span>
            </div>
            <div className="ext-pay-drawer__summary-row">
              <span className="label">Customer</span>
              <span className="value">{invoice.tenant?.name ?? invoice.tenantId}</span>
            </div>
            <div className="ext-pay-drawer__summary-row">
              <span className="label">Total</span>
              <span className="value">{fmt(invoice.totalCents)}</span>
            </div>
            <div className="ext-pay-drawer__summary-row">
              <span className="label">Balance Due</span>
              <span
                className="value"
                style={{
                  color: remainingBalance > 0 ? "var(--ie-text-danger)" : "var(--ie-text-success)",
                }}
              >
                {fmt(remainingBalance)}
              </span>
            </div>
          </div>

          {/* Payment method selector */}
          <div>
            <div className="inv-editor__label" style={{ marginBottom: 8 }}>
              Payment Method
            </div>
            <div className="ext-pay-drawer__method-grid">
              {(Object.keys(METHOD_LABELS) as ExternalPaymentMethod[]).map((m) => (
                <button
                  key={m}
                  className={`ext-pay-drawer__method-btn${method === m ? " ext-pay-drawer__method-btn--selected" : ""}`}
                  onClick={() => setMethod(m)}
                >
                  {METHOD_LABELS[m]}
                </button>
              ))}
            </div>
          </div>

          {/* Amount */}
          <div className="inv-editor__field">
            <label className="inv-editor__label">Amount ($)</label>
            <input
              type="number"
              className="inv-editor__input"
              value={amountDollars}
              min={0.01}
              step={0.01}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setAmountDollars(e.target.value)
              }
            />
            {isPartial && (
              <div style={{ fontSize: 12, color: "var(--ie-text-warn)", marginTop: 4 }}>
                Partial payment — {fmt(remainingBalance - amountCents)} will remain on balance.
              </div>
            )}
            {exceeds && (
              <div style={{ fontSize: 12, color: "var(--ie-text-danger)", marginTop: 4 }}>
                Amount exceeds balance ({fmt(remainingBalance)}). Overpayment will be tracked.
              </div>
            )}
          </div>

          {/* Payment date */}
          <div className="inv-editor__field">
            <label className="inv-editor__label">Payment Date</label>
            <input
              type="date"
              className="inv-editor__input"
              value={paymentDate}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setPaymentDate(e.target.value)
              }
            />
          </div>

          {/* Reference number */}
          <div className="inv-editor__field">
            <label className="inv-editor__label">
              Reference / Check # (optional)
            </label>
            <input
              type="text"
              className="inv-editor__input"
              value={externalReference}
              placeholder={
                method === "CHECK"
                  ? "Check number"
                  : method === "ZELLE"
                    ? "Zelle confirmation"
                    : method === "QUICKPAY"
                      ? "QuickPay confirmation"
                      : "Reference number"
              }
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setExternalReference(e.target.value)
              }
            />
          </div>

          {/* Payer name */}
          <div className="inv-editor__field">
            <label className="inv-editor__label">Payer Name (optional)</label>
            <input
              type="text"
              className="inv-editor__input"
              value={payerName}
              placeholder="Name of person who paid"
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setPayerName(e.target.value)
              }
            />
          </div>

          {/* Notes */}
          <div className="inv-editor__field">
            <label className="inv-editor__label">Notes (optional)</label>
            <textarea
              className="inv-editor__input inv-editor__textarea"
              value={externalNotes}
              placeholder="Any additional details"
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                setExternalNotes(e.target.value)
              }
            />
          </div>

          {/* Send receipt */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={sendReceiptEmail}
              onChange={(e) => setSendReceiptEmail(e.target.checked)}
            />
            Send paid invoice receipt email after posting
          </label>

          {/* Duplicate warning */}
          {duplicateWarning && (
            <div className="ext-pay-drawer__dup-warn">
              ⚠ {duplicateWarning}
            </div>
          )}

          {/* Feedback */}
          {error && (
            <div className="inv-editor__error">⚠ {error}</div>
          )}
          {success && (
            <div className="inv-editor__success">✓ {success}</div>
          )}
        </div>

        {/* Footer */}
        <div className="ext-pay-drawer__footer">
          <button
            className="inv-editor__btn inv-editor__btn--secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            className="inv-editor__btn inv-editor__btn--primary"
            onClick={() => void handleSubmit()}
            disabled={submitting || amountCents <= 0 || !!success}
          >
            {submitting
              ? "Posting…"
              : `Post ${METHOD_LABELS[method]} Payment`}
          </button>
        </div>
      </div>
    </div>
  );
}
