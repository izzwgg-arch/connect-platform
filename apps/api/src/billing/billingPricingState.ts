import type { BillingInvoicePreview } from "./invoiceEngine";
import type { BillingPlanRowForPeriodSelection } from "./billingPricingResolution";
import {
  activeBillingPlanRowForPeriod,
  parseBillingPricingMode,
  resolveTenantBillingPricing,
  type BillingPricingResolution,
  type BillingPricingResolvedMode,
  type PricingFieldKey,
} from "./billingPricingResolution";

export type BillingPricingPlanSummary = {
  id: string;
  code: string;
  name: string;
  active: boolean;
};

/** Linked BillingPlan row including catalog prices (FK mismatch compares tenant row vs these). */
export type BillingPricingLinkedPlanRow = BillingPricingPlanSummary & {
  extensionPriceCents: number;
  additionalPhoneNumberPriceCents: number;
  smsPriceCents: number;
  firstPhoneNumberFree: boolean | null;
};

export type BillingPricingScheduledNextSummary = {
  plan: BillingPricingLinkedPlanRow;
  effectiveAt: string;
};

export type BillingPricingEffectiveSource =
  | "billing_plan_catalog"
  | "billing_plan_defaults"
  | "tenant_row_custom"
  | "legacy_chain";

export type BillingPricingStateFlags = {
  catalogMissingLinkedPlan: boolean;
  customWithScheduledNext: boolean;
  linkedPlanInactive: boolean;
  tenantRowDiffersFromLinkedPlan: boolean;
  legacyUsesTenantDefaults: boolean;
  scheduledPlanAppliesToPreviewPeriod: boolean;
};

export type BillingPricingStateSettingsSlice = {
  metadata: unknown;
  billingPlanId: string | null;
  billingPlan: BillingPricingLinkedPlanRow | null;
  nextBillingPlanId: string | null;
  nextBillingPlanEffectiveAt: Date | null;
  nextBillingPlan: BillingPricingLinkedPlanRow | null;
  extensionPriceCents: number;
  additionalPhoneNumberPriceCents: number;
  smsPriceCents: number;
  firstPhoneNumberFree: boolean | null;
};

/** Row fragments accepted from diagnostics assembler or Prisma `ensureTenantBillingSettings`. */
export type TenantBillingPricingSliceInput = {
  metadata: unknown;
  billingPlanId?: string | null;
  billingPlan: BillingPricingLinkedPlanRow | PlanSliceLike | null;
  nextBillingPlanId?: string | null;
  nextBillingPlanEffectiveAt?: Date | null;
  nextBillingPlan: BillingPricingLinkedPlanRow | PlanSliceLike | null;
  extensionPriceCents: unknown;
  additionalPhoneNumberPriceCents: unknown;
  smsPriceCents: unknown;
  firstPhoneNumberFree: boolean | null;
};

type PlanSliceLike = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  extensionPriceCents: unknown;
  additionalPhoneNumberPriceCents: unknown;
  smsPriceCents: unknown;
  firstPhoneNumberFree: boolean | null;
};

export function billingPricingSettingsSliceFromLoaded(row: TenantBillingPricingSliceInput): BillingPricingStateSettingsSlice {
  const bp = row.billingPlan;
  const nb = row.nextBillingPlan;
  return {
    metadata: row.metadata,
    billingPlanId: row.billingPlanId ?? null,
    billingPlan: bp
      ? {
          id: bp.id,
          code: bp.code,
          name: bp.name,
          active: bp.active !== false,
          extensionPriceCents: Number(bp.extensionPriceCents ?? 0),
          additionalPhoneNumberPriceCents: Number(bp.additionalPhoneNumberPriceCents ?? 0),
          smsPriceCents: Number(bp.smsPriceCents ?? 0),
          firstPhoneNumberFree: bp.firstPhoneNumberFree,
        }
      : null,
    nextBillingPlanId: row.nextBillingPlanId ?? null,
    nextBillingPlanEffectiveAt: row.nextBillingPlanEffectiveAt ?? null,
    nextBillingPlan: nb
      ? {
          id: nb.id,
          code: nb.code,
          name: nb.name,
          active: nb.active !== false,
          extensionPriceCents: Number(nb.extensionPriceCents ?? 0),
          additionalPhoneNumberPriceCents: Number(nb.additionalPhoneNumberPriceCents ?? 0),
          smsPriceCents: Number(nb.smsPriceCents ?? 0),
          firstPhoneNumberFree: nb.firstPhoneNumberFree,
        }
      : null,
    extensionPriceCents: Number(row.extensionPriceCents ?? 0),
    additionalPhoneNumberPriceCents: Number(row.additionalPhoneNumberPriceCents ?? 0),
    smsPriceCents: Number(row.smsPriceCents ?? 0),
    firstPhoneNumberFree: row.firstPhoneNumberFree,
  };
}

