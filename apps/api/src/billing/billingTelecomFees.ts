/**
 * Per-tenant telecom tax/fee configuration (metadata.billingTelecomFees).
 * When present, invoice generation treats this tenant profile as authoritative;
 * TaxProfile remains the fallback for tenants that have not opted into this metadata shape.
 */

export const BILLING_TELECOM_FEES_METADATA_KEY = "billingTelecomFees";

export type TelecomFeeBasis =
  | "invoice_subtotal"
  | "per_extension"
  | "per_did"
  | "per_toll_free_did"
  | "per_line"
  | "flat_monthly";

export type TelecomFeeBillingMode = "ratePercent" | "amountCents";

export type TelecomFeeKey =
  | "salesTax"
  | "e911"
  | "regulatory"
  | "telecomSurcharge"
  | "usfRecovery"
  | "customFee";

export const TELECOM_FEE_KEYS: TelecomFeeKey[] = [
  "salesTax",
  "e911",
  "regulatory",
  "telecomSurcharge",
  "usfRecovery",
  "customFee",
];

export type TelecomFeeItemConfig = {
  enabled: boolean;
  customerVisible: boolean;
  label: string;
  description?: string;
  suggested?: boolean;
  mode: TelecomFeeBillingMode;
  ratePercent?: number | null;
  amountCents?: number | null;
  basis: TelecomFeeBasis;
};

export type BillingTelecomFeesConfig = Partial<Record<TelecomFeeKey, TelecomFeeItemConfig>>;

export type BillingTelecomFeeLine = {
  type: "SALES_TAX" | "E911_FEE" | "REGULATORY_FEE";
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  taxable: boolean;
  metadata: Record<string, unknown>;
};

export type TaxProfileFeeSource = {
  salesTaxRate?: number | string | null;
  e911FeePerExtension?: number | null;
  regulatoryFeePercent?: number | string | null;
  regulatoryFeeEnabled?: boolean | null;
  state?: string;
  county?: string | null;
  name?: string;
};

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function clampCents(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

export function parseBillingTelecomFees(metadata: unknown): BillingTelecomFeesConfig | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[BILLING_TELECOM_FEES_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: BillingTelecomFeesConfig = {};
  for (const key of TELECOM_FEE_KEYS) {
    const item = o[key];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const mode = row.mode === "amountCents" ? "amountCents" : "ratePercent";
    const basis = String(row.basis || "") as TelecomFeeBasis;
    const validBasis: TelecomFeeBasis[] = [
      "invoice_subtotal",
      "per_extension",
      "per_did",
      "per_toll_free_did",
      "per_line",
      "flat_monthly",
    ];
    out[key] = {
      enabled: row.enabled === true,
      customerVisible: row.customerVisible !== false,
      label: String(row.label || key),
      description: row.description != null ? String(row.description) : undefined,
      suggested: row.suggested === true,
      mode,
      ratePercent: row.ratePercent != null ? clampPercent(Number(row.ratePercent)) : null,
      amountCents: row.amountCents != null ? clampCents(Number(row.amountCents)) : null,
      basis: validBasis.includes(basis) ? basis : "invoice_subtotal",
    };
  }
  return Object.keys(out).length ? out : null;
}

export function validateBillingTelecomFeesInput(
  input: BillingTelecomFeesConfig | null | undefined,
): { ok: true; value: BillingTelecomFeesConfig | null } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "billingTelecomFees must be an object." };
  }
  const value: BillingTelecomFeesConfig = {};
  for (const key of TELECOM_FEE_KEYS) {
    const item = input[key];
    if (item === undefined) continue;
    if (!item || typeof item !== "object") {
      return { ok: false, error: `Invalid fee config for ${key}.` };
    }
    const mode = item.mode === "amountCents" ? "amountCents" : "ratePercent";
    if (mode === "ratePercent") {
      const p = Number(item.ratePercent);
      if (!Number.isFinite(p) || p < 0 || p > 1) {
        return { ok: false, error: `${key}: ratePercent must be between 0 and 1.` };
      }
    } else {
      const c = Number(item.amountCents);
      if (!Number.isFinite(c) || c < 0) {
        return { ok: false, error: `${key}: amountCents must be a non-negative integer.` };
      }
    }
    const parsed = parseBillingTelecomFees({ [BILLING_TELECOM_FEES_METADATA_KEY]: { [key]: item } });
    if (parsed?.[key]) value[key] = parsed[key]!;
  }
  return { ok: true, value: Object.keys(value).length ? value : null };
}

