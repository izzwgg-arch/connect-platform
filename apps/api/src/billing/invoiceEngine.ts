import { db } from "@connect/db";
import { calculateTaxLines } from "./taxes";
import { calculateTenantBillingUsage, type BillingUsageSnapshot } from "./usage";

export type BillingInvoicePreview = {
  tenantId: string;
  invoiceNumber?: string;
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
  usage: BillingUsageSnapshot;
  lineItems: Array<{
    type: string;
    description: string;
    quantity: number;
    unitPriceCents: number;
    amountCents: number;
    taxable: boolean;
    metadata?: Record<string, unknown>;
  }>;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};

export function monthBounds(anchor = new Date()): { periodStart: Date; periodEnd: Date } {
  const periodStart = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  return { periodStart, periodEnd };
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

export async function ensureTenantBillingSettings(tenantId: string) {
  return (db as any).tenantBillingSettings.upsert({
    where: { tenantId },
    create: { tenantId },
    update: {},
    include: { taxProfile: true, billingPlan: true, defaultPaymentMethod: true },
  });
}

export async function logBillingEvent(input: {
  tenantId: string;
  invoiceId?: string | null;
  runId?: string | null;
  type: string;
  message?: string;
  metadata?: Record<string, unknown>;
}) {
  return (db as any).billingEventLog.create({
    data: {
      tenantId: input.tenantId,
      invoiceId: input.invoiceId || null,
      runId: input.runId || null,
      type: input.type,
      message: input.message || null,
      metadata: input.metadata || undefined,
    },
  });
}

export async function buildBillingInvoicePreview(input: {
  tenantId: string;
  periodStart?: Date;
  periodEnd?: Date;
  dueDate?: Date;
}): Promise<BillingInvoicePreview> {
  const settings = await ensureTenantBillingSettings(input.tenantId);
  const bounds = input.periodStart && input.periodEnd ? { periodStart: input.periodStart, periodEnd: input.periodEnd } : monthBounds();
  const dueDate = input.dueDate || addDays(new Date(), Number(settings.paymentTermsDays || 15));
  const usage = await calculateTenantBillingUsage(input.tenantId, settings);

  const extensionPrice = Number(settings.extensionPriceCents || settings.billingPlan?.extensionPriceCents || 3000);
  const numberPrice = Number(settings.additionalPhoneNumberPriceCents || settings.billingPlan?.additionalPhoneNumberPriceCents || 1000);
  const smsPrice = Number(settings.smsPriceCents || settings.billingPlan?.smsPriceCents || 1000);

  const lineItems: BillingInvoicePreview["lineItems"] = [];
  if (usage.extensionCount > 0) {
    lineItems.push({
      type: "EXTENSION",
      description: "Billable extensions",
      quantity: usage.extensionCount,
      unitPriceCents: extensionPrice,
      amountCents: usage.extensionCount * extensionPrice,
      taxable: true,
      metadata: { extensionIds: usage.extensionIds },
    });
  }
  if (usage.additionalPhoneNumberCount > 0) {
    lineItems.push({
      type: "PHONE_NUMBER",
      description: settings.firstPhoneNumberFree === false ? "Tenant phone numbers" : "Additional phone numbers",
      quantity: usage.additionalPhoneNumberCount,
      unitPriceCents: numberPrice,
      amountCents: usage.additionalPhoneNumberCount * numberPrice,
      taxable: true,
      metadata: { phoneNumberIds: usage.phoneNumberIds, firstFree: settings.firstPhoneNumberFree !== false },
    });
  }
  if (usage.smsEnabled) {
    lineItems.push({
      type: "SMS_PACKAGE",
      description: "SMS package",
      quantity: 1,
      unitPriceCents: smsPrice,
      amountCents: smsPrice,
      taxable: true,
    });
  }
  if (Number(settings.creditsCents || 0) > 0) {
    const credit = -Math.abs(Number(settings.creditsCents));
    lineItems.push({
      type: "CREDIT",
      description: "Account credit",
      quantity: 1,
      unitPriceCents: credit,
      amountCents: credit,
      taxable: false,
    });
  }

  const subtotalCents = lineItems.reduce((sum, item) => sum + item.amountCents, 0);
  const taxableSubtotalCents = lineItems.filter((item) => item.taxable).reduce((sum, item) => sum + item.amountCents, 0);
  const taxLines = calculateTaxLines({
    taxEnabled: !!settings.taxEnabled,
    taxProfile: settings.taxProfile,
    taxableSubtotalCents,
    extensionCount: usage.extensionCount,
  });
  for (const line of taxLines) lineItems.push(line);
  const taxCents = taxLines.reduce((sum, item) => sum + item.amountCents, 0);
  const totalCents = Math.max(0, subtotalCents + taxCents);

  return {
    tenantId: input.tenantId,
    periodStart: bounds.periodStart,
    periodEnd: bounds.periodEnd,
    dueDate,
    usage,
    lineItems,
    subtotalCents,
    taxCents,
    totalCents,
  };
}

export async function createBillingInvoice(input: {
  tenantId: string;
  periodStart?: Date;
  periodEnd?: Date;
  dueDate?: Date;
  status?: "DRAFT" | "OPEN";
}): Promise<any> {
  const preview = await buildBillingInvoicePreview(input);
  const invoiceNumber = await nextInvoiceNumber(input.tenantId);
  const invoice = await (db as any).billingInvoice.create({
    data: {
      tenantId: input.tenantId,
      invoiceNumber,
      status: input.status || "OPEN",
      periodStart: preview.periodStart,
      periodEnd: preview.periodEnd,
      dueDate: preview.dueDate,
      subtotalCents: preview.subtotalCents,
      taxCents: preview.taxCents,
      totalCents: preview.totalCents,
      balanceDueCents: preview.totalCents,
      lineItems: {
        create: preview.lineItems.map((item) => ({
          tenantId: input.tenantId,
          type: item.type,
          description: item.description,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          amountCents: item.amountCents,
          taxable: item.taxable,
          metadata: item.metadata,
        })),
      },
    },
    include: { lineItems: true, tenant: true },
  });
  await logBillingEvent({ tenantId: input.tenantId, invoiceId: invoice.id, type: "invoice.created", metadata: { invoiceNumber } });
  return invoice;
}

export async function markBillingInvoicePaid(invoiceId: string, amountCents?: number): Promise<any> {
  const invoice = await (db as any).billingInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("BILLING_INVOICE_NOT_FOUND");
  const paid = amountCents ?? invoice.totalCents;
  const updated = await (db as any).billingInvoice.update({
    where: { id: invoiceId },
    data: {
      status: "PAID",
      amountPaidCents: paid,
      balanceDueCents: Math.max(0, invoice.totalCents - paid),
      paidAt: new Date(),
      failedAt: null,
    },
  });
  await logBillingEvent({ tenantId: invoice.tenantId, invoiceId, type: "invoice.paid", metadata: { amountCents: paid } });
  return updated;
}

async function nextInvoiceNumber(tenantId: string): Promise<string> {
  const prefix = `CC-${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
  const count = await (db as any).billingInvoice.count({ where: { tenantId, invoiceNumber: { startsWith: prefix } } });
  return `${prefix}-${String(count + 1).padStart(5, "0")}`;
}
