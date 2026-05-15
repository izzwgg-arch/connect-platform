import test from "node:test";
import assert from "node:assert/strict";
import {
  BILLING_PRICING_MODE_METADATA_KEY,
  activeBillingPlanRowForPeriod,
  buildTenantSettingsResetToCatalog,
  legacyResolveCents,
  parseBillingPricingMode,
  resolveTenantBillingPricing,
} from "./billingPricingResolution";

const planSample = {
  id: "p1",
  code: "pro",
  name: "Pro",
  active: true,
  extensionPriceCents: 5000,
  additionalPhoneNumberPriceCents: 2000,
  smsPriceCents: 1500,
  firstPhoneNumberFree: false,
};

test("parseBillingPricingMode: absent or unknown → legacy", () => {
  assert.equal(parseBillingPricingMode(undefined), "legacy");
  assert.equal(parseBillingPricingMode(null), "legacy");
  assert.equal(parseBillingPricingMode({}), "legacy");
  assert.equal(parseBillingPricingMode({ [BILLING_PRICING_MODE_METADATA_KEY]: "nope" }), "legacy");
});

test("parseBillingPricingMode: catalog / custom", () => {
  assert.equal(parseBillingPricingMode({ [BILLING_PRICING_MODE_METADATA_KEY]: "catalog" }), "catalog");
  assert.equal(parseBillingPricingMode({ [BILLING_PRICING_MODE_METADATA_KEY]: "custom" }), "custom");
});

test("legacyResolveCents matches historic || semantics (0 falls through)", () => {
  assert.equal(legacyResolveCents(0, 4000, 3000), 4000);
  assert.equal(legacyResolveCents(0, 0, 3000), 3000);
  assert.equal(legacyResolveCents(2500, 4000, 3000), 2500);
});

test("resolveTenantBillingPricing: legacy matches plan-fallback when tenant cents are 0", () => {
  const r = resolveTenantBillingPricing({
    mode: "legacy",
    settings: {
      extensionPriceCents: 0,
      additionalPhoneNumberPriceCents: 0,
      smsPriceCents: 0,
      firstPhoneNumberFree: true,
    },
    activePlan: planSample,
  });
  assert.equal(r.mode, "legacy");
  assert.equal(r.extensionPriceCents, 5000);
  assert.equal(r.additionalPhoneNumberPriceCents, 2000);
  assert.equal(r.smsPriceCents, 1500);
  assert.equal(r.firstPhoneNumberFree, true);
});

test("resolveTenantBillingPricing: custom uses tenant ints and first-phone flag even if plan differs", () => {
  const r = resolveTenantBillingPricing({
    mode: "custom",
    settings: {
      extensionPriceCents: 9900,
      additionalPhoneNumberPriceCents: 500,
      smsPriceCents: 500,
      firstPhoneNumberFree: true,
    },
    activePlan: planSample,
  });
  assert.equal(r.extensionPriceCents, 9900);
  assert.equal(r.additionalPhoneNumberPriceCents, 500);
  assert.equal(r.smsPriceCents, 500);
  assert.equal(r.firstPhoneNumberFree, true);
});

test("resolveTenantBillingPricing: catalog pulls all four fields from activePlan", () => {
  const r = resolveTenantBillingPricing({
    mode: "catalog",
    settings: {
      extensionPriceCents: 9900,
      additionalPhoneNumberPriceCents: 500,
      smsPriceCents: 500,
      firstPhoneNumberFree: true,
    },
    activePlan: planSample,
  });
  assert.equal(r.extensionPriceCents, 5000);
  assert.equal(r.additionalPhoneNumberPriceCents, 2000);
  assert.equal(r.smsPriceCents, 1500);
  assert.equal(r.firstPhoneNumberFree, false);
  assert.equal(r.fieldBadges.extensionPriceCents, "from_plan");
});

test("resolveTenantBillingPricing: catalog with no plan uses defaults + missingCatalogPlan", () => {
  const r = resolveTenantBillingPricing({
    mode: "catalog",
    settings: {
      extensionPriceCents: 9900,
      additionalPhoneNumberPriceCents: 500,
      smsPriceCents: 500,
      firstPhoneNumberFree: false,
    },
    activePlan: null as any,
  });
  assert.equal(r.extensionPriceCents, 3000);
  assert.equal(r.additionalPhoneNumberPriceCents, 1000);
  assert.equal(r.smsPriceCents, 1000);
  assert.equal(r.firstPhoneNumberFree, true);
  assert.equal(r.missingCatalogPlan, true);
});

test("buildTenantSettingsResetToCatalog copies four plan fields + sets metadata catalog", () => {
  const u = buildTenantSettingsResetToCatalog(
    {
      extensionPriceCents: 4242,
      additionalPhoneNumberPriceCents: 2222,
      smsPriceCents: 333,
      firstPhoneNumberFree: false,
    },
    { taxProviderId: "tax_profile_v1", other: true },
  );
  assert.equal(u.extensionPriceCents, 4242);
  assert.equal(u.additionalPhoneNumberPriceCents, 2222);
  assert.equal(u.smsPriceCents, 333);
  assert.equal(u.firstPhoneNumberFree, false);
  assert.equal(u.metadata[BILLING_PRICING_MODE_METADATA_KEY], "catalog");
  assert.equal(u.metadata.taxProviderId, "tax_profile_v1");
  assert.equal(u.metadata.other, true);
});

test("resolveTenantBillingPricing: scheduled next plan as activePlan (catalog)", () => {
  const next = { ...planSample, id: "p2", name: "Enterprise", extensionPriceCents: 12000 };
  const r = resolveTenantBillingPricing({
    mode: "catalog",
    settings: {
      extensionPriceCents: 3000,
      additionalPhoneNumberPriceCents: 1000,
      smsPriceCents: 1000,
      firstPhoneNumberFree: true,
    },
    activePlan: next,
  });
  assert.equal(r.activePlanId, "p2");
  assert.equal(r.extensionPriceCents, 12000);
});

test("activeBillingPlanRowForPeriod: current plan before scheduled effective date", () => {
  const cur = {
    ...planSample,
    id: "cur",
    code: "cur",
    name: "Cur",
  };
  const next = {
    ...planSample,
    id: "next",
    code: "next",
    name: "Next",
    extensionPriceCents: 9000,
  };
  const effectiveAt = new Date("2027-09-01T00:00:00.000Z");
  const row = activeBillingPlanRowForPeriod(
    {
      billingPlan: cur,
      nextBillingPlan: next,
      nextBillingPlanId: next.id,
      nextBillingPlanEffectiveAt: effectiveAt,
    },
    new Date("2027-08-01T00:00:00.000Z"),
  );
  assert.equal(row?.id, cur.id);
});

test("activeBillingPlanRowForPeriod: scheduled plan on or after effective date", () => {
  const cur = { ...planSample, id: "cur", code: "cur", name: "Cur" };
  const next = {
    ...planSample,
    id: "next",
    code: "next",
    name: "Next",
    extensionPriceCents: 9000,
  };
  const effectiveAt = new Date("2027-09-01T00:00:00.000Z");
  const row = activeBillingPlanRowForPeriod(
    {
      billingPlan: cur,
      nextBillingPlan: next,
      nextBillingPlanId: next.id,
      nextBillingPlanEffectiveAt: effectiveAt,
    },
    effectiveAt,
  );
  assert.equal(row?.id, next.id);
});
