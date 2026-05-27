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
import { buildBillingTelecomFeeLines, parseBillingTelecomFees } from "./billingTelecomFees";
import { buildBillingSchedule } from "./billingSchedule";
import { billingPeriodAlreadyPaidError, findPaidBillingPeriodCoverage } from "./billingPeriodGuards";

const BILLING_TELECOM_FEES_PROVIDER_ID = "billing_telecom_fees_v1";
const BILLING_TELECOM_FEES_PROVIDER_VERSION = "1.0.0";

export type BillingInvoicePreview = {
  tenantId: string;
  invoiceNumber?: string;
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
  /** Billing month/factor applied to recurring service and fee rows. */
  billingPeriodFactor?: {
    monthCount: number;
    prorated: boolean;
  };
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

export function tenantBillingPeriodBounds(settings: { billingDayOfMonth?: number | null; metadata?: unknown }, now = new Date()): { periodStart: Date; periodEnd: Date } {
  const schedule = buildBillingSchedule({
    now,
    billingDayOfMonth: Number(settings.billingDayOfMonth || 1),
    metadata: settings.metadata,
  });
  return { periodStart: schedule.periodStart, periodEnd: schedule.periodEnd };
}

export function addDays(date: Date, days: number): Date {
  return addBillingDays(date, days);
}

function roundCents(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function roundFactor(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function resolveBillingPeriodFactor(input: {
  periodStart: Date;
  periodEnd: Date;
  billingMonthCount?: number;
  prorate?: boolean;
}): { monthCount: number; prorated: boolean } {
  const explicitMonthCount = Number(input.billingMonthCount || 0);
  if (Number.isFinite(explicitMonthCount) && explicitMonthCount > 0) {
    return { monthCount: roundFactor(explicitMonthCount), prorated: explicitMonthCount % 1 !== 0 || !!input.prorate };
  }

  const durationMs = Math.max(1, input.periodEnd.getTime() - input.periodStart.getTime() + 1);
  if (input.prorate) {
    const monthlyMs = 30.4375 * 24 * 60 * 60 * 1000;
    return { monthCount: Math.max(0.0001, roundFactor(durationMs / monthlyMs)), prorated: true };
  }

  const approxMonths = Math.max(1, Math.round(durationMs / (30.4375 * 24 * 60 * 60 * 1000)));
  return { monthCount: approxMonths, prorated: false };
}

function scaledBillingQuantity(quantity: number, monthCount: number): number {
  return roundFactor(Math.max(0, Number(quantity || 0)) * Math.max(0, Number(monthCount || 0)));
}

function lineMetadata(item: { metadata?: Record<string, unknown> }): Record<string, unknown> {
  return item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
    ? item.metadata
    : {};
}

function applyBillingPeriodToRecurringLines(
  lineItems: BillingInvoicePreview["lineItems"],
  period: { periodStart: Date; periodEnd: Date; monthCount: number; prorated: boolean },
) {
  const factor = Number(period.monthCount || 1);
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) {
    for (const item of lineItems) {
      item.metadata = {
        ...lineMetadata(item),
        servicePeriodStart: period.periodStart.toISOString(),
        servicePeriodEnd: period.periodEnd.toISOString(),
        billingMonthCount: 1,
        prorated: false,
      };
    }
    return;
  }

  const factorIsInteger = Math.abs(factor - Math.round(factor)) < 0.0001;
  for (const item of lineItems) {
    const baseQuantity = Number(item.quantity || 1);
    const baseUnitPriceCents = Number(item.unitPriceCents || 0);
    const baseAmountCents = Number(item.amountCents || 0);
    const nextAmountCents = roundCents(baseAmountCents * factor);
    const nextQuantity = factorIsInteger ? Math.max(1, Math.round(baseQuantity * factor)) : Math.max(1, Math.round(baseQuantity));
    item.quantity = nextQuantity;
    item.unitPriceCents = nextQuantity > 0 ? roundCents(nextAmountCents / nextQuantity) : nextAmountCents;
    item.amountCents = nextAmountCents;
    item.description = factorIsInteger
      ? `${item.description} (${Math.round(factor)} months)`
      : `${item.description} (prorated ${factor.toFixed(2)} months)`;
    item.metadata = {
      ...lineMetadata(item),
      servicePeriodStart: period.periodStart.toISOString(),
      servicePeriodEnd: period.periodEnd.toISOString(),
      billingMonthCount: factor,
      prorated: period.prorated || !factorIsInteger,
      baseQuantity,
      baseUnitPriceCents,
      baseAmountCents,
    };
  }
}

function billingPeriodMetadata(period: { periodStart: Date; periodEnd: Date; monthCount: number; prorated: boolean }): Record<string, unknown> {
  return {
    servicePeriodStart: period.periodStart.toISOString(),
    servicePeriodEnd: period.periodEnd.toISOString(),
    billingMonthCount: period.monthCount,
    prorated: period.prorated,
  };
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
  billingMonthCount?: number;
  prorate?: boolean;
}): Promise<BillingInvoicePreview> {
  const { tenantId, settings } = input;
  const bounds = input.periodStart && input.periodEnd ? { periodStart: input.periodStart, periodEnd: input.periodEnd } : tenantBillingPeriodBounds(settings);
  const dueDate = input.dueDate || addDays(new Date(), Number(settings.paymentTermsDays || 15));
  const periodFactor = resolveBillingPeriodFactor({
    periodStart: bounds.periodStart,
    periodEnd: bounds.periodEnd,
    billingMonthCount: input.billingMonthCount,
    prorate: !!input.prorate,
  });

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
  applyBillingPeriodToRecurringLines(lineItems, {
    periodStart: bounds.periodStart,
    periodEnd: bounds.periodEnd,
    monthCount: periodFactor.monthCount,
    prorated: periodFactor.prorated,
  });
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
        metadata: billingPeriodMetadata({
          periodStart: bounds.periodStart,
          periodEnd: bounds.periodEnd,
          monthCount: periodFactor.monthCount,
          prorated: periodFactor.prorated,
        }),
      });
    }
  }

  const subtotalCents = lineItems.reduce((sum, item) => sum + item.amountCents, 0);
  const taxableSubtotalCents = lineItems.filter((item) => item.taxable).reduce((sum, item) => sum + item.amountCents, 0);
  const telecomFees = parseBillingTelecomFees(settings.metadata);
  const taxResult = telecomFees
    ? (() => {
        const feeLines = !!settings.taxEnabled
          ? buildBillingTelecomFeeLines({
              fees: telecomFees,
              taxableSubtotalCents,
              extensionCount: scaledBillingQuantity(billingQuantities.billing.extensions, periodFactor.monthCount),
              phoneNumberCount: scaledBillingQuantity(billingQuantities.billing.phoneNumbers, periodFactor.monthCount),
              tollFreeNumberCount: scaledBillingQuantity(billingQuantities.billing.tollFreeNumbers, periodFactor.monthCount),
              lineCount:
                scaledBillingQuantity(
                  billingQuantities.billing.extensions
                  + billingQuantities.billing.virtualExtensions
                  + billingQuantities.billing.phoneNumbers
                  + billingQuantities.billing.tollFreeNumbers
                  + billingQuantities.billing.smsPackages,
                  periodFactor.monthCount,
                ),
              taxProviderId: BILLING_TELECOM_FEES_PROVIDER_ID,
            })
          : [];
        const taxProfile = settings.taxProfile as any;
        return {
          lines: feeLines,
          audit: {
            providerId: BILLING_TELECOM_FEES_PROVIDER_ID,
            providerVersion: BILLING_TELECOM_FEES_PROVIDER_VERSION,
            computedAt: new Date().toISOString(),
            taxEnabled: !!settings.taxEnabled,
            taxProfileId: settings.taxProfileId || null,
            jurisdiction:
              taxProfile && (taxProfile.state || taxProfile.county != null || taxProfile.name)
                ? { state: taxProfile.state ?? null, county: taxProfile.county ?? null, profileName: taxProfile.name ?? null }
                : null,
            inputs: { taxableSubtotalCents, extensionCount: scaledBillingQuantity(billingQuantities.billing.extensions, periodFactor.monthCount) },
            lines: feeLines.map((line) => ({
              type: line.type,
              description: line.description,
              amountCents: line.amountCents,
              quantity: line.quantity,
            })),
            notes: settings.taxEnabled
              ? ["tenant_billing_telecom_fees_metadata"]
              : ["tax_disabled", "tenant_billing_telecom_fees_metadata_present"],
          } satisfies TaxCalculationAuditSnapshot,
        };
      })()
    : resolveTaxProvider(settings).calculateTaxes({
        tenantId,
        taxEnabled: !!settings.taxEnabled,
        taxProfile: settings.taxProfile || null,
        taxProfileId: settings.taxProfileId || null,
        taxableSubtotalCents,
        extensionCount: scaledBillingQuantity(billingQuantities.billing.extensions, periodFactor.monthCount),
      });
  for (const line of taxResult.lines) {
    lineItems.push({
      type: line.type,
      description: line.description,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      amountCents: line.amountCents,
      taxable: line.taxable,
      metadata: {
        ...(line.metadata || {}),
        ...billingPeriodMetadata({
          periodStart: bounds.periodStart,
          periodEnd: bounds.periodEnd,
          monthCount: periodFactor.monthCount,
          prorated: periodFactor.prorated,
        }),
      },
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
    billingPeriodFactor: periodFactor,
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
  billingMonthCount?: number;
  prorate?: boolean;
}): Promise<BillingInvoicePreview> {
  const settings = await ensureTenantBillingSettings(input.tenantId);
  return buildBillingInvoicePreviewWithLoadedSettings({
    tenantId: input.tenantId,
    settings,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    dueDate: input.dueDate,
    billingMonthCount: input.billingMonthCount,
    prorate: input.prorate,
  });
}

/** Same math as `buildBillingInvoicePreview`, but uses an in-memory settings snapshot (e.g. assign-plan simulation). */
export async function buildBillingInvoicePreviewFromSettings(input: {
  tenantId: string;
  settings: TenantBillingSettingsLoaded;
  periodStart?: Date;
  periodEnd?: Date;
  dueDate?: Date;
  billingMonthCount?: number;
  prorate?: boolean;
}): Promise<BillingInvoicePreview> {
  return buildBillingInvoicePreviewWithLoadedSettings(input);
}

export async function createBillingInvoice(input: {
  tenantId: string;
  periodStart?: Date;
  periodEnd?: Date;
  dueDate?: Date;
  billingMonthCount?: number;
  prorate?: boolean;
  status?: "DRAFT" | "OPEN";
  /** Merged into `BillingEventLog` row for `invoice_created` (e.g. `{ source: "worker_monthly" }`). */
  invoiceCreatedEventMetadata?: Record<string, unknown>;
}): Promise<any> {
  const preview = await buildBillingInvoicePreview(input);
  const paidCoverage = await findPaidBillingPeriodCoverage({
    tenantId: input.tenantId,
    periodStart: preview.periodStart,
    periodEnd: preview.periodEnd,
  });
  if (paidCoverage) throw billingPeriodAlreadyPaidError(paidCoverage);

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
        metadata: {
          taxCalculationAudit: preview.taxCalculationAudit,
          billingPeriodFactor: preview.billingPeriodFactor,
        },
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

export async function markBillingInvoicePaid(
  invoiceId: string,
  amountCents?: number,
  opts?: { operatorUserId?: string; note?: string },
): Promise<any> {
  const invoice = await (db as any).billingInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("BILLING_INVOICE_NOT_FOUND");
  const paid = amountCents ?? invoice.totalCents;
  // Simple "mark paid" only supports full payment. Partial payments must use
  // POST /admin/billing/invoices/:id/external-payment which creates an auditable
  // PaymentTransaction and handles balance tracking correctly.
  if (paid < invoice.totalCents) {
    const err: any = new Error("PARTIAL_PAYMENT_NOT_SUPPORTED");
    err.code = "PARTIAL_PAYMENT_NOT_SUPPORTED";
    err.hint = "Use POST /admin/billing/invoices/:id/external-payment to record partial payments with full audit trail.";
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
  await logBillingEvent({
    tenantId: invoice.tenantId,
    invoiceId,
    type: "invoice.paid",
    metadata: {
      amountCents: paid,
      operatorUserId: opts?.operatorUserId ?? null,
    },
  });
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
  periodStart?: Date | null;
  periodEnd?: Date | null;
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
  const periodStart = input.periodStart || now;
  const periodEnd = input.periodEnd || periodStart;

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
        periodStart,
        periodEnd,
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
            metadata: {
              source: "manual_adjustment",
              servicePeriodStart: periodStart.toISOString(),
              servicePeriodEnd: periodEnd.toISOString(),
            },
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

// ---------------------------------------------------------------------------
// Manual invoice creation — admin-authored invoice with arbitrary line items
// ---------------------------------------------------------------------------

export type ManualInvoiceLineItemInput = {
  type: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxable?: boolean;
  metadata?: Record<string, unknown>;
};

const VALID_LINE_ITEM_TYPES = new Set([
  "EXTENSION", "PHONE_NUMBER", "SMS_PACKAGE", "SALES_TAX", "E911_FEE",
  "REGULATORY_FEE", "CREDIT", "DISCOUNT", "MANUAL_ADJUSTMENT",
  "TRUNK", "DID", "ONE_TIME", "CUSTOM",
]);

function calcManualInvoiceTotals(items: ManualInvoiceLineItemInput[]): {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
} {
  let sub = 0;
  let tax = 0;
  for (const item of items) {
    const amt = Math.round(item.quantity * item.unitPriceCents);
    if (item.type === "SALES_TAX" || item.type === "E911_FEE" || item.type === "REGULATORY_FEE") {
      tax += amt;
    } else {
      sub += amt;
    }
  }
  return { subtotalCents: sub, taxCents: tax, totalCents: sub + tax };
}

export async function createManualInvoice(input: {
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
  issueDate?: Date;
  dueDate: Date;
  lineItems: ManualInvoiceLineItemInput[];
  notes?: string | null;
  billingEmail?: string | null;
  status?: "DRAFT" | "OPEN";
  createdByUserId: string;
  markPaidImmediately?: boolean;
}): Promise<any> {
  if (!input.lineItems.length) {
    const err: any = new Error("MANUAL_INVOICE_REQUIRES_LINE_ITEMS");
    err.code = "MANUAL_INVOICE_REQUIRES_LINE_ITEMS";
    throw err;
  }
  for (const item of input.lineItems) {
    if (!VALID_LINE_ITEM_TYPES.has(item.type)) {
      const err: any = new Error(`INVALID_LINE_ITEM_TYPE: ${item.type}`);
      err.code = "INVALID_LINE_ITEM_TYPE";
      throw err;
    }
    if (!item.description?.trim()) {
      const err: any = new Error("LINE_ITEM_DESCRIPTION_REQUIRED");
      err.code = "LINE_ITEM_DESCRIPTION_REQUIRED";
      throw err;
    }
    if (typeof item.quantity !== "number" || !Number.isFinite(item.quantity)) {
      const err: any = new Error("LINE_ITEM_QUANTITY_INVALID");
      err.code = "LINE_ITEM_QUANTITY_INVALID";
      throw err;
    }
    if (!Number.isInteger(item.unitPriceCents)) {
      const err: any = new Error("LINE_ITEM_UNIT_PRICE_MUST_BE_INTEGER_CENTS");
      err.code = "LINE_ITEM_UNIT_PRICE_MUST_BE_INTEGER_CENTS";
      throw err;
    }
  }

  const { subtotalCents, taxCents, totalCents } = calcManualInvoiceTotals(input.lineItems);
  const status = input.markPaidImmediately ? "PAID" : (input.status ?? "OPEN");

  const invoice = await createBillingInvoiceRowWithUniqueNumber(
    input.tenantId,
    async (invoiceNumber) =>
      (db as any).billingInvoice.create({
        data: {
          tenantId: input.tenantId,
          invoiceNumber,
          status,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          issueDate: input.issueDate ?? new Date(),
          dueDate: input.dueDate,
          subtotalCents,
          taxCents,
          totalCents,
          amountPaidCents: input.markPaidImmediately ? totalCents : 0,
          balanceDueCents: input.markPaidImmediately ? 0 : totalCents,
          paidAt: input.markPaidImmediately ? new Date() : null,
          notes: input.notes ?? null,
          billingEmail: input.billingEmail ?? null,
          source: "MANUAL",
          createdByUserId: input.createdByUserId,
          metadata: { source: "manual_invoice" },
          lineItems: {
            create: input.lineItems.map((item) => ({
              tenantId: input.tenantId,
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
        include: { lineItems: true, tenant: true },
      }),
  );

  await logBillingEvent({
    tenantId: input.tenantId,
    invoiceId: invoice.id,
    type: "invoice.manual_created",
    message: `Manual invoice ${invoice.invoiceNumber} created by operator`,
    metadata: {
      invoiceNumber: invoice.invoiceNumber,
      totalCents,
      lineItemCount: input.lineItems.length,
      createdByUserId: input.createdByUserId,
      markPaidImmediately: input.markPaidImmediately ?? false,
    },
  });

  return invoice;
}
