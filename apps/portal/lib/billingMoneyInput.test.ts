import assert from "node:assert/strict";
import test from "node:test";
import {
  centsToMoneyDraft,
  formatCentsAsDollars,
  parseDollarsInput,
  parseQuantityDraft,
  quantityToDraft,
  sanitizeMoneyDraft,
  sanitizeQuantityDraft,
} from "./billingMoneyInput";

test("sanitizeMoneyDraft allows natural decimal entry without forced formatting", () => {
  assert.equal(sanitizeMoneyDraft("12.5"), "12.5");
  assert.equal(sanitizeMoneyDraft("12.50"), "12.50");
  assert.equal(sanitizeMoneyDraft("12..5"), "12.5");
  assert.equal(sanitizeMoneyDraft("abc12.34xyz"), "12.34");
  assert.equal(sanitizeMoneyDraft(""), "");
});

test("parseDollarsInput treats empty draft as zero on blur commit", () => {
  assert.equal(parseDollarsInput(""), 0);
  assert.equal(parseDollarsInput("12.5"), 1250);
  assert.equal(parseDollarsInput("0.99"), 99);
});

test("centsToMoneyDraft seeds editable text without padding while focused", () => {
  assert.equal(centsToMoneyDraft(0), "");
  assert.equal(centsToMoneyDraft(1250), "12.50");
  assert.equal(formatCentsAsDollars(1250), "12.50");
});

test("sanitizeQuantityDraft and parseQuantityDraft support clear-and-retype", () => {
  assert.equal(sanitizeQuantityDraft("12a3"), "123");
  assert.equal(parseQuantityDraft(""), 0);
  assert.equal(parseQuantityDraft("42"), 42);
  assert.equal(parseQuantityDraft("999999", 0), 100_000);
  assert.equal(quantityToDraft(0), "");
  assert.equal(quantityToDraft(5), "5");
});
