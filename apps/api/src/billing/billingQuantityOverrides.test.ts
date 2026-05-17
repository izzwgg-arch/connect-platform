import test from "node:test";
import assert from "node:assert/strict";
import { mergeTenantBillingSettingsMetadata } from "./billingTenantSettingsMetadata";
import {
  BILLING_QUANTITY_OVERRIDE_KEYS,
  mergeBillingQuantityOverridesIntoMetadata,
  parseBillingQuantityOverrides,
  resolveBillingQuantities,
  validateBillingQuantityOverridesInput,
} from "./billingQuantityOverrides";

const baseUsage = {
  tenantId: "t1",
  extensionCount: 3,
  phoneNumberCount: 3,
  localPhoneNumberCount: 3,
  tollFreePhoneNumberCount: 0,
  localBillablePhoneNumberCount: 2,
  tollFreeBillablePhoneNumberCount: 0,
  additionalPhoneNumberCount: 2,
  smsEnabled: true,
  extensionIds: ["e1", "e2", "e3"],
  phoneNumberIds: ["p1", "p2", "p3"],
  localPhoneNumberIds: ["p1", "p2", "p3"],
  tollFreePhoneNumberIds: [] as string[],
};

test("resolveBillingQuantities: auto matches system usage", () => {
  const r = resolveBillingQuantities({
    usage: baseUsage,
    metadata: {},
    firstPhoneNumberFree: true,
  });
  assert.equal(r.billing.extensions, 3);
  assert.equal(r.billing.phoneNumbers, 2);
  assert.equal(r.billing.smsPackages, 1);
  assert.equal(r.billing.virtualExtensions, 0);
  assert.equal(r.modes.extensions, "auto");
});

test("resolveBillingQuantities: manual extension and phone overrides", () => {
  const r = resolveBillingQuantities({
    usage: baseUsage,
    metadata: {
      billingQuantityOverrides: {
        extensions: { mode: "manual", quantity: 5 },
        phoneNumbers: { mode: "manual", quantity: 4 },
      },
    },
    firstPhoneNumberFree: true,
  });
  assert.equal(r.billing.extensions, 5);
  assert.equal(r.billing.phoneNumbers, 4);
  assert.equal(r.suggested.phoneNumbersBillable, 2);
});

test("validateBillingQuantityOverridesInput: rejects negative manual quantity", () => {
  const r = validateBillingQuantityOverridesInput({
    extensions: { mode: "manual", quantity: -1 },
  });
  assert.equal(r.ok, false);
});

test("validateBillingQuantityOverridesInput: persists tollFreeNumbers manual qty", () => {
  const r = validateBillingQuantityOverridesInput({
    tollFreeNumbers: { mode: "manual", quantity: 1 },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value?.tollFreeNumbers?.mode, "manual");
  assert.equal(r.value?.tollFreeNumbers?.quantity, 1);
});

test("validateBillingQuantityOverridesInput: rejects negative tollFreeNumbers", () => {
  const r = validateBillingQuantityOverridesInput({
    tollFreeNumbers: { mode: "manual", quantity: -1 },
  });
  assert.equal(r.ok, false);
});

test("parseBillingQuantityOverrides: reads tollFreeNumbers from metadata", () => {
  const parsed = parseBillingQuantityOverrides({
    billingQuantityOverrides: {
      tollFreeNumbers: { mode: "manual", quantity: 1 },
      extensions: { mode: "auto", quantity: null },
    },
  });
  assert.equal(parsed?.tollFreeNumbers?.mode, "manual");
  assert.equal(parsed?.tollFreeNumbers?.quantity, 1);
});

test("resolveBillingQuantities: manual tollFreeNumbers when suggested is 0", () => {
  const r = resolveBillingQuantities({
    usage: { ...baseUsage, tollFreePhoneNumberCount: 0, tollFreeBillablePhoneNumberCount: 0 },
    metadata: {
      billingQuantityOverrides: {
        tollFreeNumbers: { mode: "manual", quantity: 1 },
      },
    },
    firstPhoneNumberFree: true,
  });
  assert.equal(r.suggested.tollFreeNumbersBillable, 0);
  assert.equal(r.billing.tollFreeNumbers, 1);
  assert.equal(r.modes.tollFreeNumbers, "manual");
});

test("BILLING_QUANTITY_OVERRIDE_KEYS includes tollFreeNumbers", () => {
  assert.ok(BILLING_QUANTITY_OVERRIDE_KEYS.includes("tollFreeNumbers"));
});

test("mergeTenantBillingSettingsMetadata: preserves flat rate when patching quantity overrides", () => {
  const merged = mergeTenantBillingSettingsMetadata(
    { billingFlatRate: { enabled: true, amountCents: 50000, appliesTo: "extensions" }, taxProviderId: "tax_profile_v1" },
    {
      billingQuantityOverrides: {
        extensions: { mode: "manual", quantity: 10 },
      },
    },
  );
  assert.equal((merged.billingFlatRate as { amountCents: number }).amountCents, 50000);
  assert.equal(merged.taxProviderId, "tax_profile_v1");
  assert.equal(
    (merged.billingQuantityOverrides as { extensions: { quantity: number } }).extensions.quantity,
    10,
  );
});

test("mergeTenantBillingSettingsMetadata: tollFreeNumbers override round-trip via validate", () => {
  const validated = validateBillingQuantityOverridesInput({
    tollFreeNumbers: { mode: "manual", quantity: 1 },
    phoneNumbers: { mode: "auto", quantity: null },
  });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const merged = mergeTenantBillingSettingsMetadata(
    { billingFlatRate: { enabled: true, amountCents: 50000, appliesTo: "extensions" }, billingTollFreeDidPriceCents: 1500 },
    { billingQuantityOverrides: validated.value },
  );
  const parsed = parseBillingQuantityOverrides(merged);
  assert.equal(parsed?.tollFreeNumbers?.quantity, 1);
  assert.equal(merged.billingTollFreeDidPriceCents, 1500);
});

test("mergeBillingQuantityOverridesIntoMetadata: null removes key", () => {
  const merged = mergeBillingQuantityOverridesIntoMetadata(
    { billingQuantityOverrides: { extensions: { mode: "manual", quantity: 1 } } },
    null,
  );
  assert.equal(merged.billingQuantityOverrides, undefined);
});
