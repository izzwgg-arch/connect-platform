import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeVirtualExtensionPriceIntoMetadata,
  parseVirtualExtensionPriceCents,
  resolveVirtualExtensionPriceCents,
} from "./billingVirtualExtensionPricing";

test("resolveVirtualExtensionPriceCents: metadata override", () => {
  assert.equal(parseVirtualExtensionPriceCents({ billingVirtualExtensionPriceCents: 1800 }), 1800);
  assert.equal(resolveVirtualExtensionPriceCents({ billingVirtualExtensionPriceCents: 1800 }, 3000), 1800);
});

test("resolveVirtualExtensionPriceCents: falls back to extension when unset", () => {
  assert.equal(resolveVirtualExtensionPriceCents({}, 3000), 3000);
  assert.equal(resolveVirtualExtensionPriceCents(null, 2500), 2500);
});

test("mergeVirtualExtensionPriceIntoMetadata: round-trip and remove", () => {
  const merged = mergeVirtualExtensionPriceIntoMetadata({}, 2200);
  assert.equal(merged.billingVirtualExtensionPriceCents, 2200);
  const cleared = mergeVirtualExtensionPriceIntoMetadata(merged, null);
  assert.equal(cleared.billingVirtualExtensionPriceCents, undefined);
});
