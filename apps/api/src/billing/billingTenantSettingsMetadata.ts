import type { BillingFlatRateConfig } from "./billingFlatRate";
import { mergeBillingFlatRateIntoMetadata } from "./billingFlatRate";
import type { BillingQuantityOverridesConfig } from "./billingQuantityOverrides";
import { mergeBillingQuantityOverridesIntoMetadata } from "./billingQuantityOverrides";
import { mergeTollFreeDidPriceIntoMetadata } from "./billingTollFreePricing";
import type { BillingTelecomFeesConfig } from "./billingTelecomFees";
import { mergeBillingTelecomFeesIntoMetadata } from "./billingTelecomFees";
import { BILLING_PRICING_MODE_METADATA_KEY } from "./billingPricingResolution";

export const BILLING_SCHEDULE_OVERRIDE_METADATA_KEY = "billingScheduleOverride";

/** Stored on `TenantBillingSettings.metadata.billingScheduleOverride`. No Prisma migration. */
export type BillingScheduleOverride = {
  /** ISO date string YYYY-MM-DD. When set, Connect billing worker treats this as the next charge date. */
  nextPaymentDate: string | null;
  /** When true, skip the next scheduled billing run for this tenant and clear the flag. */
  skipNextPayment: boolean;
  skipReason: string | null;
  /** Admin user ID who set this override. */
  updatedBy: string;
  /** ISO timestamp when set. */
  updatedAt: string;
};

export function validateBillingScheduleOverrideInput(
  input: unknown,
): { ok: true; value: BillingScheduleOverride | null } | { ok: false; error: string } {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "billingScheduleOverride must be an object." };
  }
  const raw = input as Record<string, unknown>;

  const nextPaymentDate = raw.nextPaymentDate;
  if (nextPaymentDate !== null && nextPaymentDate !== undefined) {
    if (typeof nextPaymentDate !== "string") {
      return { ok: false, error: "nextPaymentDate must be a string (YYYY-MM-DD) or null." };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextPaymentDate)) {
      return { ok: false, error: "nextPaymentDate must be in YYYY-MM-DD format." };
    }
    const d = new Date(nextPaymentDate + "T00:00:00Z");
    if (isNaN(d.getTime())) {
      return { ok: false, error: "nextPaymentDate is not a valid date." };
    }
  }

  const skipNextPayment = raw.skipNextPayment;
  if (skipNextPayment !== undefined && typeof skipNextPayment !== "boolean") {
    return { ok: false, error: "skipNextPayment must be a boolean." };
  }

  const skipReason = raw.skipReason;
  if (skipReason !== null && skipReason !== undefined) {
    if (typeof skipReason !== "string" || skipReason.length > 500) {
      return { ok: false, error: "skipReason must be a string up to 500 characters." };
    }
  }

  const updatedBy = typeof raw.updatedBy === "string" ? raw.updatedBy.trim().slice(0, 200) : "";
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString();

  return {
    ok: true,
    value: {
      nextPaymentDate: typeof nextPaymentDate === "string" ? nextPaymentDate : null,
      skipNextPayment: skipNextPayment === true,
      skipReason: typeof skipReason === "string" ? skipReason.trim().slice(0, 500) || null : null,
      updatedBy,
      updatedAt,
    },
  };
}

export function mergeBillingScheduleOverrideIntoMetadata(
  prev: Record<string, unknown>,
  override: BillingScheduleOverride | null,
): Record<string, unknown> {
  if (override === null) {
    const out = { ...prev };
    delete out[BILLING_SCHEDULE_OVERRIDE_METADATA_KEY];
    return out;
  }
  return { ...prev, [BILLING_SCHEDULE_OVERRIDE_METADATA_KEY]: override };
}

export type TenantBillingMetaPatchInput = {
  taxProviderId?: "tax_profile_v1" | "external_telecom_stub";
  /** Omit = leave metadata untouched for mode key */
  billingPricingMode?: "catalog" | "custom" | null;
  /** Omit = leave flat rate untouched; null = remove */
  billingFlatRate?: BillingFlatRateConfig | null;
  /** Omit = leave quantity overrides untouched; null = remove */
  billingQuantityOverrides?: BillingQuantityOverridesConfig | null;
  /** Omit = leave toll-free DID unit price untouched; null = remove from metadata */
  tollFreeDidPriceCents?: number | null;
  /** Omit = leave telecom fee config untouched; null = remove */
  billingTelecomFees?: BillingTelecomFeesConfig | null;
  /** Omit = leave schedule override untouched; null = remove */
  billingScheduleOverride?: BillingScheduleOverride | null;
};
/** Same merge semantics as `PUT /admin/billing/tenants/:tenantId/settings` for audit tests. */
export function mergeTenantBillingSettingsMetadata(prev: unknown, input: TenantBillingMetaPatchInput): Record<string, unknown> {
  const prevMeta =
    prev && typeof prev === "object" && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  let merged: Record<string, unknown> = { ...prevMeta };
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
    merged = mergeBillingFlatRateIntoMetadata(merged, input.billingFlatRate);
  }
  if (input.billingQuantityOverrides !== undefined) {
    merged = mergeBillingQuantityOverridesIntoMetadata(merged, input.billingQuantityOverrides);
  }
  if (input.tollFreeDidPriceCents !== undefined) {
    merged = mergeTollFreeDidPriceIntoMetadata(merged, input.tollFreeDidPriceCents);
  }
  if (input.billingTelecomFees !== undefined) {
    merged = mergeBillingTelecomFeesIntoMetadata(merged, input.billingTelecomFees);
  }
  if (input.billingScheduleOverride !== undefined) {
    merged = mergeBillingScheduleOverrideIntoMetadata(merged, input.billingScheduleOverride);
  }
  return merged;
}
