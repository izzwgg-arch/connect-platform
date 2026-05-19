/**
 * Portal helpers for metadata.billingTelecomFees (mirrors API semantics).
 * Estimates are preview-only unless noted; invoice lines use TaxProfile via API.
 */

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

export type TelecomFeeEstimateLine = {
  key: TelecomFeeKey;
  label: string;
  amountCents: number;
  enabled: boolean;
  customerVisible: boolean;
  suggested?: boolean;
  quantity?: number;
  unitCents?: number;
  note?: string;
  billedOnInvoice?: boolean;
};

const FEE_LABELS: Record<TelecomFeeKey, { label: string; description: string }> = {
  salesTax: {
    label: "Sales tax",
    description: "Suggested based on configured service address. Confirm with your tax advisor.",
  },
  e911: {
    label: "Suggested E911 fee",
    description: "Not a legal guarantee. Confirm E911 obligations with your advisor.",
  },
  regulatory: { label: "Regulatory recovery fee", description: "Percent of taxable service subtotal." },
  telecomSurcharge: { label: "Telecom surcharge", description: "Optional carrier surcharge (estimate only until invoiced)." },
  usfRecovery: { label: "Federal / USF recovery fee", description: "Optional USF-style recovery (estimate only until invoiced)." },
  customFee: { label: "Other custom fee", description: "Custom flat or unit fee (estimate only until invoiced)." },
};

export function parseBillingTelecomFeesFromMetadata(metadata: unknown): BillingTelecomFeesConfig | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).billingTelecomFees;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: BillingTelecomFeesConfig = {};
  for (const key of TELECOM_FEE_KEYS) {
    const item = o[key];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    out[key] = {
      enabled: row.enabled === true,
      customerVisible: row.customerVisible !== false,
      label: String(row.label || FEE_LABELS[key].label),
      description: row.description != null ? String(row.description) : FEE_LABELS[key].description,
      suggested: row.suggested === true,
      mode: row.mode === "amountCents" ? "amountCents" : "ratePercent",
      ratePercent: row.ratePercent != null ? Number(row.ratePercent) : null,
      amountCents: row.amountCents != null ? Math.round(Number(row.amountCents)) : null,
      basis: (String(row.basis || "invoice_subtotal") as TelecomFeeBasis) || "invoice_subtotal",
    };
  }
  return Object.keys(out).length ? out : null;
}

function decimalToNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  return Number(String(value)) || 0;
}

export function defaultFeesFromTaxProfile(profile: {
  salesTaxRate?: unknown;
  e911FeePerExtension?: number | null;
  regulatoryFeePercent?: unknown;
  regulatoryFeeEnabled?: boolean | null;
  state?: string;
  county?: string | null;
} | null | undefined): BillingTelecomFeesConfig {
  const nyOrange =
    profile &&
    String(profile.state || "").toUpperCase() === "NY" &&
    String(profile.county || "").toLowerCase().includes("orange");
  const sales = profile ? decimalToNumber(profile.salesTaxRate) : 0;
  const reg = profile ? decimalToNumber(profile.regulatoryFeePercent) : 0;
  const e911 = profile ? Number(profile.e911FeePerExtension || 0) : 0;
  return {
    salesTax: {
      enabled: true,
      customerVisible: true,
      label: FEE_LABELS.salesTax.label,
      description: FEE_LABELS.salesTax.description,
      suggested: nyOrange || !profile,
      mode: "ratePercent",
      ratePercent: sales > 0 ? sales : nyOrange ? 0.08125 : 0,
      basis: "invoice_subtotal",
    },
    e911: {
      enabled: true,
      customerVisible: true,
      label: FEE_LABELS.e911.label,
      description: FEE_LABELS.e911.description,
      suggested: nyOrange || !profile,
      mode: "amountCents",
      amountCents: e911 > 0 ? e911 : 300,
      basis: "flat_monthly",
    },
    regulatory: {
      enabled: profile?.regulatoryFeeEnabled !== false,
      customerVisible: true,
      label: FEE_LABELS.regulatory.label,
      description: FEE_LABELS.regulatory.description,
      suggested: nyOrange || !profile,
      mode: "ratePercent",
      ratePercent: reg > 0 ? reg : 0.01,
      basis: "invoice_subtotal",
    },
    telecomSurcharge: {
      enabled: false,
      customerVisible: false,
      label: FEE_LABELS.telecomSurcharge.label,
      description: FEE_LABELS.telecomSurcharge.description,
      suggested: true,
      mode: "ratePercent",
      ratePercent: 0,
      basis: "invoice_subtotal",
    },
    usfRecovery: {
      enabled: false,
      customerVisible: false,
      label: FEE_LABELS.usfRecovery.label,
      description: FEE_LABELS.usfRecovery.description,
      suggested: true,
      mode: "ratePercent",
      ratePercent: 0,
      basis: "invoice_subtotal",
    },
    customFee: {
      enabled: false,
      customerVisible: false,
      label: FEE_LABELS.customFee.label,
      description: FEE_LABELS.customFee.description,
      suggested: false,
      mode: "amountCents",
      amountCents: 0,
      basis: "flat_monthly",
    },
  };
}

