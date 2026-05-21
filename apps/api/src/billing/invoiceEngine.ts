import { db } from "@connect/db";
import { calculateTenantBillingUsage, type BillingUsageSnapshot } from "./usage";
import { clearDunningSlice } from "./billingDunning";
import { queueInvoiceSentOnFinalize } from "./billingEmailLifecycle";
import type { TaxCalculationAuditSnapshot } from "./taxProvider";
import { resolveTaxProvider } from "./taxProvider";
import type { BillingPricingResolution } from "./billingPricingResolution";
import { activeBillingPlanRowForPeriod, parseBillingPricingMode, resolveTenantBillingPricing } from "./billingPricingResolution";
import { buildExtensionInvoiceLine } from "./billingFlatRate";
import { resolveBillingQuantities, type BillingResolvedQuantities } from "./billingQuantityOverrides";
import { resolveTollFreeDidPriceCents } from "./billingTollFreePricing";
import { buildPricingPreviewExplanation, type PricingPreviewExplanation } from "./billingPricingExplanation";
import { addBillingDays, billingMonthBounds, billingYearMonth } from "./billingTime";

export type BillingInvoicePreview = {
  tenantId: string;
  invoiceNumber?: string;
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
  usage: BillingUsageSnapshot;
  /** Suggested vs billing quantities (manual overrides from metadata). */
  billingQuantities?: BillingResolvedQuantities;
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
  /** Sum of taxable-flagged service line items (before taxes). Used by portal tax estimate. */
  taxableSubtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Persisted on invoice `metadata.taxCalculationAudit` at creation. */
  taxCalculationAudit: TaxCalculationAuditSnapshot;
  /**
   * Present when a plan change is scheduled and this preview's periodStart
   * is on or after the effective date — meaning the preview already reflects
   * the new plan's prices.
   */
  scheduledPlanChange?: {
    planId: string;
    planName: string;
    effectiveAt: Date;
  };
  /** Resolved pricing mode + badges for portal / admins (never SOLA payloads). */
  pricingResolution?: BillingPricingResolution;
  /** Structured operator explanation for this preview (computed from resolution + schedule; no pricing math). */
  pricingPreviewExplanation?: PricingPreviewExplanation;
};

export function monthBounds(anchor = new Date()): { periodStart: Date; periodEnd: Date } {
  return billingMonthBounds(anchor);
}

export function addDays(date: Date, days: number): Date {
  return addBillingDays(date, days);
}

export async function ensureTenantBillingSettings(tenantId: string) {
  return (db as any).tenantBillingSettings.upsert({
    where: { tenantId },
    create: { tenantId },
    update: {},
    include: { taxProfile: true, billingPlan: true, nextBillingPlan: true, defaultPaymentMethod: true },
  });
}

export type TenantBillingSettingsLoaded = Awaited<ReturnType<typeof ensureTenantBillingSettings>>;

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