function summarizePlanRow(row: BillingPricingLinkedPlanRow | BillingPlanRowForPeriodSelection | null): BillingPricingPlanSummary | null {
  if (!row || !row.id) return null;
  const id = String(row.id);
  const code = "code" in row && row.code != null ? String(row.code) : "";
  const name = "name" in row && row.name != null ? String(row.name) : "";
  const active = "active" in row ? row.active !== false : true;
  return { id, code, name, active };
}

function pricingQuadFromTenant(settings: BillingPricingStateSettingsSlice) {
  return {
    extensionPriceCents: Number(settings.extensionPriceCents),
    additionalPhoneNumberPriceCents: Number(settings.additionalPhoneNumberPriceCents),
    smsPriceCents: Number(settings.smsPriceCents),
    firstPhoneNumberFree: settings.firstPhoneNumberFree !== false,
  };
}

function diffTenantVsLinkedPlanFk(
  tenant: ReturnType<typeof pricingQuadFromTenant>,
  plan: BillingPricingLinkedPlanRow | null,
): Record<PricingFieldKey, boolean> {
  if (!plan) {
    return {
      extensionPriceCents: true,
      additionalPhoneNumberPriceCents: true,
      smsPriceCents: true,
      firstPhoneNumberFree: true,
    };
  }
  const planQuad = {
    extensionPriceCents: Number(plan.extensionPriceCents),
    additionalPhoneNumberPriceCents: Number(plan.additionalPhoneNumberPriceCents),
    smsPriceCents: Number(plan.smsPriceCents),
    firstPhoneNumberFree: plan.firstPhoneNumberFree !== false,
  };
  return {
    extensionPriceCents: tenant.extensionPriceCents !== planQuad.extensionPriceCents,
    additionalPhoneNumberPriceCents: tenant.additionalPhoneNumberPriceCents !== planQuad.additionalPhoneNumberPriceCents,
    smsPriceCents: tenant.smsPriceCents !== planQuad.smsPriceCents,
    firstPhoneNumberFree: tenant.firstPhoneNumberFree !== planQuad.firstPhoneNumberFree,
  };
}

function effectivePricingSource(resolution: BillingPricingResolution): BillingPricingEffectiveSource {
  if (resolution.mode === "catalog") return resolution.missingCatalogPlan ? "billing_plan_defaults" : "billing_plan_catalog";
  if (resolution.mode === "custom") return "tenant_row_custom";
  return "legacy_chain";
}

export type DerivedBillingPricingState = {
  mode: BillingPricingResolvedMode;
  currentPlan: BillingPricingPlanSummary | null;
  scheduledNext: BillingPricingScheduledNextSummary | null;
  activePlanForPeriod: BillingPricingPlanSummary | null;
  effectivePricingSource: BillingPricingEffectiveSource;
  resolution: BillingPricingResolution;
  flags: BillingPricingStateFlags;
  explanationLines: string[];
  warnings: string[];
};

/**
 * Normalized pricing state for admins — uses `parseBillingPricingMode`, `resolveTenantBillingPricing`,
 * and the same active-plan timing rule as invoices (`activeBillingPlanRowForPeriod`).
 */
