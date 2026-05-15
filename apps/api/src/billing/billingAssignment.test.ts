import test from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "@prisma/client/runtime/library";
import {
  mergeTenantBillingSettingsForAssignPreview,
  tenantPricingQuadSnapshot,
  validateCatalogBillingPlanForAssignment,
} from "./billingAssignment";
import type { TenantBillingSettingsLoaded } from "./invoiceEngine";

const basePlan = {
  id: "p-old",
  tenantId: null,
  code: "old",
  name: "Old",
  active: true,
  extensionPriceCents: 100,
  additionalPhoneNumberPriceCents: 200,
  smsPriceCents: 300,
  firstPhoneNumberFree: true,
};

const targetPlan = {
  id: "p-new",
  tenantId: null,
  code: "new",
  name: "New",
  active: true,
  extensionPriceCents: 400,
  additionalPhoneNumberPriceCents: 500,
  smsPriceCents: 600,
  firstPhoneNumberFree: false,
};

test("validateCatalogBillingPlanForAssignment rejects inactive/missing/non-catalog", () => {
  assert.equal(validateCatalogBillingPlanForAssignment(null), "billing_plan_not_found");
  assert.equal(validateCatalogBillingPlanForAssignment({ tenantId: "x", active: true }), "billing_plan_not_catalog");
  assert.equal(validateCatalogBillingPlanForAssignment({ tenantId: null, active: false }), "billing_plan_inactive");
  assert.equal(validateCatalogBillingPlanForAssignment({ tenantId: null, active: true }), null);
});

test("mergeTenantBillingSettingsForAssignPreview updates FK only when copyPlanPrices=false", () => {
  const schedDate = new Date("2028-01-01T00:00:00.000Z");
  const base = {
    billingPlanId: basePlan.id,
    billingPlan: basePlan,
    metadata: {},
    extensionPriceCents: 999,
    additionalPhoneNumberPriceCents: 888,
    smsPriceCents: 777,
    firstPhoneNumberFree: true,
    nextBillingPlanId: "sched-id",
    nextBillingPlanEffectiveAt: schedDate,
    nextBillingPlan: basePlan,
  } as unknown as TenantBillingSettingsLoaded;

  const merged = mergeTenantBillingSettingsForAssignPreview(base, targetPlan as any, { copyPlanPrices: false });
  assert.equal(merged.billingPlanId, targetPlan.id);
  assert.equal(Number(merged.extensionPriceCents), 999);
  assert.equal(merged.nextBillingPlanId, "sched-id");
  assert.deepEqual(merged.nextBillingPlanEffectiveAt, schedDate);
});

test("mergeTenantBillingSettingsForAssignPreview copyPlanPrices copies all four fields", () => {
  const base = {
    billingPlanId: basePlan.id,
    billingPlan: basePlan,
    metadata: {},
    extensionPriceCents: 999,
    additionalPhoneNumberPriceCents: 888,
    smsPriceCents: 777,
    firstPhoneNumberFree: true,
    nextBillingPlanId: null,
    nextBillingPlanEffectiveAt: null,
    nextBillingPlan: null,
  } as unknown as TenantBillingSettingsLoaded;

  const merged = mergeTenantBillingSettingsForAssignPreview(base, targetPlan as any, { copyPlanPrices: true });
  assert.deepEqual(tenantPricingQuadSnapshot(merged), {
    extensionPriceCents: 400,
    additionalPhoneNumberPriceCents: 500,
    smsPriceCents: 600,
    firstPhoneNumberFree: false,
  });
});

test("mergeTenantBillingSettingsForAssignPreview applyPricingMode updates metadata only", () => {
  const base = {
    billingPlanId: basePlan.id,
    billingPlan: basePlan,
    metadata: {},
    extensionPriceCents: 999,
    additionalPhoneNumberPriceCents: 888,
    smsPriceCents: 777,
    firstPhoneNumberFree: true,
    nextBillingPlanId: null,
    nextBillingPlanEffectiveAt: null,
    nextBillingPlan: null,
  } as unknown as TenantBillingSettingsLoaded;

  const merged = mergeTenantBillingSettingsForAssignPreview(base, targetPlan as any, {
    copyPlanPrices: false,
    applyPricingMode: "custom",
  });
  assert.deepEqual((merged.metadata as Record<string, unknown>).billingPricingMode, "custom");
  assert.equal(Number(merged.extensionPriceCents), 999);
});

test("mergeTenantBillingSettingsForAssignPreview tolerates Prisma Decimal (structuredClone-hostile)", () => {
  assert.throws(() => structuredClone({ d: new Decimal("0.05") }), /could not be cloned|clone|transfer/i);
  const schedDate = new Date("2030-02-01T00:00:00.000Z");
  const base = {
    billingPlanId: basePlan.id,
    billingPlan: basePlan,
    metadata: {},
    extensionPriceCents: 999,
    additionalPhoneNumberPriceCents: 888,
    smsPriceCents: 777,
    firstPhoneNumberFree: true,
    discountPercent: new Decimal("0"),
    taxProfile: {
      id: "tp1",
      name: "Ohio",
      state: "OH",
      county: null as string | null,
      salesTaxRate: new Decimal("0.06"),
      e911FeePerExtension: 75,
      regulatoryFeePercent: new Decimal("0"),
      regulatoryFeeEnabled: true,
      enabled: true,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      updatedAt: new Date("2020-01-02T00:00:00.000Z"),
    },
    nextBillingPlanId: null,
    nextBillingPlanEffectiveAt: schedDate,
    nextBillingPlan: null,
  } as unknown as TenantBillingSettingsLoaded;

  const merged = mergeTenantBillingSettingsForAssignPreview(base, targetPlan as any, { copyPlanPrices: false });
  assert.ok(merged.nextBillingPlanEffectiveAt instanceof Date);
  assert.deepEqual(merged.nextBillingPlanEffectiveAt, schedDate);
});
