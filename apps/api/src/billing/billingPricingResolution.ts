/**
 * Explicit billing pricing modes (stored in TenantBillingSettings.metadata.billingPricingMode).
 * Legacy = absent/not set — must match historic `settings || activePlan || default` semantics.
 */

export const BILLING_PRICING_MODE_METADATA_KEY = "billingPricingMode" as const;

export type BillingPricingModeStored = "catalog" | "custom";

/** Normalized runtime mode (`legacy` = metadata absent). */
export type BillingPricingResolvedMode = "legacy" | "catalog" | "custom";

export type PricingFieldKey =
  | "extensionPriceCents"
  | "additionalPhoneNumberPriceCents"
  | "smsPriceCents"
  | "firstPhoneNumberFree";

/** Tenant settings columns that represent explicit per-tenant unit pricing. */
export const EXPLICIT_TENANT_PRICING_FIELD_KEYS = [
  "extensionPriceCents",
  "additionalPhoneNumberPriceCents",
  "smsPriceCents",
  "firstPhoneNumberFree",
] as const satisfies readonly PricingFieldKey[];

export type PricingFieldBadge = "legacy" | "from_plan" | "tenant_override";

export type TenantBillingPricingPlanSlice = {
  extensionPriceCents?: number | null;
  additionalPhoneNumberPriceCents?: number | null;
  smsPriceCents?: number | null;
  firstPhoneNumberFree?: boolean | null;
} | null;

const DEFAULT_EXTENSION_CENTS = 3000;
const DEFAULT_PHONE_EXTRA_CENTS = 1000;
const DEFAULT_SMS_CENTS = 1000;

export function parseBillingPricingMode(metadata: unknown): BillingPricingResolvedMode {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "legacy";
  const raw = (metadata as Record<string, unknown>)[BILLING_PRICING_MODE_METADATA_KEY];
  if (raw === "catalog") return "catalog";
  if (raw === "custom") return "custom";
  return "legacy";
}

function tenantBoolFirstFree(settings: { firstPhoneNumberFree?: boolean | null }): boolean {
  return settings.firstPhoneNumberFree !== false;
}

/**
 * Exact legacy cents resolution (preserve `||` — do not switch to `??`).
 */
export function legacyResolveCents(
  settingsVal: number,
  planVal: number | null | undefined,
  hardDefault: number,
): number {
  return Number(settingsVal || planVal || hardDefault);
}

/**
 * Saving explicit tenant unit prices (including $0.00) must use custom pricing mode.
 * Legacy mode treats 0 as "inherit plan/default", which breaks complimentary SMS lines.
 */
export function shouldPromoteCustomPricingModeOnPricePatch(params: {
  hasExplicitPriceFieldPatch: boolean;
  requestedPricingMode: BillingPricingModeStored | null | undefined;
}): boolean {
  if (!params.hasExplicitPriceFieldPatch) return false;
  if (params.requestedPricingMode === "catalog") return false;
  if (params.requestedPricingMode === null) return false;
  return true;
}

function catalogPrices(plan: TenantBillingPricingPlanSlice): {
  extensionPriceCents: number;
  additionalPhoneNumberPriceCents: number;
  smsPriceCents: number;
  firstPhoneNumberFree: boolean;
  missingPlanFallback: boolean;
} {
  if (!plan) {
    return {
      extensionPriceCents: DEFAULT_EXTENSION_CENTS,
      additionalPhoneNumberPriceCents: DEFAULT_PHONE_EXTRA_CENTS,
      smsPriceCents: DEFAULT_SMS_CENTS,
      firstPhoneNumberFree: true,
      missingPlanFallback: true,
    };
  }
  return {
    extensionPriceCents: Number(plan.extensionPriceCents ?? DEFAULT_EXTENSION_CENTS),
    additionalPhoneNumberPriceCents: Number(plan.additionalPhoneNumberPriceCents ?? DEFAULT_PHONE_EXTRA_CENTS),
    smsPriceCents: Number(plan.smsPriceCents ?? DEFAULT_SMS_CENTS),
    firstPhoneNumberFree: plan.firstPhoneNumberFree !== false,
    missingPlanFallback: false,
  };
}

/** Per-field badge for admin UI when mode is legacy (compare tenant row vs active plan fallback chain). */
function legacyFieldBadge(
  key: "extensionPriceCents" | "additionalPhoneNumberPriceCents" | "smsPriceCents",
  settingsVal: number,
  plan: TenantBillingPricingPlanSlice,
): PricingFieldBadge {
  if (!plan) return "legacy";
  if (settingsVal !== 0) return "tenant_override";
  const hard =
    key === "extensionPriceCents"
      ? DEFAULT_EXTENSION_CENTS
      : key === "additionalPhoneNumberPriceCents"
        ? DEFAULT_PHONE_EXTRA_CENTS
        : DEFAULT_SMS_CENTS;
  const pv = plan?.[key];
  const fromPlanChain = legacyResolveCents(0, pv ?? undefined, hard);
  if (fromPlanChain !== hard || (pv !== null && pv !== undefined && pv !== 0)) return "from_plan";
  return "legacy";
}

