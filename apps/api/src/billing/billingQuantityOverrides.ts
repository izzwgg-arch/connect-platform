import type { BillingUsageSnapshot } from "./usage";

export const BILLING_QUANTITY_OVERRIDES_METADATA_KEY = "billingQuantityOverrides";

export type BillingQuantityOverrideKey =
  | "extensions"
  | "virtualExtensions"
  | "phoneNumbers"
  | "tollFreeNumbers"
  | "smsPackages";

export type BillingQuantityOverrideMode = "auto" | "manual";

export type BillingQuantityOverrideItem = {
  mode: BillingQuantityOverrideMode;
  quantity: number | null;
};

export type BillingQuantityOverridesConfig = Partial<
  Record<BillingQuantityOverrideKey, BillingQuantityOverrideItem>
>;

export const MAX_BILLING_QUANTITY = 100_000;

/** All supported override keys — keep parse + validate in sync. */
export const BILLING_QUANTITY_OVERRIDE_KEYS: BillingQuantityOverrideKey[] = [
  "extensions",
  "virtualExtensions",
  "phoneNumbers",
  "tollFreeNumbers",
  "smsPackages",
];

export type BillingSuggestedQuantities = {
  extensions: number;
  virtualExtensions: number;
  /** Local (non–toll-free) billable after first-number-free. */
  phoneNumbersBillable: number;
  phoneNumbersTotal: number;
  phoneNumbersIncluded: number;
  tollFreeNumbersBillable: number;
  tollFreeNumbersTotal: number;
  smsPackages: number;
};

export type BillingResolvedQuantities = {
  suggested: BillingSuggestedQuantities;
  billing: {
    extensions: number;
    virtualExtensions: number;
    phoneNumbers: number;
    tollFreeNumbers: number;
    smsPackages: number;
  };
  modes: Record<BillingQuantityOverrideKey, BillingQuantityOverrideMode>;
};

function clampQty(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_BILLING_QUANTITY, Math.max(0, Math.round(n)));
}

export function computeSuggestedBillingQuantities(
  usage: BillingUsageSnapshot,
  firstPhoneNumberFree: boolean,
): BillingSuggestedQuantities {
  const phoneNumbersIncluded = firstPhoneNumberFree === false ? 0 : 1;
  return {
    extensions: usage.extensionCount,
    virtualExtensions: 0,
    phoneNumbersBillable: usage.localBillablePhoneNumberCount,
    phoneNumbersTotal: usage.localPhoneNumberCount,
    phoneNumbersIncluded,
    tollFreeNumbersBillable: usage.tollFreeBillablePhoneNumberCount,
    tollFreeNumbersTotal: usage.tollFreePhoneNumberCount,
    smsPackages: usage.smsEnabled ? 1 : 0,
  };
}

export function parseBillingQuantityOverrides(metadata: unknown): BillingQuantityOverridesConfig | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[BILLING_QUANTITY_OVERRIDES_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: BillingQuantityOverridesConfig = {};
  for (const key of BILLING_QUANTITY_OVERRIDE_KEYS) {
    const item = o[key];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const mode = row.mode === "manual" ? "manual" : "auto";
    const quantity =
      row.quantity === null || row.quantity === undefined
        ? null
        : clampQty(Number(row.quantity));
    out[key] = { mode, quantity };
  }
  return Object.keys(out).length ? out : null;
}

export function validateBillingQuantityOverridesInput(
  input: BillingQuantityOverridesConfig | null | undefined,
): { ok: true; value: BillingQuantityOverridesConfig | null } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "billingQuantityOverrides must be an object." };
  }
  const value: BillingQuantityOverridesConfig = {};
  for (const key of BILLING_QUANTITY_OVERRIDE_KEYS) {
    const item = input[key];
    if (item === undefined) continue;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `Invalid override for ${key}.` };
    }
    const mode = item.mode === "manual" ? "manual" : "auto";
    if (mode === "manual") {
      const q = Number(item.quantity);
      if (!Number.isFinite(q) || q < 0) {
        return { ok: false, error: `Manual ${key} quantity must be a non-negative integer.` };
      }
      if (q > MAX_BILLING_QUANTITY) {
        return { ok: false, error: `Manual ${key} quantity exceeds maximum (${MAX_BILLING_QUANTITY}).` };
      }
      value[key] = { mode: "manual", quantity: Math.round(q) };
    } else {
      value[key] = { mode: "auto", quantity: null };
    }
  }
  return { ok: true, value: Object.keys(value).length ? value : null };
}

export function mergeBillingQuantityOverridesIntoMetadata(
  prev: unknown,
  overrides: BillingQuantityOverridesConfig | null | undefined,
): Record<string, unknown> {
  const prevMeta =
    prev && typeof prev === "object" && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  if (overrides === undefined) return prevMeta;
  if (overrides === null) {
    delete prevMeta[BILLING_QUANTITY_OVERRIDES_METADATA_KEY];
    return prevMeta;
  }
  return { ...prevMeta, [BILLING_QUANTITY_OVERRIDES_METADATA_KEY]: overrides };
}

function resolveItem(
  key: BillingQuantityOverrideKey,
  suggested: number,
  overrides: BillingQuantityOverridesConfig | null,
): { billing: number; mode: BillingQuantityOverrideMode } {
  const item = overrides?.[key];
  if (item?.mode === "manual" && item.quantity != null) {
    return { billing: clampQty(item.quantity), mode: "manual" };
  }
  return { billing: clampQty(suggested), mode: "auto" };
}

export function resolveBillingQuantities(input: {
  usage: BillingUsageSnapshot;
  metadata: unknown;
  firstPhoneNumberFree: boolean;
}): BillingResolvedQuantities {
  const overrides = parseBillingQuantityOverrides(input.metadata);
  const suggested = computeSuggestedBillingQuantities(input.usage, input.firstPhoneNumberFree);

  const ext = resolveItem("extensions", suggested.extensions, overrides);
  const virt = resolveItem("virtualExtensions", suggested.virtualExtensions, overrides);
  const phone = resolveItem("phoneNumbers", suggested.phoneNumbersBillable, overrides);
  const tollFree = resolveItem("tollFreeNumbers", suggested.tollFreeNumbersBillable, overrides);
  const sms = resolveItem("smsPackages", suggested.smsPackages, overrides);

  return {
    suggested,
    billing: {
      extensions: ext.billing,
      virtualExtensions: virt.billing,
      phoneNumbers: phone.billing,
      tollFreeNumbers: tollFree.billing,
      smsPackages: sms.billing,
    },
    modes: {
      extensions: ext.mode,
      virtualExtensions: virt.mode,
      phoneNumbers: phone.mode,
      tollFreeNumbers: tollFree.mode,
      smsPackages: sms.mode,
    },
  };
}