async function buildBillingInvoicePreviewWithLoadedSettings(input: {
  tenantId: string;
  settings: TenantBillingSettingsLoaded;
  periodStart?: Date;
  periodEnd?: Date;
  dueDate?: Date;
}): Promise<BillingInvoicePreview> {
  const { tenantId, settings } = input;
  const bounds = input.periodStart && input.periodEnd ? { periodStart: input.periodStart, periodEnd: input.periodEnd } : monthBounds();
  const dueDate = input.dueDate || addDays(new Date(), Number(settings.paymentTermsDays || 15));

  const hasScheduledChange =
    settings.nextBillingPlanId &&
    settings.nextBillingPlanEffectiveAt &&
    bounds.periodStart >= settings.nextBillingPlanEffectiveAt;
  const activePlan = activeBillingPlanRowForPeriod(settings, bounds.periodStart);

  const pricingMode = parseBillingPricingMode(settings.metadata);
  const pricingResolution = resolveTenantBillingPricing({
    mode: pricingMode,
    settings: {
      extensionPriceCents: Number(settings.extensionPriceCents),
      additionalPhoneNumberPriceCents: Number(settings.additionalPhoneNumberPriceCents),
      smsPriceCents: Number(settings.smsPriceCents),
      firstPhoneNumberFree: settings.firstPhoneNumberFree,
    },
    activePlan,
  });

  const usage = await calculateTenantBillingUsage(tenantId, {
    firstPhoneNumberFree: pricingResolution.firstPhoneNumberFree,
    smsBillingEnabled: settings.smsBillingEnabled,
  });

  const billingQuantities = resolveBillingQuantities({
    usage,
    metadata: settings.metadata,
    firstPhoneNumberFree: pricingResolution.firstPhoneNumberFree,
  });

  const extensionPrice = pricingResolution.extensionPriceCents;
  const localDidPrice = pricingResolution.additionalPhoneNumberPriceCents;
  const tollFreeDidPrice = resolveTollFreeDidPriceCents(settings.metadata, localDidPrice);
  const smsPrice = pricingResolution.smsPriceCents;
  const effectiveFirstFree = pricingResolution.firstPhoneNumberFree;

  const lineItems: BillingInvoicePreview["lineItems"] = [];
  const extensionLine = buildExtensionInvoiceLine({
    usage,
    extensionBillableCount: billingQuantities.billing.extensions,
    extensionPriceCents: extensionPrice,
    metadata: settings.metadata,
  });
  if (extensionLine) lineItems.push(extensionLine);
  if (billingQuantities.billing.virtualExtensions > 0) {
    const qty = billingQuantities.billing.virtualExtensions;
    lineItems.push({
      type: "EXTENSION",
      description: "Virtual extensions",
      quantity: qty,
      unitPriceCents: extensionPrice,
      amountCents: qty * extensionPrice,
      taxable: true,
      metadata: {
        lineItemKind: "virtual_extensions",
        suggestedVirtualExtensionCount: billingQuantities.suggested.virtualExtensions,
        quantityMode: billingQuantities.modes.virtualExtensions,
      },
    });
  }
  if (billingQuantities.billing.phoneNumbers > 0) {
    const qty = billingQuantities.billing.phoneNumbers;
    lineItems.push({
      type: "PHONE_NUMBER",
      description:
        effectiveFirstFree === false ? "Local phone numbers" : "Local phone numbers (additional)",
      quantity: qty,
      unitPriceCents: localDidPrice,
      amountCents: qty * localDidPrice,
      taxable: true,
      metadata: {
        lineItemKind: "local_phone_numbers",
        phoneNumberIds: usage.localPhoneNumberIds,
        firstFree: effectiveFirstFree,
        suggestedBillableCount: billingQuantities.suggested.phoneNumbersBillable,
        localPhoneNumbersTotal: billingQuantities.suggested.phoneNumbersTotal,
        quantityMode: billingQuantities.modes.phoneNumbers,
      },
    });
  }
  if (billingQuantities.billing.tollFreeNumbers > 0) {
    const qty = billingQuantities.billing.tollFreeNumbers;
    lineItems.push({
      type: "PHONE_NUMBER",
      description: "Toll-free phone numbers",
      quantity: qty,
      unitPriceCents: tollFreeDidPrice,
      amountCents: qty * tollFreeDidPrice,
      taxable: true,
      metadata: {
        lineItemKind: "toll_free_phone_numbers",
        phoneNumberIds: usage.tollFreePhoneNumberIds,
        suggestedBillableCount: billingQuantities.suggested.tollFreeNumbersBillable,
        tollFreeNumbersTotal: billingQuantities.suggested.tollFreeNumbersTotal,
        quantityMode: billingQuantities.modes.tollFreeNumbers,
      },
    });
  }
  if (billingQuantities.billing.smsPackages > 0) {
    const qty = billingQuantities.billing.smsPackages;
    lineItems.push({
      type: "SMS_PACKAGE",
      description: "SMS package",
      quantity: qty,
      unitPriceCents: smsPrice,
      amountCents: qty * smsPrice,
      taxable: true,
      metadata: {
        suggestedSmsPackages: billingQuantities.suggested.smsPackages,
        quantityMode: billingQuantities.modes.smsPackages,
      },
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

  const discountPercent = Number(settings.discountPercent || 0);
  if (discountPercent > 0) {
    const serviceChargeCents = lineItems
      .filter((item) => item.type !== "CREDIT")
      .reduce((sum, item) => sum + item.amountCents, 0);
    if (serviceChargeCents > 0) {
      const discountCents = -Math.round(serviceChargeCents * discountPercent);
      const pct = (discountPercent * 100).toFixed(2).replace(/\.?0+$/, "");
      lineItems.push({
        type: "DISCOUNT",
        description: `Discount (${pct}%)`,
        quantity: 1,
        unitPriceCents: discountCents,
        amountCents: discountCents,
        taxable: true,
      });
    }
  }

  const subtotalCents = lineItems.reduce((sum, item) => sum + item.amountCents, 0);
  const taxableSubtotalCents = lineItems.filter((item) => item.taxable).reduce((sum, item) => sum + item.amountCents, 0);
  const taxProvider = resolveTaxProvider(settings);
  const taxResult = taxProvider.calculateTaxes({
    tenantId,
    taxEnabled: !!settings.taxEnabled,
    taxProfile: settings.taxProfile || null,
    taxProfileId: settings.taxProfileId || null,
    taxableSubtotalCents,
    extensionCount: billingQuantities.billing.extensions,
  });
  for (const line of taxResult.lines) {
    lineItems.push({
      type: line.type,
      description: line.description,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      amountCents: line.amountCents,
      taxable: line.taxable,
      metadata: line.metadata,
    });
  }
  const taxCents = taxResult.lines.reduce((sum, item) => sum + item.amountCents, 0);
  const totalCents = Math.max(0, subtotalCents + taxCents);

  const scheduledPlanChange: BillingInvoicePreview["scheduledPlanChange"] =
    hasScheduledChange && settings.nextBillingPlan
      ? {
          planId: settings.nextBillingPlanId as string,
          planName: settings.nextBillingPlan.name as string,
          effectiveAt: settings.nextBillingPlanEffectiveAt as Date,
        }
      : undefined;

  const pricingPreviewExplanation = buildPricingPreviewExplanation({
    pricingMode,
    pricingResolution,
    tenantPricing: {
      extensionPriceCents: Number(settings.extensionPriceCents),
      additionalPhoneNumberPriceCents: Number(settings.additionalPhoneNumberPriceCents),
      smsPriceCents: Number(settings.smsPriceCents),
      firstPhoneNumberFree: settings.firstPhoneNumberFree,
    },
    hasScheduledChange,
    scheduledPlanChange,
    activePlanForPreview: activePlan,
  });

  return {
    tenantId,
    periodStart: bounds.periodStart,
    periodEnd: bounds.periodEnd,
    dueDate,
    usage,
    billingQuantities,
    lineItems,
    subtotalCents,
    taxableSubtotalCents,
    taxCents,
    totalCents,
    taxCalculationAudit: taxResult.audit,
    ...(scheduledPlanChange ? { scheduledPlanChange } : {}),
    pricingResolution,
    pricingPreviewExplanation,
  };
}

export async function buildBillingInvoicePreview(input: {
  tenantId: string;
  periodStart?: Date;
  periodEnd?: Date;
  dueDate?: Date;
}): Promise<BillingInvoicePreview> {
  const settings = await ensureTenantBillingSettings(input.tenantId);
  return buildBillingInvoicePreviewWithLoadedSettings({
    tenantId: input.tenantId,
    settings,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    dueDate: input.dueDate,
  });
}

/** Same math as `buildBillingInvoicePreview`, but uses an in-memory settings snapshot (e.g. assign-plan simulation). */
export async function buildBillingInvoicePreviewFromSettings(input: {
  tenantId: string;
  settings: TenantBillingSettingsLoaded;
  periodStart?: Date;
  periodEnd?: Date;
  dueDate?: Date;
}): Promise<BillingInvoicePreview> {
  return buildBillingInvoicePreviewWithLoadedSettings(input);
}

export async function createBillingInvoice(input: {
  tenantId: string;
  periodStart?: Date;
  periodEnd?: Date;
  dueDate?: Date;
  status?: "DRAFT" | "OPEN";
  /** Merged into `BillingEventLog` row for `invoice_created` (e.g. `{ source: "worker_monthly" }`). */
  invoiceCreatedEventMetadata?: Record<string, unknown>;
}): Promise<any> {
  const preview = await buildBillingInvoicePreview(input);
  const invoice = await createBillingInvoiceRowWithUniqueNumber(input.tenantId, async (invoiceNumber) =>
    (db as any).billingInvoice.create({
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
        metadata: { taxCalculationAudit: preview.taxCalculationAudit },
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
    }),
  );
  const invoiceNumber = invoice.invoiceNumber;
  await logBillingEvent({
    tenantId: input.tenantId,
    invoiceId: invoice.id,
    type: "invoice_created",
    metadata: { invoiceNumber, ...(input.invoiceCreatedEventMetadata || {}) },
  });
  await queueInvoiceSentOnFinalize({
    id: invoice.id,
    tenantId: invoice.tenantId,
    invoiceNumber: invoice.invoiceNumber,
    totalCents: invoice.totalCents,
    balanceDueCents: invoice.balanceDueCents,
    dueDate: invoice.dueDate,
    periodStart: invoice.periodStart ?? null,
    periodEnd: invoice.periodEnd ?? null,
  }).catch(() => null);
  return invoice;
}

export async function markBillingInvoicePaid(invoiceId: string, amountCents?: number): Promise<any> {
  const invoice = await (db as any).billingInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("BILLING_INVOICE_NOT_FOUND");
  const paid = amountCents ?? invoice.totalCents;
  if (paid < invoice.totalCents) {
    const err: any = new Error("PARTIAL_PAYMENT_NOT_SUPPORTED");
    err.code = "PARTIAL_PAYMENT_NOT_SUPPORTED";
    err.hint = "Partial mark-paid is not supported yet. Pass the full remaining balance or wait for PARTIALLY_PAID support.";
    throw err;
  }
  const updated = await (db as any).billingInvoice.update({
    where: { id: invoiceId },
    data: {
      status: "PAID",
      amountPaidCents: paid,
      balanceDueCents: Math.max(0, invoice.totalCents - paid),
      paidAt: new Date(),
      failedAt: null,
      metadata: clearDunningSlice(invoice.metadata),
    },
  });
  await logBillingEvent({ tenantId: invoice.tenantId, invoiceId, type: "invoice.paid", metadata: { amountCents: paid } });
  return updated;
}

/** `BillingInvoice.invoiceNumber` is globally unique — sequence per month prefix across all tenants. */
export function billingInvoiceNumberPrefix(at = new Date()): string {
  const { year, month } = billingYearMonth(at);
  return `CC-${year}${String(month).padStart(2, "0")}`;
}

/** Next 5-digit sequence after the latest invoice for this prefix (fixed-width → lex order = numeric). */
export function nextInvoiceSequenceAfter(latestInvoiceNumber: string | null | undefined, prefix: string): number {
  if (!latestInvoiceNumber?.startsWith(`${prefix}-`)) return 1;
  const tail = latestInvoiceNumber.slice(prefix.length + 1);
  if (!/^\d{5}$/.test(tail)) return 1;
  const n = Number.parseInt(tail, 10);
  return Number.isFinite(n) && n >= 0 ? n + 1 : 1;
}

async function nextInvoiceNumber(_tenantId: string): Promise<string> {
  const prefix = billingInvoiceNumberPrefix();
  const latest = await (db as any).billingInvoice.findFirst({
    where: { invoiceNumber: { startsWith: `${prefix}-` } },
    orderBy: { invoiceNumber: "desc" },
    select: { invoiceNumber: true },
  });
  const seq = nextInvoiceSequenceAfter(latest?.invoiceNumber, prefix);
  return `${prefix}-${String(seq).padStart(5, "0")}`;
}

function isInvoiceNumberUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: string[] | string } };
  if (e?.code !== "P2002") return false;
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.includes("invoiceNumber");
  return String(target || "").includes("invoiceNumber");
}