/** Invoice engine never consulted BillingPlan.firstPhoneNumberFree historically — badge stays legacy/informational. */
function legacyFirstPhoneBadge(plan: TenantBillingPricingPlanSlice, settingsFirst: boolean | null | undefined): PricingFieldBadge {
  if (!plan) return "legacy";
  const tenant = tenantBoolFirstFree({ firstPhoneNumberFree: settingsFirst });
  const catalog = plan.firstPhoneNumberFree !== false;
  return tenant !== catalog ? "tenant_override" : "legacy";
}

export type BillingPricingResolution = {
  mode: BillingPricingResolvedMode;
  activePlanId: string | null;
  activePlanName: string | null;
  /** Effective values used on the invoice after this preview's activePlan selection */
  extensionPriceCents: number;
  additionalPhoneNumberPriceCents: number;
  smsPriceCents: number;
  firstPhoneNumberFree: boolean;
  fieldBadges: Record<PricingFieldKey, PricingFieldBadge>;
  banner: string;
  missingCatalogPlan: boolean;
};

export function resolveTenantBillingPricing(params: {
  mode: BillingPricingResolvedMode;
  settings: {
    extensionPriceCents: number;
    additionalPhoneNumberPriceCents: number;
    smsPriceCents: number;
    firstPhoneNumberFree?: boolean | null;
  };
  /** Already accounts for scheduled plan (next vs current). */
  activePlan:
    | (TenantBillingPricingPlanSlice & {
        id?: string | null;
        name?: string | null;
        code?: string | null;
        active?: boolean | null;
      })
    | null;
}): BillingPricingResolution {
  const { mode, settings, activePlan } = params;

  let extensionPriceCents = 0;
  let additionalPhoneNumberPriceCents = 0;
  let smsPriceCents = 0;
  let firstPhoneNumberFree = true;
  let missingCatalogPlan = false;

  const planId = activePlan && "id" in activePlan && activePlan.id ? String(activePlan.id) : null;
  const planName = activePlan && "name" in activePlan && activePlan.name ? String(activePlan.name) : null;

  if (mode === "catalog") {
    const c = catalogPrices(activePlan);
    extensionPriceCents = c.extensionPriceCents;
    additionalPhoneNumberPriceCents = c.additionalPhoneNumberPriceCents;
    smsPriceCents = c.smsPriceCents;
    firstPhoneNumberFree = c.firstPhoneNumberFree;
    missingCatalogPlan = c.missingPlanFallback;

    const fieldBadges: Record<PricingFieldKey, PricingFieldBadge> = {
      extensionPriceCents: missingCatalogPlan ? "legacy" : "from_plan",
      additionalPhoneNumberPriceCents: missingCatalogPlan ? "legacy" : "from_plan",
      smsPriceCents: missingCatalogPlan ? "legacy" : "from_plan",
      firstPhoneNumberFree: missingCatalogPlan ? "legacy" : "from_plan",
    };

    const banner = missingCatalogPlan
      ? "Catalog pricing mode: no BillingPlan linked for this period — using default platform rates."
      : `Using catalog billing plan pricing${planName ? ` (${planName})` : ""}.`;

    return {
      mode,
      activePlanId: planId,
      activePlanName: planName,
      extensionPriceCents,
      additionalPhoneNumberPriceCents,
      smsPriceCents,
      firstPhoneNumberFree,
      fieldBadges,
      banner,
      missingCatalogPlan,
    };
  }

  if (mode === "custom") {
    extensionPriceCents = Number(settings.extensionPriceCents);
    additionalPhoneNumberPriceCents = Number(settings.additionalPhoneNumberPriceCents);
    smsPriceCents = Number(settings.smsPriceCents);
    firstPhoneNumberFree = tenantBoolFirstFree(settings);

    const fieldBadges: Record<PricingFieldKey, PricingFieldBadge> = {
      extensionPriceCents: "tenant_override",
      additionalPhoneNumberPriceCents: "tenant_override",
      smsPriceCents: "tenant_override",
      firstPhoneNumberFree: "tenant_override",
    };

    const overridesPlan =
      !!activePlan &&
      (extensionPriceCents !== Number(activePlan.extensionPriceCents) ||
        additionalPhoneNumberPriceCents !== Number(activePlan.additionalPhoneNumberPriceCents) ||
        smsPriceCents !== Number(activePlan.smsPriceCents) ||
        firstPhoneNumberFree !== (activePlan.firstPhoneNumberFree !== false));

    const banner = overridesPlan
      ? "Custom tenant pricing overrides catalog values for future invoices."
      : "Custom tenant pricing (matches current plan snapshot).";

    return {
      mode,
      activePlanId: planId,
      activePlanName: planName,
      extensionPriceCents,
      additionalPhoneNumberPriceCents,
      smsPriceCents,
      firstPhoneNumberFree,
      fieldBadges,
      banner,
      missingCatalogPlan: false,
    };
  }

  // ── Legacy (byte-compatible) ─────────────────────────────────────────────
  extensionPriceCents = legacyResolveCents(settings.extensionPriceCents, activePlan?.extensionPriceCents ?? undefined, DEFAULT_EXTENSION_CENTS);
  additionalPhoneNumberPriceCents = legacyResolveCents(
    settings.additionalPhoneNumberPriceCents,
    activePlan?.additionalPhoneNumberPriceCents ?? undefined,
    DEFAULT_PHONE_EXTRA_CENTS,
  );
  smsPriceCents = legacyResolveCents(settings.smsPriceCents, activePlan?.smsPriceCents ?? undefined, DEFAULT_SMS_CENTS);
  firstPhoneNumberFree = tenantBoolFirstFree(settings);

  const fieldBadges: Record<PricingFieldKey, PricingFieldBadge> = {
    extensionPriceCents: legacyFieldBadge("extensionPriceCents", settings.extensionPriceCents, activePlan),
    additionalPhoneNumberPriceCents: legacyFieldBadge("additionalPhoneNumberPriceCents", settings.additionalPhoneNumberPriceCents, activePlan),
    smsPriceCents: legacyFieldBadge("smsPriceCents", settings.smsPriceCents, activePlan),
    firstPhoneNumberFree: legacyFirstPhoneBadge(activePlan, settings.firstPhoneNumberFree),
  };

  const banner =
    "Legacy pricing resolution — tenant amounts can shadow the catalog plan (historical behavior). Prefer Catalog or Custom for explicit control.";

  return {
    mode: "legacy",
    activePlanId: planId,
    activePlanName: planName,
    extensionPriceCents,
    additionalPhoneNumberPriceCents,
    smsPriceCents,
    firstPhoneNumberFree,
    fieldBadges,
    banner,
    missingCatalogPlan: false,
  };
}

