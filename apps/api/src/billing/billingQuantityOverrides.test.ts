import test from "node:test";
import assert from "node:assert/strict";
import { mergeTenantBillingSettingsMetadata } from "./billingTenantSettingsMetadata";
import {
  mergeBillingQuantityOverridesIntoMetadata,
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

test("mergeBillingQuantityOverridesIntoMetadata: null removes key", () => {
  const merged = mergeBillingQuantityOverridesIntoMetadata(
    { billingQuantityOverrides: { extensions: { mode: "manual", quantity: 1 } } },
    null,
  );
  assert.equal(merged.billingQuantityOverrides, undefined);
});
