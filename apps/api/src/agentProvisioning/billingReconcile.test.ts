/**
 * The billing half of "the customer added something."
 *
 * What has to be proven here is the thing that is easy to get catastrophically
 * wrong in both directions: the invoice must go up by exactly one unit, and it
 * must NOT go up twice because someone also "added it to the bill".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCents, priceOfAddition, type BillingSnapshot } from "./billingReconcile";
import { suggestFreeExtensionNumber } from "./accountSetupInfoRoute";
import { isBillableExtensionNumber } from "@connect/shared";

function snapshot(over: Partial<BillingSnapshot> = {}): BillingSnapshot {
  return {
    monthlyTotalCents: 3500,
    quantities: { extensions: 1, virtualExtensions: 0, phoneNumbers: 0, tollFreeNumbers: 0, smsPackages: 0 },
    manualBuckets: [],
    unitPrices: {
      extensionCents: 2500,
      additionalPhoneNumberCents: 1000,
      smsCents: 1000,
      firstPhoneNumberFree: true,
    },
    ...over,
  };
}

test("prices come from the tenant's own plan, not the sign-up constants", () => {
  // A negotiated account: $20 an extension, not the $30 a new customer is quoted.
  const negotiated = snapshot({
    unitPrices: { extensionCents: 2000, additionalPhoneNumberCents: 500, smsCents: 750, firstPhoneNumberFree: true },
  });
  assert.equal(priceOfAddition(negotiated, "extension").unitCents, 2000);
  assert.equal(priceOfAddition(negotiated, "sms").unitCents, 750);
});

test("the first local number is free, the next one is not", () => {
  const noNumbers = snapshot({
    quantities: { extensions: 1, virtualExtensions: 0, phoneNumbers: 0, tollFreeNumbers: 0, smsPackages: 0 },
  });
  const first = priceOfAddition(noNumbers, "local_number");
  assert.equal(first.charged, false);
  assert.equal(first.unitCents, 0);
  assert.match(first.note, /included/);

  const hasOne = snapshot({
    quantities: { extensions: 1, virtualExtensions: 0, phoneNumbers: 1, tollFreeNumbers: 0, smsPackages: 0 },
  });
  const second = priceOfAddition(hasOne, "local_number");
  assert.equal(second.charged, true);
  assert.equal(second.unitCents, 1000);
});

test("⛔ a tenant with first-number-free switched OFF pays for the first one", () => {
  const noFreebie = snapshot({
    unitPrices: { extensionCents: 2500, additionalPhoneNumberCents: 1000, smsCents: 1000, firstPhoneNumberFree: false },
  });
  assert.equal(priceOfAddition(noFreebie, "local_number").charged, true);
});

test("money is formatted the way a customer reads it", () => {
  assert.equal(formatCents(3000), "$30.00");
  assert.equal(formatCents(3500), "$35.00");
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(1005), "$10.05");
});

// ─── The three ways a real thing can be silently free ────────────────────────

test("⛔ an extension number that isn't exactly three digits is never billed", () => {
  // usage.ts filters billable extensions with /^\d{3}$/. Anything else works on
  // the phone and is charged for nothing — the same family of bug that made
  // 1-digit extensions invisible platform-wide.
  for (const good of ["101", "105", "999"]) assert.equal(isBillableExtensionNumber(good), true, good);
  for (const bad of ["1", "12", "1001", "10a", "", " ", "abc"]) {
    assert.equal(isBillableExtensionNumber(bad), false, `${bad} must be refused before it is created`);
  }
});

test("the suggested extension number is always billable, and skips what's taken", () => {
  assert.equal(suggestFreeExtensionNumber([]), "101");
  assert.equal(suggestFreeExtensionNumber(["101", "102"]), "103");
  // A tenant whose numbering starts elsewhere still gets a three-digit answer.
  assert.equal(suggestFreeExtensionNumber(["101", "103"]), "102");
  assert.ok(isBillableExtensionNumber(suggestFreeExtensionNumber(["101"])!));
});

test("a full account is honest about having no free number rather than inventing one", () => {
  const all = Array.from({ length: 899 }, (_, i) => String(101 + i));
  assert.equal(suggestFreeExtensionNumber(all), null);
});
