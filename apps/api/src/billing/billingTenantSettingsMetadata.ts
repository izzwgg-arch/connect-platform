import type { BillingFlatRateConfig } from "./billingFlatRate";
import { mergeBillingFlatRateIntoMetadata } from "./billingFlatRate";
import { BILLING_PRICING_MODE_METADATA_KEY } from "./billingPricingResolution";

export type TenantBillingMetaPatchInput = {
  taxProviderId?: "tax_profile_v1" | "external_telecom_stub";
  /** Omit = leave metadata untouched for mode key */
  billingPricingMode?: "catalog" | "custom" | null;
  /** Omit = leave flat rate untouched; null = remove */
  billingFlatRate?: BillingFlatRateConfig | null;
};
/** Same merge semantics as `PUT /admin/billing/tenants/:tenantId/settings` for audit tests. */
export function mergeTenantBillingSettingsMetadata(prev: unknown, input: TenantBillingMetaPatchInput): Record<string, unknown> {
  const prevMeta =
    prev && typeof prev === "object" && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  const merged: Record<string, unknown> = { ...prevMeta };
  if (input.taxProviderId !== undefined) {
    merged.taxProviderId = input.taxProviderId;
  }
  if (input.billingPricingMode !== undefined) {
    if (input.billingPricingMode === null) {
      delete merged[BILLING_PRICING_MODE_METADATA_KEY];
    } else {
      merged[BILLING_PRICING_MODE_METADATA_KEY] = input.billingPricingMode;
    }
  }
  if (input.billingFlatRate !== undefined) {
    return mergeBillingFlatRateIntoMetadata(merged, input.billingFlatRate);
  }
  return merged;
}
