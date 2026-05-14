import type { BillingInvoicePreview } from "./invoiceEngine";
import {
  BILLING_PRICING_MODE_METADATA_KEY,
  buildTenantSettingsResetToCatalog,
  parseBillingPricingMode,
} from "./billingPricingResolution";

type PlanSlice = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  extensionPriceCents: number;
  additionalPhoneNumberPriceCents: number;
  smsPriceCents: number;
  firstPhoneNumberFree: boolean;
} | null;

export type PricingFieldKey = "extensionPriceCents" | "additionalPhoneNumberPriceCents" | "smsPriceCents" | "firstPhoneNumberFree";

export type TenantPricingDiagnosticsDiff = Record<PricingFieldKey, boolean>;

export type TenantPricingResetPreview = {
  canReset: boolean;
  before: {
    pricingMode: "legacy" | "catalog" | "custom";
    extensionPriceCents: number;
    additionalPhoneNumberPriceCents: number;
    smsPriceCents: number;
    firstPhoneNumberFree: boolean;
  };
  after: {
    pricingMode: "catalog";
    extensionPriceCents: number;
    additionalPhoneNumberPriceCents: number;
    smsPriceCents: number;
    firstPhoneNumberFree: boolean;
  } | null;
};

export type TenantPricingDiagnostics = {
  tenantId: string;
  fetchedAt: string;
  /** Parsed `metadata.billingPricingMode` — `legacy` when absent. */
  mode: "legacy" | "catalog" | "custom";
  billingPlanCurrent: { id: string; code: string; name: string; active: boolean } | null;
  /** Plan row driving catalog/custom resolution for the preview period (current or scheduled next). */
  billingPlanEffectiveForPreview: { id: string; name: string; active: boolean } | null;
  tenantStoredPricing: {
    extensionPriceCents: number;
    additionalPhoneNumberPriceCents: number;
    smsPriceCents: number;
    firstPhoneNumberFree: boolean;
  };
  /** Same four fields as invoice line-item sources for the preview period. */
  effectiveInvoicePricing: {
    extensionPriceCents: number;
    additionalPhoneNumberPriceCents: number;
    smsPriceCents: number;
    firstPhoneNumberFree: boolean;
  };
  catalogBaselinePricing: {
    extensionPriceCents: number;
    additionalPhoneNumberPriceCents: number;
    smsPriceCents: number;
    firstPhoneNumberFree: boolean;
  } | null;
  differsFromPlan: {
    tenantRowVsCurrentPlanFk: TenantPricingDiagnosticsDiff;
    tenantRowVsEffectiveInvoice: TenantPricingDiagnosticsDiff;
  };
  scheduledPlanChange: null | {
    nextBillingPlanId: string;
    nextPlanName: string;
    effectiveAt: string;
    nextPlanActive: boolean | null;
  };
  previewPeriod: { periodStart: string; periodEnd: string };
  warnings: string[];
  notices: string[];
  explanationLines: string[];
  resetToPlanPreview: TenantPricingResetPreview;
  /** Mirrors `BillingInvoicePreview.pricingPreviewExplanation` for the same preview request. */
  pricingPreviewExplanation: NonNullable<BillingInvoicePreview["pricingPreviewExplanation"]>;
};

function boolFirst(v: boolean | null | undefined): boolean {
  return v !== false;
}

function diffPricing(
  tenant: { extensionPriceCents: number; additionalPhoneNumberPriceCents: number; smsPriceCents: number; firstPhoneNumberFree: boolean },
  other: { extensionPriceCents: number; additionalPhoneNumberPriceCents: number; smsPriceCents: number; firstPhoneNumberFree: boolean } | null,
): TenantPricingDiagnosticsDiff {
  if (!other) {
    return {
      extensionPriceCents: true,
      additionalPhoneNumberPriceCents: true,
      smsPriceCents: true,
      firstPhoneNumberFree: true,
    };
  }
  return {
    extensionPriceCents: tenant.extensionPriceCents !== other.extensionPriceCents,
    additionalPhoneNumberPriceCents: tenant.additionalPhoneNumberPriceCents !== other.additionalPhoneNumberPriceCents,
    smsPriceCents: tenant.smsPriceCents !== other.smsPriceCents,
    firstPhoneNumberFree: tenant.firstPhoneNumberFree !== other.firstPhoneNumberFree,
  };
}

function planToBaseline(plan: PlanSlice): TenantPricingDiagnostics["catalogBaselinePricing"] {
  if (!plan) return null;
  return {
    extensionPriceCents: plan.extensionPriceCents,
    additionalPhoneNumberPriceCents: plan.additionalPhoneNumberPriceCents,
    smsPriceCents: plan.smsPriceCents,
    firstPhoneNumberFree: boolFirst(plan.firstPhoneNumberFree),
  };
}

/**
 * Assemble pricing diagnostics from an already-built preview and settings snapshot.
 * Keeps invoice math in `buildBillingInvoicePreview` only.
 */