export function mergeBillingTelecomFeesIntoMetadata(
  prev: unknown,
  fees: BillingTelecomFeesConfig | null | undefined,
): Record<string, unknown> {
  const prevMeta =
    prev && typeof prev === "object" && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  if (fees === undefined) return prevMeta;
  if (fees === null) {
    delete prevMeta[BILLING_TELECOM_FEES_METADATA_KEY];
    return prevMeta;
  }
  return { ...prevMeta, [BILLING_TELECOM_FEES_METADATA_KEY]: fees };
}

/** Default suggested values when jurisdiction looks like NY / Orange County. */
export function defaultSuggestedTelecomFees(): BillingTelecomFeesConfig {
  return {
    salesTax: {
      enabled: true,
      customerVisible: true,
      label: "Sales tax",
      description: "Suggested based on configured service address. Confirm with your tax advisor.",
      suggested: true,
      mode: "ratePercent",
      ratePercent: 0.08125,
      basis: "invoice_subtotal",
    },
    e911: {
      enabled: true,
      customerVisible: true,
      label: "Suggested E911 fee",
      description: "Not a legal guarantee. Confirm E911 obligations with your advisor.",
      suggested: true,
      mode: "amountCents",
      amountCents: 300,
      basis: "per_did",
    },
    regulatory: {
      enabled: true,
      customerVisible: true,
      label: "Regulatory recovery fee",
      suggested: true,
      mode: "ratePercent",
      ratePercent: 0.01,
      basis: "invoice_subtotal",
    },
    telecomSurcharge: {
      enabled: false,
      customerVisible: false,
      label: "Telecom surcharge",
      suggested: true,
      mode: "ratePercent",
      ratePercent: 0,
      basis: "invoice_subtotal",
    },
    usfRecovery: {
      enabled: false,
      customerVisible: false,
      label: "Federal / USF recovery fee",
      suggested: true,
      mode: "ratePercent",
      ratePercent: 0,
      basis: "invoice_subtotal",
    },
    customFee: {
      enabled: false,
      customerVisible: false,
      label: "Other custom fee",
      suggested: false,
      mode: "amountCents",
      amountCents: 0,
      basis: "flat_monthly",
    },
  };
}

function decimalToNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  return Number(String(value)) || 0;
}

export function buildTelecomFeesFromTaxProfile(profile: TaxProfileFeeSource | null | undefined): BillingTelecomFeesConfig {
  if (!profile) return defaultSuggestedTelecomFees();
  const sales = decimalToNumber(profile.salesTaxRate);
  const reg = decimalToNumber(profile.regulatoryFeePercent);
  const e911 = Number(profile.e911FeePerExtension || 0);
  const nyOrange =
    String(profile.state || "").toUpperCase() === "NY" &&
    String(profile.county || "").toLowerCase().includes("orange");
  const suggested = defaultSuggestedTelecomFees();
  return {
    salesTax: {
      ...suggested.salesTax!,
      enabled: sales > 0,
      suggested: nyOrange,
      mode: "ratePercent",
      ratePercent: sales > 0 ? sales : suggested.salesTax!.ratePercent!,
    },
    e911: {
      ...suggested.e911!,
      enabled: e911 > 0,
      suggested: nyOrange,
      mode: "amountCents",
      amountCents: e911 > 0 ? e911 : suggested.e911!.amountCents!,
      basis: "per_did",
    },
    regulatory: {
      ...suggested.regulatory!,
      enabled: profile.regulatoryFeeEnabled !== false && reg > 0,
      suggested: nyOrange,
      mode: "ratePercent",
      ratePercent: reg > 0 ? reg : suggested.regulatory!.ratePercent!,
    },
    telecomSurcharge: { ...suggested.telecomSurcharge! },
    usfRecovery: { ...suggested.usfRecovery! },
    customFee: { ...suggested.customFee! },
  };
}

