import type { BillingPricingResolution, BillingPricingResolvedMode } from "./billingPricingResolution";

export type PricingPreviewEffectiveSource =
  | "legacy_chain"
  | "billing_plan_catalog"
  | "billing_plan_defaults"
  | "tenant_row_custom";

/** Immutable, structured explanation for invoice preview (no SOLA payloads). */
export type PricingPreviewExplanation = {
  pricingMode: BillingPricingResolvedMode;
  effectiveSource: PricingPreviewEffectiveSource;
  activePlanName: string | null;
  activePlanId: string | null;
  tenantOverridesDetected: boolean;
  scheduledPlanApplies: boolean;
  scheduledPlanSummary: string | null;
  explanationLines: string[];
};

function tenantBoolFirstFree(settingsFirst: boolean | null | undefined): boolean {
  return settingsFirst !== false;
}

/** Build preview explanation from already-resolved pricing (does not compute cents). */
export function buildPricingPreviewExplanation(params: {
  pricingMode: BillingPricingResolvedMode;
  pricingResolution: BillingPricingResolution;
  tenantPricing: {
    extensionPriceCents: number;
    additionalPhoneNumberPriceCents: number;
    smsPriceCents: number;
    firstPhoneNumberFree?: boolean | null;
  };
  hasScheduledChange: boolean;
  scheduledPlanChange?: { planId: string; planName: string; effectiveAt: Date };
  activePlanForPreview: { id?: string | null; name?: string | null; active?: boolean | null } | null;
}): PricingPreviewExplanation {
  const { pricingMode, pricingResolution, tenantPricing, hasScheduledChange, scheduledPlanChange, activePlanForPreview } = params;

  let effectiveSource: PricingPreviewEffectiveSource;
  if (pricingMode === "legacy") effectiveSource = "legacy_chain";
  else if (pricingMode === "custom") effectiveSource = "tenant_row_custom";
  else if (pricingResolution.missingCatalogPlan) effectiveSource = "billing_plan_defaults";
  else effectiveSource = "billing_plan_catalog";

  const tf = tenantBoolFirstFree(tenantPricing.firstPhoneNumberFree);
  const tenantOverridesDetected =
    pricingMode === "catalog" &&
    (Number(tenantPricing.extensionPriceCents) !== Number(pricingResolution.extensionPriceCents) ||
      Number(tenantPricing.additionalPhoneNumberPriceCents) !== Number(pricingResolution.additionalPhoneNumberPriceCents) ||
      Number(tenantPricing.smsPriceCents) !== Number(pricingResolution.smsPriceCents) ||
      tf !== pricingResolution.firstPhoneNumberFree);

  const scheduledPlanApplies = hasScheduledChange;
  const scheduledPlanSummary =
    scheduledPlanChange && hasScheduledChange
      ? `This preview period uses scheduled plan “${scheduledPlanChange.planName}” (effective ${scheduledPlanChange.effectiveAt.toISOString().slice(0, 10)}).`
      : null;

  const lines: string[] = [];
  if (effectiveSource === "legacy_chain") {
    lines.push("Legacy pricing: tenant row values participate in the historical || fallback chain with the active plan.");
  } else if (effectiveSource === "billing_plan_catalog") {
    lines.push("Catalog pricing: invoice unit rates come from the active billing plan for this preview period (not from stored tenant row amounts).");
  } else if (effectiveSource === "billing_plan_defaults") {
    lines.push("Catalog pricing with no linked plan for this period: platform default unit rates apply until a BillingPlan is assigned.");
  } else {
    lines.push("Custom pricing: invoice unit rates come only from the tenant billing settings row.");
  }

  if (activePlanForPreview && activePlanForPreview.active === false) {
    lines.push("Warning: the billing plan row used for this preview is marked inactive — prices still reflect stored plan values.");
  }

  if (tenantOverridesDetected) {
    lines.push(
      "Catalog mode: stored tenant unit prices differ from effective catalog rates — invoices use catalog values; the row may be stale until reset or a mode change.",
    );
  }

  if (pricingMode === "custom" && hasScheduledChange && scheduledPlanChange) {
    lines.push(
      `Custom mode with a scheduled plan change: tenant row prices stay on invoices until you switch mode or reset; after the effective month the worker may move billingPlanId to “${scheduledPlanChange.planName}”.`,
    );
  }

  if (scheduledPlanSummary) {
    lines.push(scheduledPlanSummary);
  }

  return {
    pricingMode,
    effectiveSource,
    activePlanName: pricingResolution.activePlanName,
    activePlanId: pricingResolution.activePlanId,
    tenantOverridesDetected,
    scheduledPlanApplies,
    scheduledPlanSummary,
    explanationLines: lines,
  };
}