export function buildTenantPricingDiagnosticsFromPreview(input: {
  tenantId: string;
  settings: {
    metadata: unknown;
    billingPlanId: string | null;
    billingPlan: PlanSlice;
    nextBillingPlanId: string | null;
    nextBillingPlanEffectiveAt: Date | null;
    nextBillingPlan: PlanSlice;
    extensionPriceCents: number;
    additionalPhoneNumberPriceCents: number;
    smsPriceCents: number;
    firstPhoneNumberFree: boolean | null;
  };
  preview: BillingInvoicePreview;
}): TenantPricingDiagnostics {
  const { tenantId, settings, preview } = input;
  const pr = preview.pricingResolution;
  const expl = preview.pricingPreviewExplanation;
  if (!pr || !expl) {
    throw new Error("buildTenantPricingDiagnosticsFromPreview: preview missing pricingResolution or pricingPreviewExplanation");
  }

  const mode = parseBillingPricingMode(settings.metadata);
  const tenantStored = {
    extensionPriceCents: Number(settings.extensionPriceCents),
    additionalPhoneNumberPriceCents: Number(settings.additionalPhoneNumberPriceCents),
    smsPriceCents: Number(settings.smsPriceCents),
    firstPhoneNumberFree: boolFirst(settings.firstPhoneNumberFree),
  };

  const effectiveInvoice = {
    extensionPriceCents: pr.extensionPriceCents,
    additionalPhoneNumberPriceCents: pr.additionalPhoneNumberPriceCents,
    smsPriceCents: pr.smsPriceCents,
    firstPhoneNumberFree: pr.firstPhoneNumberFree,
  };

  const scheduledApplies =
    !!settings.nextBillingPlanId && !!settings.nextBillingPlanEffectiveAt && preview.periodStart >= settings.nextBillingPlanEffectiveAt;
  const effectivePlanRow: PlanSlice = scheduledApplies ? settings.nextBillingPlan : settings.billingPlan;
  const catalogBaseline = planToBaseline(effectivePlanRow);

  const billingPlanCurrent = settings.billingPlan
    ? {
        id: settings.billingPlan.id,
        code: settings.billingPlan.code,
        name: settings.billingPlan.name,
        active: settings.billingPlan.active,
      }
    : null;

  const billingPlanEffectiveForPreview = effectivePlanRow
    ? { id: effectivePlanRow.id, name: effectivePlanRow.name, active: effectivePlanRow.active }
    : null;

  const fkBaseline = planToBaseline(settings.billingPlan);
  const tenantRowVsCurrentPlanFk = diffPricing(tenantStored, fkBaseline);
  const tenantRowVsEffectiveInvoice = diffPricing(tenantStored, effectiveInvoice);

  const scheduledPlanChange =
    settings.nextBillingPlanId && settings.nextBillingPlanEffectiveAt && settings.nextBillingPlan
      ? {
          nextBillingPlanId: settings.nextBillingPlanId,
          nextPlanName: settings.nextBillingPlan.name,
          effectiveAt: settings.nextBillingPlanEffectiveAt.toISOString(),
          nextPlanActive: settings.nextBillingPlan.active,
        }
      : null;

  const warnings: string[] = [];
  const notices: string[] = [];

  if (mode === "catalog" && !settings.billingPlanId) {
    warnings.push(
      "Catalog pricing mode is selected but this tenant has no billingPlanId — invoices use default platform rates until a plan is linked.",
    );
  }
  if (mode === "catalog" && expl.tenantOverridesDetected) {
    warnings.push("Catalog mode: stored tenant unit prices differ from effective catalog rates — invoices use catalog values.");
  }
  if (mode === "custom" && settings.nextBillingPlanId) {
    warnings.push(
      "Custom mode: a scheduled plan change exists — tenant row prices remain on invoices until you change pricing source or reset.",
    );
  }
  if (settings.billingPlan && settings.billingPlan.active === false) {
    warnings.push(
      "Current BillingPlan (billingPlanId) is inactive — stored plan prices may still bill until you reassign an active plan.",
    );
  }
  if (settings.nextBillingPlan && settings.nextBillingPlan.active === false) {
    warnings.push("Scheduled next BillingPlan is inactive — the worker may skip applying the schedule at invoice time.");
  }
  if (pr.missingCatalogPlan && mode === "catalog") {
    warnings.push("Catalog mode with no plan for this preview period — default platform pricing applies.");
  }

  const prevMeta =
    settings.metadata && typeof settings.metadata === "object" && !Array.isArray(settings.metadata)
      ? { ...(settings.metadata as Record<string, unknown>) }
      : {};

  let resetToPlanPreview: TenantPricingResetPreview;
  if (!settings.billingPlan) {
    resetToPlanPreview = {
      canReset: false,
      before: {
        pricingMode: mode,
        ...tenantStored,
      },
      after: null,
    };
  } else {
    const patch = buildTenantSettingsResetToCatalog(settings.billingPlan, prevMeta);
    resetToPlanPreview = {
      canReset: true,
      before: {
        pricingMode: mode,
        ...tenantStored,
      },
      after: {
        pricingMode: "catalog",
        extensionPriceCents: patch.extensionPriceCents,
        additionalPhoneNumberPriceCents: patch.additionalPhoneNumberPriceCents,
        smsPriceCents: patch.smsPriceCents,
        firstPhoneNumberFree: patch.firstPhoneNumberFree,
      },
    };
  }

  return {
    tenantId,
    fetchedAt: new Date().toISOString(),
    mode,
    billingPlanCurrent,
    billingPlanEffectiveForPreview,
    tenantStoredPricing: tenantStored,
    effectiveInvoicePricing: effectiveInvoice,
    catalogBaselinePricing: catalogBaseline,
    differsFromPlan: {
      tenantRowVsCurrentPlanFk,
      tenantRowVsEffectiveInvoice,
    },
    scheduledPlanChange,
    previewPeriod: {
      periodStart: preview.periodStart.toISOString(),
      periodEnd: preview.periodEnd.toISOString(),
    },
    warnings,
    notices,
    explanationLines: expl.explanationLines,
    resetToPlanPreview,
    pricingPreviewExplanation: expl,
  };
}

/** Read `metadata.billingPricingMode` storage value for audit logs (nullable = legacy). */
export function rawBillingPricingModeFromMetadata(metadata: unknown): "catalog" | "custom" | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[BILLING_PRICING_MODE_METADATA_KEY];
  if (raw === "catalog" || raw === "custom") return raw;
  return null;
}
