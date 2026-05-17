import test from "node:test";
import assert from "node:assert/strict";
import {
  activeExtensionsFlatRate,
  buildExtensionInvoiceLine,
  mergeBillingFlatRateIntoMetadata,
  parseBillingFlatRate,
  validateBillingFlatRateInput,
} from "./billingFlatRate";

test("parseBillingFlatRate: reads metadata slice", () => {
  const cfg = parseBillingFlatRate({
    billingFlatRate: { enabled: true, amountCents: 50000, appliesTo: "extensions", label: "All extensions" },
  });
  assert.equal(cfg?.enabled, true);
  assert.equal(cfg?.amountCents, 50000);
  assert.equal(cfg?.label, "All extensions");
});

test("activeExtensionsFlatRate: requires enabled and positive amount", () => {
  assert.equal(activeExtensionsFlatRate({ billingFlatRate: { enabled: false, amountCents: 50000, appliesTo: "extensions" } }), null);
  assert.equal(activeExtensionsFlatRate({ billingFlatRate: { enabled: true, amountCents: 0, appliesTo: "extensions" } }), null);
  const active = activeExtensionsFlatRate({ billingFlatRate: { enabled: true, amountCents: 50000, appliesTo: "extensions" } });
  assert.equal(active?.amountCents, 50000);
});

test("validateBillingFlatRateInput: rejects enabled with zero amount", () => {
  const r = validateBillingFlatRateInput({ enabled: true, amountCents: 0, appliesTo: "extensions" });
  assert.equal(r.ok, false);
});

test("mergeBillingFlatRateIntoMetadata: null removes key", () => {
  const merged = mergeBillingFlatRateIntoMetadata({ billingFlatRate: { enabled: true, amountCents: 1, appliesTo: "extensions" } }, null);
  assert.equal(merged.billingFlatRate, undefined);
});

test("buildExtensionInvoiceLine: flat rate uses qty 1 and flat amount", () => {
  const usage = {
    tenantId: "t1",
    extensionCount: 32,
    phoneNumberCount: 0,
    localPhoneNumberCount: 0,
    tollFreePhoneNumberCount: 0,
    localBillablePhoneNumberCount: 0,
    tollFreeBillablePhoneNumberCount: 0,
    additionalPhoneNumberCount: 0,
    smsEnabled: false,
    extensionIds: ["e1"],
    phoneNumberIds: [],
    localPhoneNumberIds: [],
    tollFreePhoneNumberIds: [],
  };
  const line = buildExtensionInvoiceLine({
    usage,
    extensionBillableCount: 32,
    extensionPriceCents: 3000,
    metadata: { billingFlatRate: { enabled: true, amountCents: 50000, appliesTo: "extensions" } },
  });
  assert.ok(line);
  assert.equal(line!.quantity, 1);
  assert.equal(line!.unitPriceCents, 50000);
  assert.equal(line!.amountCents, 50000);
  assert.equal(line!.metadata?.flatRate, true);
  assert.equal(line!.metadata?.extensionCount, 32);
});

test("buildExtensionInvoiceLine: per-extension when flat rate off", () => {
  const usage = {
    tenantId: "t1",
    extensionCount: 2,
    phoneNumberCount: 0,
    localPhoneNumberCount: 0,
    tollFreePhoneNumberCount: 0,
    localBillablePhoneNumberCount: 0,
    tollFreeBillablePhoneNumberCount: 0,
    additionalPhoneNumberCount: 0,
    smsEnabled: false,
    extensionIds: ["e1", "e2"],
    phoneNumberIds: [],
    localPhoneNumberIds: [],
    tollFreePhoneNumberIds: [],
  };
  const line = buildExtensionInvoiceLine({
    usage,
    extensionBillableCount: 2,
    extensionPriceCents: 3000,
    metadata: {},
  });
  assert.equal(line!.quantity, 2);
  assert.equal(line!.amountCents, 6000);
});
