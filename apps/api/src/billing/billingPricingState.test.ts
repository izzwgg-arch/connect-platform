import test from "node:test";
import assert from "node:assert/strict";
import { BILLING_PRICING_MODE_METADATA_KEY } from "./billingPricingResolution";
import type { BillingInvoicePreview } from "./invoiceEngine";
import type { BillingPricingResolution } from "./billingPricingResolution";
import { activeBillingPlanRowForPeriod } from "./billingPricingResolution";
import { buildPricingPreviewExplanation } from "./billingPricingExplanation";
import { deriveBillingPricingState } from "./billingPricingState";

const planPro = {
  id: "p-pro",
  code: "pro",
  name: "Pro",
  active: true,
  extensionPriceCents: 5000,
  additionalPhoneNumberPriceCents: 2000,
  smsPriceCents: 1500,
  firstPhoneNumberFree: false,
};

function wrapPreview(opts: {
  pricingMode: BillingPricingResolution["mode"];
  resolution: BillingPricingResolution;
  pricingPreviewExplanation: NonNullable<BillingInvoicePreview["pricingPreviewExplanation"]>;
  periodStart?: Date;
}): BillingInvoicePreview {
  const periodStart = opts.periodStart ?? new Date("2027-06-01T00:00:00.000Z");
  return {
    tenantId: "tenant-x",
    periodStart,
    periodEnd: new Date("2027-06-30T23:59:59.999Z"),
    dueDate: new Date("2027-07-15T00:00:00.000Z"),
    usage: {} as BillingInvoicePreview["usage"],
    lineItems: [],
    subtotalCents: 0,
    taxCents: 0,
    totalCents: 0,
    taxCalculationAudit: {} as BillingInvoicePreview["taxCalculationAudit"],
    pricingResolution: opts.resolution,
    pricingPreviewExplanation: opts.pricingPreviewExplanation,
  };
}

function explainWrap(input: Parameters<typeof buildPricingPreviewExplanation>[0]): BillingInvoicePreview {
  const expl = buildPricingPreviewExplanation(input);
  return wrapPreview({
    pricingMode: input.pricingMode,
    resolution: input.pricingResolution,
    pricingPreviewExplanation: expl,
  });
}

function resolutionCatalogMissingPlan(): BillingPricingResolution {
  return {
    mode: "catalog",
    activePlanId: null,
    activePlanName: null,
    extensionPriceCents: 3000,
    additionalPhoneNumberPriceCents: 1000,
    smsPriceCents: 1000,
    firstPhoneNumberFree: true,
    fieldBadges: {
      extensionPriceCents: "legacy",
      additionalPhoneNumberPriceCents: "legacy",
      smsPriceCents: "legacy",
      firstPhoneNumberFree: "legacy",
    },
    banner: "",
    missingCatalogPlan: true,
  };
}

test("deriveBillingPricingState: catalog + missing billingPlanId → warning + defaults source", () => {
  const resolution = resolutionCatalogMissingPlan();
  const preview = wrapPreview({
    pricingMode: "catalog",
    resolution,
    pricingPreviewExplanation: buildPricingPreviewExplanation({
      pricingMode: "catalog",
      pricingResolution: resolution,
      tenantPricing: { extensionPriceCents: 0, additionalPhoneNumberPriceCents: 0, smsPriceCents: 0, firstPhoneNumberFree: true },
      hasScheduledChange: false,
      activePlanForPreview: null,
    }),
  });
  const st = deriveBillingPricingState({
    settings: {
      metadata: { [BILLING_PRICING_MODE_METADATA_KEY]: "catalog" },
      billingPlanId: null,
      billingPlan: null,
      nextBillingPlanId: null,
      nextBillingPlanEffectiveAt: null,
      nextBillingPlan: null,
      extensionPriceCents: 0,
      additionalPhoneNumberPriceCents: 0,
      smsPriceCents: 0,
      firstPhoneNumberFree: true,
    },
    preview,
  });
  assert.equal(st.effectivePricingSource, "billing_plan_defaults");
  assert.ok(st.flags.catalogMissingLinkedPlan);
  assert.ok(st.warnings.some((w) => /billingPlanId/i.test(w)));
});