export function mergeTelecomFeesWithDefaults(
  stored: BillingTelecomFeesConfig | null,
  profile: TaxProfileFeeSource | null | undefined,
): BillingTelecomFeesConfig {
  const base = buildTelecomFeesFromTaxProfile(profile);
  if (!stored) return base;
  const out: BillingTelecomFeesConfig = { ...base };
  for (const key of TELECOM_FEE_KEYS) {
    if (stored[key]) out[key] = { ...base[key], ...stored[key] };
  }
  return out;
}

function feeLineType(key: TelecomFeeKey): BillingTelecomFeeLine["type"] {
  if (key === "salesTax") return "SALES_TAX";
  if (key === "e911") return "E911_FEE";
  return "REGULATORY_FEE";
}

function basisQuantity(input: {
  basis: TelecomFeeBasis;
  extensionCount: number;
  phoneNumberCount: number;
  tollFreeNumberCount: number;
  lineCount: number;
}): number {
  switch (input.basis) {
    case "per_extension":
      return input.extensionCount;
    case "per_did":
      return input.phoneNumberCount + input.tollFreeNumberCount;
    case "per_toll_free_did":
      return input.tollFreeNumberCount;
    case "per_line":
      return input.lineCount;
    case "flat_monthly":
    case "invoice_subtotal":
    default:
      return 1;
  }
}

export function buildBillingTelecomFeeLines(input: {
  fees: BillingTelecomFeesConfig;
  taxableSubtotalCents: number;
  extensionCount: number;
  phoneNumberCount: number;
  tollFreeNumberCount: number;
  lineCount: number;
  taxProviderId: string;
}): BillingTelecomFeeLine[] {
  const lines: BillingTelecomFeeLine[] = [];
  for (const key of TELECOM_FEE_KEYS) {
    const fee = input.fees[key];
    if (!fee?.enabled) continue;
    const quantity = basisQuantity({ basis: fee.basis, ...input });
    if (quantity <= 0) continue;
    let unitPriceCents = 0;
    let amountCents = 0;
    if (fee.mode === "ratePercent") {
      amountCents = Math.round(input.taxableSubtotalCents * clampPercent(Number(fee.ratePercent || 0)));
      unitPriceCents = amountCents;
    } else {
      unitPriceCents = clampCents(Number(fee.amountCents || 0));
      amountCents = unitPriceCents * quantity;
    }
    if (amountCents <= 0) continue;
    lines.push({
      type: feeLineType(key),
      description: fee.label || key,
      quantity,
      unitPriceCents,
      amountCents,
      taxable: false,
      metadata: {
        taxProviderId: input.taxProviderId,
        taxLineType: feeLineType(key),
        telecomFeeKey: key,
        telecomFeeBasis: fee.basis,
        telecomFeeMode: fee.mode,
        customerVisible: fee.customerVisible !== false,
      },
    });
  }
  return lines;
}

/** Map tenant fee config → TaxProfile row fields (shared profiles — operator discretion). */
export function taxProfilePatchFromTelecomFees(fees: BillingTelecomFeesConfig): {
  salesTaxRate: number;
  e911FeePerExtension: number;
  regulatoryFeePercent: number;
  regulatoryFeeEnabled: boolean;
} {
  const sales = fees.salesTax;
  const e911 = fees.e911;
  const reg = fees.regulatory;
  return {
    salesTaxRate:
      sales?.enabled && sales.mode === "ratePercent" ? clampPercent(Number(sales.ratePercent || 0)) : 0,
    e911FeePerExtension:
      e911?.enabled && e911.mode === "amountCents"
        ? clampCents(Number(e911.amountCents || 0))
        : 0,
    regulatoryFeePercent:
      reg?.enabled && reg.mode === "ratePercent" ? clampPercent(Number(reg.ratePercent || 0)) : 0,
    regulatoryFeeEnabled: !!(reg?.enabled && reg.mode === "ratePercent" && Number(reg.ratePercent || 0) > 0),
  };
}