export function mergeTelecomFeesDraft(
  stored: BillingTelecomFeesConfig | null,
  profile: Parameters<typeof defaultFeesFromTaxProfile>[0],
): BillingTelecomFeesConfig {
  const base = defaultFeesFromTaxProfile(profile);
  if (!stored) return base;
  const out: BillingTelecomFeesConfig = { ...base };
  for (const key of TELECOM_FEE_KEYS) {
    if (stored[key]) out[key] = { ...base[key], ...stored[key] };
  }
  return out;
}

export function formatJurisdiction(profile: { state?: string; county?: string | null; name?: string } | null, serviceAddress: unknown): string {
  if (profile?.state) {
    return [profile.name, profile.county ? `${profile.county}, ${profile.state}` : profile.state].filter(Boolean).join(" · ");
  }
  if (serviceAddress && typeof serviceAddress === "object" && !Array.isArray(serviceAddress)) {
    const a = serviceAddress as Record<string, unknown>;
    const parts = [a.city, a.state, a.county].filter((x) => x != null && String(x).trim());
    if (parts.length) return parts.map(String).join(", ");
  }
  return "Jurisdiction not set";
}

function basisQuantity(
  basis: TelecomFeeBasis,
  input: {
    extensionCount: number;
    localDidCount: number;
    tollFreeDidCount: number;
    lineCount: number;
  },
): number {
  switch (basis) {
    case "per_extension":
      return input.extensionCount;
    case "per_did":
      return input.localDidCount;
    case "per_toll_free_did":
      return input.tollFreeDidCount;
    case "per_line":
      return input.lineCount;
    case "flat_monthly":
      return 1;
    default:
      return 1;
  }
}

/** Preview estimate — aligns with TaxProfile invoice math for sales/E911/regulatory when enabled. */
export function computeTelecomFeesEstimate(input: {
  fees: BillingTelecomFeesConfig;
  taxableSubtotalCents: number;
  extensionCount: number;
  localDidCount: number;
  tollFreeDidCount: number;
  taxEnabled: boolean;
}): {
  lines: TelecomFeeEstimateLine[];
  totalCents: number;
  customerVisibleTotalCents: number;
} {
  if (!input.taxEnabled) {
    return { lines: [], totalCents: 0, customerVisibleTotalCents: 0 };
  }
  const lineCount = input.extensionCount + input.localDidCount + input.tollFreeDidCount;
  const qtyInput = {
    extensionCount: input.extensionCount,
    localDidCount: input.localDidCount,
    tollFreeDidCount: input.tollFreeDidCount,
    lineCount,
  };
  const lines: TelecomFeeEstimateLine[] = [];
  const invoiceBacked: TelecomFeeKey[] = ["salesTax", "e911", "regulatory"];

  for (const key of TELECOM_FEE_KEYS) {
    const fee = input.fees[key];
    if (!fee) continue;
    let amountCents = 0;
    let quantity: number | undefined;
    let unitCents: number | undefined;
    let note: string | undefined;
    const billedOnInvoice = invoiceBacked.includes(key);

    if (fee.enabled) {
      if (fee.mode === "ratePercent" && fee.basis === "invoice_subtotal") {
        amountCents = Math.round(input.taxableSubtotalCents * Number(fee.ratePercent || 0));
        quantity = 1;
        unitCents = amountCents;
      } else if (fee.mode === "amountCents") {
        quantity = basisQuantity(fee.basis, qtyInput);
        unitCents = Math.max(0, Number(fee.amountCents || 0));
        amountCents = quantity * unitCents;
        if (key === "e911" && fee.basis === "per_did") {
          note = "Invoice engine currently applies E911 per extension via TaxProfile until basis sync expands.";
        }
      } else if (fee.mode === "ratePercent") {
        quantity = basisQuantity(fee.basis, qtyInput);
        amountCents = Math.round(input.taxableSubtotalCents * Number(fee.ratePercent || 0));
        unitCents = amountCents;
      }
    }

    if (!fee.enabled && fee.suggested) {
      note = "Disabled — not included in estimate or invoice.";
    }
    if (!billedOnInvoice && fee.enabled) {
      note = "Estimate only — not yet emitted on invoices (Phase B).";
    }

    lines.push({
      key,
      label: fee.label,
      amountCents: fee.enabled ? amountCents : 0,
      enabled: fee.enabled,
      customerVisible: fee.customerVisible,
      suggested: fee.suggested,
      quantity,
      unitCents,
      note,
      billedOnInvoice,
    });
  }

  const totalCents = lines.filter((l) => l.enabled).reduce((s, l) => s + l.amountCents, 0);
  const customerVisibleTotalCents = lines
    .filter((l) => l.enabled && l.customerVisible)
    .reduce((s, l) => s + l.amountCents, 0);
  return { lines, totalCents, customerVisibleTotalCents };
}

export function buildTelecomFeesPayload(fees: BillingTelecomFeesConfig): BillingTelecomFeesConfig {
  const payload: BillingTelecomFeesConfig = {};
  for (const key of TELECOM_FEE_KEYS) {
    const row = fees[key];
    if (!row) continue;
    payload[key] = {
      enabled: row.enabled,
      customerVisible: row.customerVisible,
      label: row.label,
      description: row.description,
      suggested: row.suggested,
      mode: row.mode,
      ratePercent: row.mode === "ratePercent" ? row.ratePercent ?? 0 : null,
      amountCents: row.mode === "amountCents" ? row.amountCents ?? 0 : null,
      basis: row.basis,
    };
  }
  return payload;
}
