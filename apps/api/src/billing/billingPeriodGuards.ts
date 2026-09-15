import { db } from "@connect/db";

type PaidCoverageInput = {
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
  excludeInvoiceId?: string | null;
  dbOverride?: any;
};

export type PaidBillingPeriodCoverage = {
  invoiceId: string;
  invoiceNumber: string | null;
  reason: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() <= bEnd.getTime() && aEnd.getTime() >= bStart.getTime();
}

function isPaid(invoice: any): boolean {
  const balanceDue = Math.max(0, Number(invoice?.balanceDueCents ?? 0) || 0);
  return invoice?.status === "PAID" && balanceDue <= 0;
}

function oneTimeMonthlyServiceText(invoice: any): boolean {
  const invoiceMeta = asRecord(invoice?.metadata);
  const parts = [
    invoiceMeta.description,
    invoiceMeta.operatorMemo,
    invoiceMeta.operatorNote,
    ...(Array.isArray(invoice?.lineItems) ? invoice.lineItems.map((item: any) => item?.description) : []),
  ];
  return parts.some((part) => /monthly\s+service|service\s+balance/i.test(String(part || "")));
}

function invoicePeriodOverlaps(invoice: any, periodStart: Date, periodEnd: Date): boolean {
  const start = parseDate(invoice?.periodStart);
  const end = parseDate(invoice?.periodEnd);
  return !!start && !!end && overlaps(start, end, periodStart, periodEnd);
}

function lineServicePeriodOverlaps(invoice: any, periodStart: Date, periodEnd: Date): boolean {
  if (!Array.isArray(invoice?.lineItems)) return false;
  return invoice.lineItems.some((item: any) => {
    const meta = asRecord(item?.metadata);
    const start = parseDate(meta.servicePeriodStart);
    const end = parseDate(meta.servicePeriodEnd);
    return !!start && !!end && overlaps(start, end, periodStart, periodEnd);
  });
}

function coverageReason(invoice: any, periodStart: Date, periodEnd: Date): string | null {
  const meta = asRecord(invoice?.metadata);
  const source = String(meta.source || "");
  const monthlyServiceAdjustment = source === "one_time_charge" && oneTimeMonthlyServiceText(invoice);

  if (invoicePeriodOverlaps(invoice, periodStart, periodEnd)) {
    if (source !== "one_time_charge") return "paid_invoice_period_overlap";
    if (monthlyServiceAdjustment) return "paid_monthly_service_adjustment_period_overlap";
  }
  if (lineServicePeriodOverlaps(invoice, periodStart, periodEnd)) {
    if (source !== "one_time_charge") return "paid_invoice_line_service_period_overlap";
    if (monthlyServiceAdjustment) return "paid_monthly_service_adjustment_line_period_overlap";
  }
  return null;
}

/**
 * The mirror of coverageReason()'s one_time_charge carve-out, applied to the
 * invoice being CHARGED: an additive one-time/manual invoice (hardware, a
 * service call) does not bill a service period, so a paid cycle invoice
 * covering its date is not a double charge and must not block it. A one-time
 * invoice whose text says "monthly service" / "service balance" REPLACES a
 * cycle charge and stays guarded. Same rule autopayCycle.ts applies at
 * selection ("a custom invoice must be purely additive").
 */
export async function isAdditiveOneTimeInvoice(invoice: any, dbOverride?: any): Promise<boolean> {
  const meta = asRecord(invoice?.metadata);
  const source = String(meta.source || "");
  const additive = source === "one_time_charge" || source === "manual_invoice" || invoice?.source === "MANUAL";
  if (!additive) return false;
  const _db = dbOverride ?? db;
  const lineItems = Array.isArray(invoice?.lineItems)
    ? invoice.lineItems
    : typeof (_db as any).billingInvoiceLineItem?.findMany === "function"
      ? await (_db as any).billingInvoiceLineItem.findMany({ where: { invoiceId: invoice.id } })
      : [];
  return !oneTimeMonthlyServiceText({ ...invoice, lineItems });
}

export async function findPaidBillingPeriodCoverage(input: PaidCoverageInput): Promise<PaidBillingPeriodCoverage | null> {
  const _db = input.dbOverride ?? db;
  if (typeof (_db as any).billingInvoice?.findMany !== "function") return null;
  const rows = await (_db as any).billingInvoice.findMany({
    where: {
      tenantId: input.tenantId,
      status: "PAID",
      ...(input.excludeInvoiceId ? { id: { not: input.excludeInvoiceId } } : {}),
    },
    include: { lineItems: true },
    orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
    take: 100,
  });

  for (const invoice of rows) {
    if (!isPaid(invoice)) continue;
    const reason = coverageReason(invoice, input.periodStart, input.periodEnd);
    if (!reason) continue;
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber ?? null,
      reason,
    };
  }
  return null;
}

export function billingPeriodAlreadyPaidError(coverage: PaidBillingPeriodCoverage): Error {
  const err: Error & { code?: string; paidInvoiceId?: string; paidInvoiceNumber?: string | null; reason?: string } =
    new Error("BILLING_PERIOD_ALREADY_PAID");
  err.code = "BILLING_PERIOD_ALREADY_PAID";
  err.paidInvoiceId = coverage.invoiceId;
  err.paidInvoiceNumber = coverage.invoiceNumber;
  err.reason = coverage.reason;
  return err;
}
