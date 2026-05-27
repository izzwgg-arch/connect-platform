/**
 * Invoice editor — lets authorized admins mutate existing BillingInvoice rows.
 *
 * Safety rules enforced here:
 *  - VOID invoices are never editable.
 *  - PAID invoices: metadata/notes/dates can be updated but line-item changes
 *    that alter totalCents require explicit `allowPaidEdit: true` and produce an
 *    audit entry so the change is not silent.
 *  - Totals always derive from line items (never trusted from caller).
 *  - Every mutation emits a BillingEventLog row with old/new snapshot.
 */

import { db } from "@connect/db";
import { logBillingEvent } from "./invoiceEngine";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LineItemInput = {
  id?: string; // present = update existing; absent = create new
  type: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxable?: boolean;
  metadata?: Record<string, unknown>;
};

export type InvoiceMetaUpdate = {
  periodStart?: Date;
  periodEnd?: Date;
  issueDate?: Date;
  dueDate?: Date;
  notes?: string | null;
  billingEmail?: string | null;
  status?: "DRAFT" | "OPEN" | "OVERDUE";
};

export type EditInvoiceResult = {
  invoice: any;
  changed: boolean;
  totalWasAffected: boolean;
  auditEntryId?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function calcTotals(lineItems: LineItemInput[]): {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
} {
  let subtotalCents = 0;
  let taxCents = 0;

  for (const item of lineItems) {
    const amount = Math.round(item.quantity * item.unitPriceCents);
    const type = String(item.type);
    if (
      type === "SALES_TAX" ||
      type === "E911_FEE" ||
      type === "REGULATORY_FEE"
    ) {
      taxCents += amount;
    } else {
      subtotalCents += amount;
    }
  }

  return {
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
  };
}

const ALLOWED_LINE_ITEM_TYPES = new Set([
  "EXTENSION",
  "PHONE_NUMBER",
  "SMS_PACKAGE",
  "SALES_TAX",
  "E911_FEE",
  "REGULATORY_FEE",
  "CREDIT",
  "DISCOUNT",
  "MANUAL_ADJUSTMENT",
  "TRUNK",
  "DID",
  "ONE_TIME",
  "CUSTOM",
]);

function validateLineItem(item: LineItemInput): string | null {
  if (!ALLOWED_LINE_ITEM_TYPES.has(item.type)) {
    return `Unknown line item type: ${item.type}`;
  }
  if (typeof item.quantity !== "number" || !Number.isFinite(item.quantity)) {
    return "quantity must be a finite number";
  }
  if (
    typeof item.unitPriceCents !== "number" ||
    !Number.isInteger(item.unitPriceCents)
  ) {
    return "unitPriceCents must be an integer";
  }
  if (!item.description?.trim()) {
    return "description is required";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Update invoice metadata (dates, notes, status, recipient)
// ---------------------------------------------------------------------------

export async function updateInvoiceMeta(
  invoiceId: string,
  update: InvoiceMetaUpdate,
  operatorUserId: string,
  opts: { allowPaidEdit?: boolean } = {},
): Promise<any> {
  const invoice = await (db as any).billingInvoice.findUnique({
    where: { id: invoiceId },
  });
  if (!invoice) {
    const err: any = new Error("INVOICE_NOT_FOUND");
    err.code = "INVOICE_NOT_FOUND";
    throw err;
  }
  if (invoice.status === "VOID") {
    const err: any = new Error("INVOICE_VOID_NOT_EDITABLE");
    err.code = "INVOICE_VOID_NOT_EDITABLE";
    throw err;
  }
  if (invoice.status === "PAID" && !opts.allowPaidEdit) {
    const err: any = new Error("INVOICE_PAID_EDIT_REQUIRES_CONFIRMATION");
    err.code = "INVOICE_PAID_EDIT_REQUIRES_CONFIRMATION";
    err.hint =
      "Pass allowPaidEdit: true to confirm you intend to edit a paid invoice.";
    throw err;
  }

  const allowed = (
    ["periodStart", "periodEnd", "issueDate", "dueDate", "notes", "billingEmail", "status"] as const
  ).reduce<Record<string, unknown>>((acc, key) => {
    if (key in update && update[key as keyof InvoiceMetaUpdate] !== undefined) {
      acc[key] = update[key as keyof InvoiceMetaUpdate];
    }
    return acc;
  }, {});

  if (Object.keys(allowed).length === 0) return invoice;

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of Object.keys(allowed)) {
    before[key] = (invoice as any)[key];
    after[key] = allowed[key];
  }

  const updated = await (db as any).billingInvoice.update({
    where: { id: invoiceId },
    data: allowed,
  });

  await logBillingEvent({
    tenantId: invoice.tenantId,
    invoiceId,
    type: "invoice.metadata_updated",
    message: "Invoice metadata updated by admin",
    metadata: { operatorUserId, before, after },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Replace all line items and recalculate totals
// ---------------------------------------------------------------------------

export async function replaceInvoiceLineItems(
  invoiceId: string,
  lineItems: LineItemInput[],
  operatorUserId: string,
  opts: { allowPaidEdit?: boolean } = {},
): Promise<EditInvoiceResult> {
  const invoice = await (db as any).billingInvoice.findUnique({
    where: { id: invoiceId },
    include: { lineItems: true },
  });
  if (!invoice) {
    const err: any = new Error("INVOICE_NOT_FOUND");
    err.code = "INVOICE_NOT_FOUND";
    throw err;
  }
  if (invoice.status === "VOID") {
    const err: any = new Error("INVOICE_VOID_NOT_EDITABLE");
    err.code = "INVOICE_VOID_NOT_EDITABLE";
    throw err;
  }
  if (invoice.status === "PAID" && !opts.allowPaidEdit) {
    const err: any = new Error("INVOICE_PAID_EDIT_REQUIRES_CONFIRMATION");
    err.code = "INVOICE_PAID_EDIT_REQUIRES_CONFIRMATION";
    err.hint = "Pass allowPaidEdit: true to confirm editing a paid invoice.";
    throw err;
  }

  for (const item of lineItems) {
    const validationError = validateLineItem(item);
    if (validationError) {
      const err: any = new Error(`LINE_ITEM_INVALID: ${validationError}`);
      err.code = "LINE_ITEM_INVALID";
      err.detail = validationError;
      throw err;
    }
  }

  const { subtotalCents, taxCents, totalCents } = calcTotals(lineItems);
  const prevTotalCents = invoice.totalCents;
  const totalWasAffected = prevTotalCents !== totalCents;

  // For paid invoices that change the total: record balanceDue delta
  const newBalanceDueCents = Math.max(
    0,
    totalCents - (invoice.amountPaidCents ?? 0),
  );

  // Transactional replace
  const [, updated] = await (db as any).$transaction([
    (db as any).billingInvoiceLineItem.deleteMany({
      where: { invoiceId },
    }),
    (db as any).billingInvoice.update({
      where: { id: invoiceId },
      data: {
        subtotalCents,
        taxCents,
        totalCents,
        balanceDueCents: newBalanceDueCents,
        lineItems: {
          create: lineItems.map((item) => ({
            tenantId: invoice.tenantId,
            type: item.type,
            description: item.description.trim(),
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            amountCents: Math.round(item.quantity * item.unitPriceCents),
            taxable: item.taxable ?? true,
            metadata: item.metadata ?? null,
          })),
        },
      },
      include: { lineItems: true },
    }),
  ]);

  const auditEntry = await logBillingEvent({
    tenantId: invoice.tenantId,
    invoiceId,
    type: totalWasAffected
      ? "invoice.line_items_replaced_total_changed"
      : "invoice.line_items_replaced",
    message: totalWasAffected
      ? `Line items replaced; total changed from ${prevTotalCents} to ${totalCents} cents`
      : "Line items replaced (total unchanged)",
    metadata: {
      operatorUserId,
      prevTotalCents,
      newTotalCents: totalCents,
      lineItemCount: lineItems.length,
      invoicePaidStatus: invoice.status === "PAID",
    },
  });

  return {
    invoice: updated,
    changed: true,
    totalWasAffected,
    auditEntryId: auditEntry?.id,
  };
}

// ---------------------------------------------------------------------------
// Add a single line item to an existing invoice
// ---------------------------------------------------------------------------

export async function addInvoiceLineItem(
  invoiceId: string,
  item: Omit<LineItemInput, "id">,
  operatorUserId: string,
  opts: { allowPaidEdit?: boolean } = {},
): Promise<any> {
  const invoice = await (db as any).billingInvoice.findUnique({
    where: { id: invoiceId },
    include: { lineItems: true },
  });
  if (!invoice) {
    const err: any = new Error("INVOICE_NOT_FOUND");
    err.code = "INVOICE_NOT_FOUND";
    throw err;
  }
  if (invoice.status === "VOID") {
    const err: any = new Error("INVOICE_VOID_NOT_EDITABLE");
    err.code = "INVOICE_VOID_NOT_EDITABLE";
    throw err;
  }
  if (invoice.status === "PAID" && !opts.allowPaidEdit) {
    const err: any = new Error("INVOICE_PAID_EDIT_REQUIRES_CONFIRMATION");
    err.code = "INVOICE_PAID_EDIT_REQUIRES_CONFIRMATION";
    throw err;
  }

  const validationError = validateLineItem(item as LineItemInput);
  if (validationError) {
    const err: any = new Error(`LINE_ITEM_INVALID: ${validationError}`);
    err.code = "LINE_ITEM_INVALID";
    throw err;
  }

  const amountCents = Math.round(item.quantity * item.unitPriceCents);

  const allLineItems: LineItemInput[] = [
    ...invoice.lineItems.map((li: any) => ({
      type: li.type,
      description: li.description,
      quantity: li.quantity,
      unitPriceCents: li.unitPriceCents,
      taxable: li.taxable,
      metadata: li.metadata,
    })),
    item as LineItemInput,
  ];
  const { subtotalCents, taxCents, totalCents } = calcTotals(allLineItems);

  const [newLine, updatedInvoice] = await (db as any).$transaction([
    (db as any).billingInvoiceLineItem.create({
      data: {
        invoiceId,
        tenantId: invoice.tenantId,
        type: item.type,
        description: item.description.trim(),
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        amountCents,
        taxable: item.taxable ?? true,
        metadata: item.metadata ?? null,
      },
    }),
    (db as any).billingInvoice.update({
      where: { id: invoiceId },
      data: {
        subtotalCents,
        taxCents,
        totalCents,
        balanceDueCents: Math.max(0, totalCents - (invoice.amountPaidCents ?? 0)),
      },
    }),
  ]);

  await logBillingEvent({
    tenantId: invoice.tenantId,
    invoiceId,
    type: "invoice.line_item_added",
    message: `Line item added: "${item.description}" (${item.type})`,
    metadata: { operatorUserId, amountCents, newTotalCents: totalCents },
  });

  return { lineItem: newLine, invoice: updatedInvoice };
}

// ---------------------------------------------------------------------------
// Delete a single line item
// ---------------------------------------------------------------------------

export async function deleteInvoiceLineItem(
  invoiceId: string,
  lineItemId: string,
  operatorUserId: string,
  opts: { allowPaidEdit?: boolean } = {},
): Promise<any> {
  const invoice = await (db as any).billingInvoice.findUnique({
    where: { id: invoiceId },
    include: { lineItems: true },
  });
  if (!invoice) {
    const err: any = new Error("INVOICE_NOT_FOUND");
    err.code = "INVOICE_NOT_FOUND";
    throw err;
  }
  if (invoice.status === "VOID") {
    const err: any = new Error("INVOICE_VOID_NOT_EDITABLE");
    err.code = "INVOICE_VOID_NOT_EDITABLE";
    throw err;
  }
  if (invoice.status === "PAID" && !opts.allowPaidEdit) {
    const err: any = new Error("INVOICE_PAID_EDIT_REQUIRES_CONFIRMATION");
    err.code = "INVOICE_PAID_EDIT_REQUIRES_CONFIRMATION";
    throw err;
  }

  const line = invoice.lineItems.find((li: any) => li.id === lineItemId);
  if (!line) {
    const err: any = new Error("LINE_ITEM_NOT_FOUND");
    err.code = "LINE_ITEM_NOT_FOUND";
    throw err;
  }

  const remainingItems: LineItemInput[] = invoice.lineItems
    .filter((li: any) => li.id !== lineItemId)
    .map((li: any) => ({
      type: li.type,
      description: li.description,
      quantity: li.quantity,
      unitPriceCents: li.unitPriceCents,
      taxable: li.taxable,
    }));

  const { subtotalCents, taxCents, totalCents } = calcTotals(remainingItems);

  await (db as any).$transaction([
    (db as any).billingInvoiceLineItem.delete({ where: { id: lineItemId } }),
    (db as any).billingInvoice.update({
      where: { id: invoiceId },
      data: {
        subtotalCents,
        taxCents,
        totalCents,
        balanceDueCents: Math.max(0, totalCents - (invoice.amountPaidCents ?? 0)),
      },
    }),
  ]);

  await logBillingEvent({
    tenantId: invoice.tenantId,
    invoiceId,
    type: "invoice.line_item_deleted",
    message: `Line item removed: "${line.description}" (${line.type})`,
    metadata: { operatorUserId, removedAmountCents: line.amountCents, newTotalCents: totalCents },
  });

  return { deleted: true, lineItemId, newTotalCents: totalCents };
}

// ---------------------------------------------------------------------------
// Create a fully manual invoice (SUPER_ADMIN or BILLING_ADMIN only)
// ---------------------------------------------------------------------------

export type ManualInvoiceInput = {
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
  issueDate?: Date;
  dueDate: Date;
  lineItems: Omit<LineItemInput, "id">[];
  notes?: string;
  billingEmail?: string;
  status?: "DRAFT" | "OPEN";
  createdByUserId: string;
};

export async function createManualInvoice(
  input: ManualInvoiceInput,
  createRowFn: (invoiceNumber: string) => Promise<any>,
): Promise<any> {
  for (const item of input.lineItems) {
    const err = validateLineItem(item as LineItemInput);
    if (err) {
      const e: any = new Error(`LINE_ITEM_INVALID: ${err}`);
      e.code = "LINE_ITEM_INVALID";
      throw e;
    }
  }

  const { subtotalCents, taxCents, totalCents } = calcTotals(
    input.lineItems as LineItemInput[],
  );

  return createRowFn(
    JSON.stringify({
      tenantId: input.tenantId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      issueDate: input.issueDate ?? new Date(),
      dueDate: input.dueDate,
      subtotalCents,
      taxCents,
      totalCents,
      balanceDueCents: totalCents,
      amountPaidCents: 0,
      notes: input.notes ?? null,
      billingEmail: input.billingEmail ?? null,
      status: input.status ?? "OPEN",
      source: "MANUAL",
      createdByUserId: input.createdByUserId,
      lineItems: input.lineItems,
    }),
  );
}