async function createBillingInvoiceRowWithUniqueNumber<T extends { invoiceNumber: string }>(
  tenantId: string,
  createRow: (invoiceNumber: string) => Promise<T>,
): Promise<T> {
  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const invoiceNumber = await nextInvoiceNumber(tenantId);
    try {
      return await createRow(invoiceNumber);
    } catch (err) {
      if (isInvoiceNumberUniqueViolation(err) && attempt < maxAttempts - 1) continue;
      if (isInvoiceNumberUniqueViolation(err)) {
        const conflict: any = new Error("INVOICE_NUMBER_CONFLICT");
        conflict.code = "INVOICE_NUMBER_CONFLICT";
        throw conflict;
      }
      throw err;
    }
  }
  const exhausted: any = new Error("INVOICE_NUMBER_EXHAUSTED");
  exhausted.code = "INVOICE_NUMBER_EXHAUSTED";
  throw exhausted;
}

/**
 * Operator one-time charge: OPEN invoice with a single MANUAL_ADJUSTMENT line at the
 * requested amount. Does not run usage preview or tax profile math.
 */
export async function createOneTimeChargeInvoice(input: {
  tenantId: string;
  description: string;
  amountCents: number;
  operatorNote?: string | null;
  invoiceMemo?: string | null;
  adminUserId?: string | null;
}): Promise<any> {
  if (input.amountCents < 1) {
    const err: any = new Error("INVALID_AMOUNT");
    err.code = "INVALID_AMOUNT";
    throw err;
  }
  const settings = await (db as any).tenantBillingSettings.findUnique({ where: { tenantId: input.tenantId } });
  const termsDays = Number(settings?.paymentTermsDays ?? 15);
  const now = new Date();
  const dueDate = addBillingDays(now, termsDays);

  const metadata: Record<string, unknown> = {
    source: "one_time_charge",
    ...(input.invoiceMemo ? { operatorMemo: input.invoiceMemo } : {}),
    ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    ...(input.adminUserId ? { createdByAdminUserId: input.adminUserId } : {}),
  };

  const invoice = await createBillingInvoiceRowWithUniqueNumber(input.tenantId, async (invoiceNumber) =>
    (db as any).billingInvoice.create({
      data: {
        tenantId: input.tenantId,
        invoiceNumber,
        status: "OPEN",
        periodStart: now,
        periodEnd: now,
        dueDate,
        subtotalCents: input.amountCents,
        taxCents: 0,
        totalCents: input.amountCents,
        balanceDueCents: input.amountCents,
        metadata,
        lineItems: {
          create: [{
            tenantId: input.tenantId,
            type: "MANUAL_ADJUSTMENT",
            description: input.description.trim(),
            quantity: 1,
            unitPriceCents: input.amountCents,
            amountCents: input.amountCents,
            taxable: false,
          }],
        },
      },
      include: { lineItems: true, tenant: true },
    }),
  );
  const invoiceNumber = invoice.invoiceNumber;

  await logBillingEvent({
    tenantId: input.tenantId,
    invoiceId: invoice.id,
    type: "invoice.one_time_created",
    message: input.operatorNote || `One-time charge invoice ${invoiceNumber}`,
    metadata: { invoiceNumber, amountCents: input.amountCents, description: input.description },
  });

  return invoice;
}