export function deriveBillingPricingState(input: {
  settings: BillingPricingStateSettingsSlice;
  preview: BillingInvoicePreview;
}): DerivedBillingPricingState {
  const { settings, preview } = input;
  const mode = parseBillingPricingMode(settings.metadata);

  const activeRow = activeBillingPlanRowForPeriod(settings, preview.periodStart);
  const resolution = resolveTenantBillingPricing({
    mode,
    settings: {
      extensionPriceCents: Number(settings.extensionPriceCents),
      additionalPhoneNumberPriceCents: Number(settings.additionalPhoneNumberPriceCents),
      smsPriceCents: Number(settings.smsPriceCents),
      firstPhoneNumberFree: settings.firstPhoneNumberFree,
    },
    activePlan: activeRow,
  });

  const tenantQuad = pricingQuadFromTenant(settings);
  const linkedSummary = summarizePlanRow(settings.billingPlan);
  const fkDiff = diffTenantVsLinkedPlanFk(tenantQuad, settings.billingPlan);

  const scheduledPlanAppliesToPreviewPeriod = !!(
    settings.nextBillingPlanId &&
    settings.nextBillingPlanEffectiveAt &&
    preview.periodStart >= settings.nextBillingPlanEffectiveAt
  );

  const scheduledNext =
    settings.nextBillingPlanId && settings.nextBillingPlanEffectiveAt && settings.nextBillingPlan
      ? {
          plan: settings.nextBillingPlan,
          effectiveAt: settings.nextBillingPlanEffectiveAt.toISOString(),
        }
      : null;

  const activePlanForPeriodSummary = summarizePlanRow(activeRow);

  const flags: BillingPricingStateFlags = {
    catalogMissingLinkedPlan: mode === "catalog" && !settings.billingPlanId,
    customWithScheduledNext: mode === "custom" && !!settings.nextBillingPlanId,
    linkedPlanInactive: !!(settings.billingPlan && settings.billingPlan.active === false),
    tenantRowDiffersFromLinkedPlan: Object.values(fkDiff).some(Boolean),
    legacyUsesTenantDefaults:
      mode === "legacy" &&
      (resolution.fieldBadges.extensionPriceCents === "tenant_override" ||
        resolution.fieldBadges.additionalPhoneNumberPriceCents === "tenant_override" ||
        resolution.fieldBadges.smsPriceCents === "tenant_override" ||
        resolution.fieldBadges.firstPhoneNumberFree === "tenant_override"),
    scheduledPlanAppliesToPreviewPeriod,
  };

  const warnings: string[] = [];
  if (flags.catalogMissingLinkedPlan) {
    warnings.push(
      "Catalog pricing mode is selected but this tenant has no billingPlanId — link a plan or switch pricing source.",
    );
  }
  if (flags.customWithScheduledNext) {
    warnings.push(
      "Custom pricing mode while a scheduled plan change exists — invoice line-items still follow the tenant row until you change pricing source or the schedule takes effect.",
    );
  }
  if (flags.linkedPlanInactive) {
    warnings.push("The current linked BillingPlan is inactive — assign an active catalog plan.");
  }
  if (flags.tenantRowDiffersFromLinkedPlan) {
    warnings.push(
      "Stored tenant prices differ from the current linked BillingPlan row (catalog invoices ignore stale tenant cents).",
    );
  }
  if (flags.legacyUsesTenantDefaults) {
    warnings.push(
      "Legacy pricing mode blends tenant defaults with plan values — prefer Catalog or Custom for predictable invoices.",
    );
  }

  const explanationLines = preview.pricingPreviewExplanation?.explanationLines?.length
    ? [...preview.pricingPreviewExplanation.explanationLines]
    : [];

  return {
    mode,
    currentPlan: linkedSummary,
    scheduledNext,
    activePlanForPeriod: activePlanForPeriodSummary,
    effectivePricingSource: effectivePricingSource(resolution),
    resolution,
    flags,
    explanationLines,
    warnings,
  };
}

/**
 * Deep plain snapshot for HTTP JSON — breaks any accidental Prisma/object prototypes on nested
 * plan rows before Fastify/browser tooling walks the graph.
 */
export function serializeDerivedBillingPricingStateForWire(state: DerivedBillingPricingState): DerivedBillingPricingState {
  const r = state.resolution;
  return {
    mode: state.mode,
    currentPlan: state.currentPlan ? { ...state.currentPlan } : null,
    scheduledNext: state.scheduledNext
      ? {
          plan: {
            id: state.scheduledNext.plan.id,
            code: state.scheduledNext.plan.code,
            name: state.scheduledNext.plan.name,
            active: state.scheduledNext.plan.active !== false,
            extensionPriceCents: Number(state.scheduledNext.plan.extensionPriceCents),
            additionalPhoneNumberPriceCents: Number(state.scheduledNext.plan.additionalPhoneNumberPriceCents),
            smsPriceCents: Number(state.scheduledNext.plan.smsPriceCents),
            firstPhoneNumberFree: state.scheduledNext.plan.firstPhoneNumberFree !== false,
          },
          effectiveAt: state.scheduledNext.effectiveAt,
        }
      : null,
    activePlanForPeriod: state.activePlanForPeriod ? { ...state.activePlanForPeriod } : null,
    effectivePricingSource: state.effectivePricingSource,
    resolution: {
      mode: r.mode,
      activePlanId: r.activePlanId,
      activePlanName: r.activePlanName,
      extensionPriceCents: Number(r.extensionPriceCents),
      additionalPhoneNumberPriceCents: Number(r.additionalPhoneNumberPriceCents),
      smsPriceCents: Number(r.smsPriceCents),
      firstPhoneNumberFree: r.firstPhoneNumberFree,
      fieldBadges: {
        extensionPriceCents: r.fieldBadges.extensionPriceCents,
        additionalPhoneNumberPriceCents: r.fieldBadges.additionalPhoneNumberPriceCents,
        smsPriceCents: r.fieldBadges.smsPriceCents,
        firstPhoneNumberFree: r.fieldBadges.firstPhoneNumberFree,
      },
      banner: r.banner,
      missingCatalogPlan: r.missingCatalogPlan,
    },
    flags: { ...state.flags },
    explanationLines: [...state.explanationLines],
    warnings: [...state.warnings],
  };
}
