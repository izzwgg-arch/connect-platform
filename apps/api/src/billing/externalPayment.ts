/**
 * External / manual payment posting.
 *
 * Hard rules:
 *  - NEVER calls the payment gateway (Cardknox/Sola).
 *  - Creates an auditable PaymentTransaction with source = "MANUAL".
 *  - Supports full and partial payments.
 *  - Marks invoice PAID or PARTIALLY_PAID (falls back to OPEN with reduced balance).
 *  - Emits BillingEventLog for every action.
 *  - Detects likely duplicate postings by reference/method/amount/date and returns a warning.
 *  - Does NOT void prior transactions — they remain as audit history.
 */

import { db } from "@connect/db";
import { logBillingEvent } from "./invoiceEngine";
import { queueReceiptEmailOnce } from "./billingEmailLifecycle";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExternalPaymentMethodType =
  | "QUICKPAY"
  | "ZELLE"
  | "CHECK"
  | "CASH"
  | "CARD_EXTERNAL"
  | "ACH_EXTERNAL"
  | "OTHER";

export type PostExternalPaymentInput = {
  invoiceId: string;
  amountCents: number;
  paymentDate: Date;
  method: ExternalPaymentMethodType;
  externalReference?: string;
  payerName?: string;
  externalNotes?: string;
  createdByUserId: string;
  /** When true, triggers a paid-invoice receipt email after posting. */
  sendReceiptEmail?: boolean;
};

export type PostExternalPaymentResult = {
  transaction: any;
  invoice: any;
  invoiceFullyPaid: boolean;
  duplicateWarning?: string;
};

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

async function checkDuplicateExternalPayment(
  tenantId: string,
  invoiceId: string,
  input: PostExternalPaymentInput,
): Promise<string | undefined> {
  if (!input.externalReference) return undefined;

  const existing = await (db as any).paymentTransaction.findFirst({
    where: {
      tenantId,
      invoiceId,
      source: "MANUAL",
      externalMethod: input.method,
      externalReference: input.externalReference,
      amountCents: input.amountCents,
    },
  });

  if (existing) {
    return `A payment with the same method, reference, and amount was already posted on ${existing.createdAt.toISOString()} (transaction ${existing.id}). Verify this is not a duplicate.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Human-readable method label for emails / logs
// ---------------------------------------------------------------------------

export function externalMethodLabel(method: ExternalPaymentMethodType): string {
  const labels: Record<ExternalPaymentMethodType, string> = {
    QUICKPAY: "QuickPay",
    ZELLE: "Zelle",
    CHECK: "Check",
    CASH: "Cash",
    CARD_EXTERNAL: "Credit/Debit Card (External)",
    ACH_EXTERNAL: "ACH / Bank Transfer (External)",
    OTHER: "Other",
  };
  return labels[method] ?? method;
}

// ---------------------------------------------------------------------------
// Core: post external payment
// ---------------------------------------------------------------------------

export async function postExternalPayment(
  input: PostExternalPaymentInput,
): Promise<PostExternalPaymentResult> {
  const invoice = await (db as any).billingInvoice.findUnique({
    where: { id: input.invoiceId },
    include: { tenant: true },
  });
  if (!invoice) {
    const err: any = new Error("INVOICE_NOT_FOUND");
    err.code = "INVOICE_NOT_FOUND";
    throw err;
  }
  if (invoice.status === "VOID") {
    const err: any = new Error("INVOICE_VOID_CANNOT_RECEIVE_PAYMENT");
    err.code = "INVOICE_VOID_CANNOT_RECEIVE_PAYMENT";
    throw err;
  }
  if (input.amountCents <= 0) {
    const err: any = new Error("EXTERNAL_PAYMENT_AMOUNT_MUST_BE_POSITIVE");
    err.code = "EXTERNAL_PAYMENT_AMOUNT_MUST_BE_POSITIVE";
    throw err;
  }

  const tenantId = invoice.tenantId;

  // Duplicate guard
  const duplicateWarning = await checkDuplicateExternalPayment(
    tenantId,
    input.invoiceId,
    input,
  );

  // Idempotency key: stable per invoice+method+reference+amount+date
  const idempotencyKey = [
    "ext",
    tenantId,
    input.invoiceId,
    input.method,
    input.externalReference ?? "noref",
    String(input.amountCents),
    input.paymentDate.toISOString().slice(0, 10),
    input.createdByUserId,
  ].join("|");

  const newAmountPaid = (invoice.amountPaidCents ?? 0) + input.amountCents;
  const newBalance = Math.max(0, invoice.totalCents - newAmountPaid);
  const invoiceFullyPaid = newBalance <= 0;

  // Create transaction + update invoice atomically
  const [transaction, updatedInvoice] = await (db as any).$transaction([
    (db as any).paymentTransaction.create({
      data: {
        tenantId,
        invoiceId: input.invoiceId,
        amountCents: input.amountCents,
        currency: invoice.currency ?? "USD",
        status: "APPROVED",
        processor: "MANUAL",
        source: "MANUAL",
        externalMethod: input.method,
        externalReference: input.externalReference ?? null,
        payerName: input.payerName ?? null,
        paymentDate: input.paymentDate,
        externalNotes: input.externalNotes ?? null,
        createdByUserId: input.createdByUserId,
        idempotencyKey,
      },
    }),
    (db as any).billingInvoice.update({
      where: { id: input.invoiceId },
      data: {
        amountPaidCents: newAmountPaid,
        balanceDueCents: newBalance,
        status: invoiceFullyPaid ? "PAID" : invoice.status,
        paidAt: invoiceFullyPaid ? (invoice.paidAt ?? new Date()) : invoice.paidAt,
        // Clear dunning when payment is posted
        metadata: invoiceFullyPaid
          ? clearDunningSliceFromMetadata(invoice.metadata)
          : invoice.metadata,
      },
    }),
  ]);

  // Audit log
  await logBillingEvent({
    tenantId,
    invoiceId: input.invoiceId,
    type: invoiceFullyPaid
      ? "invoice.external_payment_posted_paid"
      : "invoice.external_payment_posted_partial",
    message: `External payment posted via ${externalMethodLabel(input.method)}: $${(input.amountCents / 100).toFixed(2)}${input.externalReference ? ` (ref: ${input.externalReference})` : ""}`,
    metadata: {
      transactionId: transaction.id,
      amountCents: input.amountCents,
      method: input.method,
      methodLabel: externalMethodLabel(input.method),
      externalReference: input.externalReference ?? null,
      payerName: input.payerName ?? null,
      paymentDate: input.paymentDate.toISOString(),
      createdByUserId: input.createdByUserId,
      newAmountPaidCents: newAmountPaid,
      newBalanceDueCents: newBalance,
      invoiceFullyPaid,
    },
  });

  // Receipt email if fully paid and requested
  if (invoiceFullyPaid && input.sendReceiptEmail) {
    try {
      await queueReceiptEmailOnce({
        tenantId,
        invoiceId: input.invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        totalCents: invoice.totalCents,
        transactionId: transaction.id,
        cardLabel: externalMethodLabel(input.method),
        paidViaAutopay: false,
      });
    } catch (emailErr) {
      // Non-fatal: log but do not fail the payment posting
      console.error(
        "[externalPayment] receipt email queue failed",
        (emailErr as Error)?.message,
      );
    }
  }

  return {
    transaction,
    invoice: updatedInvoice,
    invoiceFullyPaid,
    duplicateWarning,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearDunningSliceFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata ?? null;
  }
  const { dunning: _dunning, ...rest } = metadata as Record<string, unknown>;
  return rest;
}
