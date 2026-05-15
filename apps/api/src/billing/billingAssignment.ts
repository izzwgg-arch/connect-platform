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

/** Prisma-backed rows include Decimal and other values that structuredClone rejects. */
function cloneTenantBillingSettingsForSimulation(base: TenantBillingSettingsLoaded): TenantBillingSettingsLoaded {
  try {
    return JSON.parse(
      JSON.stringify(base, (_prop, value) => (typeof value === "bigint" ? value.toString() : value)),
      reviveBillingSettingsJsonDates,
    ) as TenantBillingSettingsLoaded;
  } catch {
    throw new Error("billing_assign_preview_settings_clone_failed");
  }
}

function reviveBillingSettingsJsonDates(key: string, value: unknown): unknown {
  if (typeof value !== "string" || !key.endsWith("At")) return value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d;
}

/** In-memory snapshot for GET assign-plan-preview (no DB writes). */
export function mergeTenantBillingSettingsForAssignPreview(
  base: TenantBillingSettingsLoaded,
  targetPlan: CatalogBillingPlanRow,
  opts: { copyPlanPrices: boolean; applyPricingMode?: "catalog" | "custom" },
): TenantBillingSettingsLoaded {
  const merged = cloneTenantBillingSettingsForSimulation(base);
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
