import {
  buildBillingQuantityOverridesPayload,
  type BillingQuantityOverrideKey,
} from "./billingUi";

export type TenantPricingSaveDraft = {
  extensionPriceCents: number;
  additionalPhoneNumberPriceCents: number;
  smsPriceCents: number;
  firstPhoneNumberFree: boolean;
  smsBillingEnabled: boolean;
  flatRateEnabled: boolean;
  flatRateAmountCents: number;
  quantityOverrides: Record<BillingQuantityOverrideKey, { mode: "auto" | "manual"; quantity: number }>;
  tollFreeDidPriceCents: number;
};

export type BillingUnitPriceKey =
  | "extensionPriceCents"
  | "additionalPhoneNumberPriceCents"
  | "smsPriceCents"
  | "tollFreeDidPriceCents";

/** Whether a billing item card unit price field accepts edits in the current pricing mode. */
export function isBillingUnitPriceEditable(
  priceKey: BillingUnitPriceKey | null,
  catalogLocked: boolean,
): boolean {
  if (!priceKey) return false;
  if (catalogLocked && priceKey !== "tollFreeDidPriceCents") return false;
  return true;
}

/** Maps billing item card keys to draft price fields (virtual extensions share extension price). */
export const BILLING_ITEM_PRICE_KEYS: Record<string, BillingUnitPriceKey | null> = {
  extensions: "extensionPriceCents",
  virtual: "extensionPriceCents",
  local_phone_numbers: "additionalPhoneNumberPriceCents",
  toll_free_phone_numbers: "tollFreeDidPriceCents",
  sms: "smsPriceCents",
};

export function buildTenantPricingSavePayload(
  draft: TenantPricingSaveDraft,
  catalogLocked: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    smsBillingEnabled: draft.smsBillingEnabled,
    billingQuantityOverrides: buildBillingQuantityOverridesPayload(draft.quantityOverrides),
    billingFlatRate: draft.flatRateEnabled
      ? {
          enabled: true,
          amountCents: draft.flatRateAmountCents,
          appliesTo: "extensions",
        }
      : {
          enabled: false,
          amountCents: draft.flatRateAmountCents,
          appliesTo: "extensions",
        },
  };
  if (!catalogLocked) {
    payload.extensionPriceCents = draft.extensionPriceCents;
    payload.additionalPhoneNumberPriceCents = draft.additionalPhoneNumberPriceCents;
    payload.tollFreeDidPriceCents = draft.tollFreeDidPriceCents;
    payload.smsPriceCents = draft.smsPriceCents;
    payload.firstPhoneNumberFree = draft.firstPhoneNumberFree;
    payload.billingPricingMode = "custom";
  } else {
    payload.tollFreeDidPriceCents = draft.tollFreeDidPriceCents;
  }
  return payload;
}