export type BillingPlanRowForPeriodSelection = TenantBillingPricingPlanSlice & {
  id?: string | null;
  name?: string | null;
  code?: string | null;
  active?: boolean | null;
};

/**
 * BillingPlan row whose prices apply for `periodStart` (scheduled next plan wins once effective).
 * Same rule as `buildBillingInvoicePreview` / worker invoice creation.
 */
export function activeBillingPlanRowForPeriod(
  settings: {
    nextBillingPlanId?: string | null;
    nextBillingPlanEffectiveAt?: Date | null;
    billingPlan?: BillingPlanRowForPeriodSelection | null;
    nextBillingPlan?: BillingPlanRowForPeriodSelection | null;
  },
  periodStart: Date,
): BillingPlanRowForPeriodSelection | null {
  const hasScheduledChange =
    settings.nextBillingPlanId &&
    settings.nextBillingPlanEffectiveAt &&
    periodStart >= settings.nextBillingPlanEffectiveAt;
  return hasScheduledChange ? settings.nextBillingPlan ?? null : settings.billingPlan ?? null;
}

/** DB update payload for “reset to plan pricing” (also sets `billingPricingMode` = catalog). */
export function buildTenantSettingsResetToCatalog(
  plan: {
    extensionPriceCents: number;
    additionalPhoneNumberPriceCents: number;
    smsPriceCents: number;
    firstPhoneNumberFree: boolean | null;
  },
  prevMetadata: Record<string, unknown>,
): {
  extensionPriceCents: number;
  additionalPhoneNumberPriceCents: number;
  smsPriceCents: number;
  firstPhoneNumberFree: boolean;
  metadata: Record<string, unknown>;
} {
  return {
    extensionPriceCents: plan.extensionPriceCents,
    additionalPhoneNumberPriceCents: plan.additionalPhoneNumberPriceCents,
    smsPriceCents: plan.smsPriceCents,
    firstPhoneNumberFree: plan.firstPhoneNumberFree !== false,
    metadata: { ...prevMetadata, [BILLING_PRICING_MODE_METADATA_KEY]: "catalog" },
  };
}