test("deriveBillingPricingState: custom + scheduled next → warning flag", () => {
  const next = { ...planPro, id: "p-next", code: "next", name: "Next" };
  const resolution = {
    mode: "custom" as const,
    activePlanId: planPro.id,
    activePlanName: planPro.name,
    extensionPriceCents: 111,
    additionalPhoneNumberPriceCents: 222,
    smsPriceCents: 333,
    firstPhoneNumberFree: true,
    fieldBadges: {
      extensionPriceCents: "tenant_override" as const,
      additionalPhoneNumberPriceCents: "tenant_override" as const,
      smsPriceCents: "tenant_override" as const,
      firstPhoneNumberFree: "tenant_override" as const,
    },
    banner: "",
    missingCatalogPlan: false,
  };
  const preview = explainWrap({
    pricingMode: "custom",
    pricingResolution: resolution,
    tenantPricing: {
      extensionPriceCents: 111,
      additionalPhoneNumberPriceCents: 222,
      smsPriceCents: 333,
      firstPhoneNumberFree: true,
    },
    hasScheduledChange: false,
    activePlanForPreview: planPro,
  });
  const st = deriveBillingPricingState({
    settings: {
      metadata: { [BILLING_PRICING_MODE_METADATA_KEY]: "custom" },
      billingPlanId: planPro.id,
      billingPlan: planPro,
      nextBillingPlanId: next.id,
      nextBillingPlanEffectiveAt: new Date("2027-08-01T00:00:00.000Z"),
      nextBillingPlan: next,
      extensionPriceCents: 111,
      additionalPhoneNumberPriceCents: 222,
      smsPriceCents: 333,
      firstPhoneNumberFree: true,
    },
    preview,
  });
  assert.ok(st.flags.customWithScheduledNext);
  assert.ok(st.warnings.some((w) => /scheduled plan/i.test(w)));
});

test("deriveBillingPricingState: inactive linked plan flag", () => {
  const inactive = { ...planPro, active: false };
  const resolution = {
    mode: "catalog" as const,
    activePlanId: inactive.id,
    activePlanName: inactive.name,
    extensionPriceCents: 5000,
    additionalPhoneNumberPriceCents: 2000,
    smsPriceCents: 1500,
    firstPhoneNumberFree: false,
    fieldBadges: {
      extensionPriceCents: "from_plan" as const,
      additionalPhoneNumberPriceCents: "from_plan" as const,
      smsPriceCents: "from_plan" as const,
      firstPhoneNumberFree: "from_plan" as const,
    },
    banner: "",
    missingCatalogPlan: false,
  };
  const preview = explainWrap({
    pricingMode: "catalog",
    pricingResolution: resolution,
    tenantPricing: { extensionPriceCents: 5000, additionalPhoneNumberPriceCents: 2000, smsPriceCents: 1500, firstPhoneNumberFree: false },
    hasScheduledChange: false,
    activePlanForPreview: inactive,
  });
  const st = deriveBillingPricingState({
    settings: {
      metadata: { [BILLING_PRICING_MODE_METADATA_KEY]: "catalog" },
      billingPlanId: inactive.id,
      billingPlan: inactive,
      nextBillingPlanId: null,
      nextBillingPlanEffectiveAt: null,
      nextBillingPlan: null,
      extensionPriceCents: 5000,
      additionalPhoneNumberPriceCents: 2000,
      smsPriceCents: 1500,
      firstPhoneNumberFree: false,
    },
    preview,
  });
  assert.ok(st.flags.linkedPlanInactive);
});

test("deriveBillingPricingState: scheduled plan applies → activeBillingPlanRowForPeriod picks next", () => {
  const next = { ...planPro, id: "p-next", code: "next", name: "Next", extensionPriceCents: 9000 };
  const effectiveAt = new Date("2027-06-01T00:00:00.000Z");
  const activeRow = activeBillingPlanRowForPeriod(
    {
      billingPlan: planPro,
      nextBillingPlan: next,
      nextBillingPlanId: next.id,
      nextBillingPlanEffectiveAt: effectiveAt,
    },
    effectiveAt,
  );
  assert.equal(activeRow?.id, next.id);
});

test("deriveBillingPricingState resolution matches recomputed catalog resolution", () => {
  const resolution = {
    mode: "catalog" as const,
    activePlanId: planPro.id,
    activePlanName: planPro.name,
    extensionPriceCents: 5000,
    additionalPhoneNumberPriceCents: 2000,
    smsPriceCents: 1500,
    firstPhoneNumberFree: false,
    fieldBadges: {
      extensionPriceCents: "from_plan" as const,
      additionalPhoneNumberPriceCents: "from_plan" as const,
      smsPriceCents: "from_plan" as const,
      firstPhoneNumberFree: "from_plan" as const,
    },
    banner: "",
    missingCatalogPlan: false,
  };
  const preview = wrapPreview({
    pricingMode: "catalog",
    resolution,
    pricingPreviewExplanation: buildPricingPreviewExplanation({
      pricingMode: "catalog",
      pricingResolution: resolution,
      tenantPricing: { extensionPriceCents: 9999, additionalPhoneNumberPriceCents: 1, smsPriceCents: 1, firstPhoneNumberFree: true },
      hasScheduledChange: false,
      activePlanForPreview: planPro,
    }),
  });
  const st = deriveBillingPricingState({
    settings: {
      metadata: { [BILLING_PRICING_MODE_METADATA_KEY]: "catalog" },
      billingPlanId: planPro.id,
      billingPlan: planPro,
      nextBillingPlanId: null,
      nextBillingPlanEffectiveAt: null,
      nextBillingPlan: null,
      extensionPriceCents: 9999,
      additionalPhoneNumberPriceCents: 1,
      smsPriceCents: 1,
      firstPhoneNumberFree: true,
    },
    preview,
  });
  assert.deepEqual(
    { ...st.resolution, banner: "" },
    { ...resolution, banner: "" },
  );
});
