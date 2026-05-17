import test from "node:test";
import assert from "node:assert/strict";
import { resolveTollFreeDidPriceCents, parseTollFreeDidPriceCents } from "./billingTollFreePricing";

test("resolveTollFreeDidPriceCents: metadata override", () => {
  assert.equal(parseTollFreeDidPriceCents({ billingTollFreeDidPriceCents: 1500 }), 1500);
  assert.equal(resolveTollFreeDidPriceCents({ billingTollFreeDidPriceCents: 1500 }, 1000), 1500);
});

test("resolveTollFreeDidPriceCents: falls back to local when unset", () => {
  assert.equal(resolveTollFreeDidPriceCents({}, 1000), 1000);
});
