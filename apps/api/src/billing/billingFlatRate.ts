import type { BillingUsageSnapshot } from "./usage";

/** Stored on `TenantBillingSettings.metadata.billingFlatRate` — no Prisma migration. */
export const BILLING_FLAT_RATE_METADATA_KEY = "billingFlatRate";

export type BillingFlatRateAppliesTo = "extensions";

export type BillingFlatRateConfig = {
  enabled: boolean;
  amountCents: number;
  label?: string;
  appliesTo: BillingFlatRateAppliesTo;
};

export type ExtensionInvoiceLine = {
  type: "EXTENSION";
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  taxable: boolean;
  metadata?: Record<string, unknown>;
};

export function parseBillingFlatRate(metadata: unknown): BillingFlatRateConfig | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[BILLING_FLAT_RATE_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const enabled = o.enabled === true;
  const amountCents = Number(o.amountCents);
  const appliesTo = o.appliesTo === "extensions" ? "extensions" : "extensions";
  const label = typeof o.label === "string" ? o.label.trim().slice(0, 120) : undefined;
  return {
    enabled,
    amountCents: Number.isFinite(amountCents) ? Math.max(0, Math.round(amountCents)) : 0,
    ...(label ? { label } : {}),
    appliesTo,
  };
}

/** Active flat rate for extension billing (enabled + positive amount + extensions scope). */
export function activeExtensionsFlatRate(metadata: unknown): BillingFlatRateConfig | null {
  const cfg = parseBillingFlatRate(metadata);
  if (!cfg?.enabled || cfg.appliesTo !== "extensions" || cfg.amountCents < 1) return null;
  return cfg;
}

export function validateBillingFlatRateInput(
  input: BillingFlatRateConfig | null | undefined,
): { ok: true; value: BillingFlatRateConfig | null } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "billingFlatRate must be an object." };
  }
  const enabled = input.enabled === true;
  const amountCents = Math.round(Number(input.amountCents));
  const appliesTo = input.appliesTo === "extensions" ? "extensions" : "extensions";
  const label = typeof input.label === "string" ? input.label.trim().slice(0, 120) : undefined;
  if (enabled && (!Number.isFinite(amountCents) || amountCents < 1)) {
    return { ok: false, error: "Flat monthly rate requires a positive amount when enabled." };
  }
  if (!enabled && amountCents > 0) {
    return {
      ok: true,
      value: { enabled: false, amountCents, ...(label ? { label } : {}), appliesTo },
    };
  }
  return {
    ok: true,
    value: {
      enabled,
      amountCents: enabled ? amountCents : Math.max(0, amountCents),
      ...(label ? { label } : {}),
      appliesTo,
    },
  };
}

export function mergeBillingFlatRateIntoMetadata(
  prev: unknown,
  flatRate: BillingFlatRateConfig | null | undefined,
): Record<string, unknown> {
  const prevMeta =
    prev && typeof prev === "object" && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  if (flatRate === undefined) return prevMeta;
  if (flatRate === null) {
    delete prevMeta[BILLING_FLAT_RATE_METADATA_KEY];
    return prevMeta;
  }
  return { ...prevMeta, [BILLING_FLAT_RATE_METADATA_KEY]: flatRate };
}

export function buildExtensionInvoiceLine(input: {
  usage: BillingUsageSnapshot;
  extensionBillableCount: number;
  extensionPriceCents: number;
  metadata: unknown;
}): ExtensionInvoiceLine | null {
  const { usage, extensionBillableCount, extensionPriceCents, metadata } = input;
  if (extensionBillableCount <= 0) return null;

  const flat = activeExtensionsFlatRate(metadata);
  if (flat) {
    const baseLabel = flat.label?.trim() || "Extensions flat monthly rate";
    const description =
      extensionBillableCount > 0
        ? `${baseLabel} (${extensionBillableCount} billing extension${extensionBillableCount === 1 ? "" : "s"}; ${usage.extensionCount} active)`
        : baseLabel;
    return {
      type: "EXTENSION",
      description,
      quantity: 1,
      unitPriceCents: flat.amountCents,
      amountCents: flat.amountCents,
      taxable: true,
      metadata: {
        flatRate: true,
        flatRateAppliesTo: "extensions",
        flatRateAmountCents: flat.amountCents,
        extensionCount: extensionBillableCount,
        suggestedExtensionCount: usage.extensionCount,
        extensionIds: usage.extensionIds,
      },
    };
  }

  return {
    type: "EXTENSION",
    description: "Billable extensions",
    quantity: extensionBillableCount,
    unitPriceCents: extensionPriceCents,
    amountCents: extensionBillableCount * extensionPriceCents,
    taxable: true,
    metadata: {
      extensionIds: usage.extensionIds,
      suggestedExtensionCount: usage.extensionCount,
    },
  };
}
