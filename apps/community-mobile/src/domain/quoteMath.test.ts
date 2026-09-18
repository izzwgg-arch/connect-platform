import assert from "node:assert/strict";
import { test } from "node:test";
import { extractQuantityNumber, formatMoney, suggestPerUnit, suggestTotal } from "./quoteMath";

test("extractQuantityNumber pulls the first number out of free text", () => {
  assert.equal(extractQuantityNumber("500 units"), 500);
  assert.equal(extractQuantityNumber("2 pallets (approx.)"), 2);
  assert.equal(extractQuantityNumber("1,250 sq ft"), 1250);
  assert.equal(extractQuantityNumber("12.5 tons"), 12.5);
});

test("extractQuantityNumber returns null for text with no usable number", () => {
  assert.equal(extractQuantityNumber("a few"), null);
  assert.equal(extractQuantityNumber(null), null);
  assert.equal(extractQuantityNumber(undefined), null);
  assert.equal(extractQuantityNumber(""), null);
  assert.equal(extractQuantityNumber("0 units"), null);
});

test("suggestPerUnit divides total by the extracted quantity", () => {
  assert.equal(suggestPerUnit(1000, "500 units"), 2);
  assert.equal(suggestPerUnit(133.33, "10"), 13.33);
});

test("suggestPerUnit is null when total is missing, zero, or quantity has no number", () => {
  assert.equal(suggestPerUnit(null, "500 units"), null);
  assert.equal(suggestPerUnit(0, "500 units"), null);
  assert.equal(suggestPerUnit(1000, "a few"), null);
  assert.equal(suggestPerUnit(1000, null), null);
});

test("suggestTotal is the inverse of suggestPerUnit", () => {
  assert.equal(suggestTotal(2, "500 units"), 1000);
  assert.equal(suggestTotal(13.33, "10"), 133.3);
});

test("suggestTotal is null when per-unit is missing or invalid", () => {
  assert.equal(suggestTotal(null, "500 units"), null);
  assert.equal(suggestTotal(-5, "500 units"), null);
});

test("formatMoney formats a number or a numeric string as USD", () => {
  assert.equal(formatMoney(1234.5), "$1,234.50");
  assert.equal(formatMoney("1234.5"), "$1,234.50");
});

test("formatMoney returns an em dash for anything not a finite number", () => {
  assert.equal(formatMoney(null), "—");
  assert.equal(formatMoney(undefined), "—");
  assert.equal(formatMoney("not a number"), "—");
  assert.equal(formatMoney(NaN), "—");
});
