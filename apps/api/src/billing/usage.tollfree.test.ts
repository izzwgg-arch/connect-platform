import test from "node:test";
import assert from "node:assert/strict";
import { computeSuggestedBillingQuantities } from "./billingQuantityOverrides";

test("first-number-free applies to local DIDs only", () => {
  const usage = {
    tenantId: "t1",
    extensionCount: 0,
    phoneNumberCount: 4,
    localPhoneNumberCount: 3,
    tollFreePhoneNumberCount: 1,
    localBillablePhoneNumberCount: 2,
    tollFreeBillablePhoneNumberCount: 1,
    additionalPhoneNumberCount: 3,
    smsEnabled: false,
    extensionIds: [],
    phoneNumberIds: ["a", "b", "c", "d"],
    localPhoneNumberIds: ["a", "b", "c"],
    tollFreePhoneNumberIds: ["d"],
  };
  const suggested = computeSuggestedBillingQuantities(usage, true);
  assert.equal(suggested.phoneNumbersBillable, 2);
  assert.equal(suggested.phoneNumbersTotal, 3);
  assert.equal(suggested.tollFreeNumbersBillable, 1);
  assert.equal(suggested.tollFreeNumbersTotal, 1);
});
