import type { TenantBillingSettingsLoaded } from "./invoiceEngine";
import { mergeTenantBillingSettingsMetadata } from "./billingTenantSettingsMetadata";

export type CatalogBillingPlanRow = NonNullable<TenantBillingSettingsLoaded["billingPlan"]>;

export function validateCatalogBillingPlanForAssignment(
  plan: { tenantId: string | null; active: boolean } | null | undefined,
): "billing_plan_not_found" | "billing_plan_not_catalog" | "billing_plan_inactive" | null {
  if (!plan) return "billing_plan_not_found";
  if (plan.tenantId != null) return "billing_plan_not_catalog";
  if (!plan.active) return "billing_plan_inactive";
  return null;
}

export function tenantPricingQuadSnapshot(settings: {
  extensionPriceCents: unknown;
  additionalPhoneNumberPriceCents: unknown;
  smsPriceCents: unknown;
  firstPhoneNumberFree: unknown;
}) {
  return {
    extensionPriceCents: Number(settings.extensionPriceCents ?? 0),
    additionalPhoneNumberPriceCents: Number(settings.additionalPhoneNumberPriceCents ?? 0),
    smsPriceCents: Number(settings.smsPriceCents ?? 0),
    firstPhoneNumberFree: settings.firstPhoneNumberFree !== false,
  };
}

/** In-memory snapshot for GET assign-plan-preview (no DB writes). */
export function mergeTenantBillingSettingsForAssignPreview(
  base: TenantBillingSettingsLoaded,
  targetPlan: CatalogBillingPlanRow,
  opts: { copyPlanPrices: boolean; applyPricingMode?: "catalog" | "custom" },
): TenantBillingSettingsLoaded {
  const merged = structuredClone(base) as TenantBillingSettingsLoaded;
  merged.billingPlanId = targetPlan.id;
  merged.billingPlan = targetPlan;
  if (opts.copyPlanPrices) {
    merged.extensionPriceCents = targetPlan.extensionPriceCents;
    merged.additionalPhoneNumberPriceCents = targetPlan.additionalPhoneNumberPriceCents;
    merged.smsPriceCents = targetPlan.smsPriceCents;
    merged.firstPhoneNumberFree = targetPlan.firstPhoneNumberFree !== false;
  }
  if (opts.applyPricingMode !== undefined) {
    merged.metadata = mergeTenantBillingSettingsMetadata(merged.metadata, { billingPricingMode: opts.applyPricingMode });
  }
  return merged;
}
