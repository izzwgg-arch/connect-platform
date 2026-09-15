import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BILLING_RECURRING_CUSTOM_LINES_METADATA_KEY,
  buildRecurringCustomInvoiceLines,
  parseBillingRecurringCustomLines,
} from "./billingRecurringCustomLines";

test("absent / malformed metadata parses to no lines", () => {
  assert.deepEqual(parseBillingRecurringCustomLines(undefined), []);
  assert.deepEqual(parseBillingRecurringCustomLines(null), []);
  assert.deepEqual(parseBillingRecurringCustomLines("nope"), []);
  assert.deepEqual(parseBillingRecurringCustomLines({}), []);
  assert.deepEqual(parseBillingRecurringCustomLines({ [BILLING_RECURRING_CUSTOM_LINES_METADATA_KEY]: "nope" }), []);
  assert.deepEqual(parseBillingRecurringCustomLines({ [BILLING_RECURRING_CUSTOM_LINES_METADATA_KEY]: {} }), []);
});

test("valid entries parse; junk entries are skipped, never thrown on", () => {
  const parsed = parseBillingRecurringCustomLines({
    [BILLING_RECURRING_CUSTOM_LINES_METADATA_KEY]: [
      { description: "Contabo server", amountCents: 4000 },
      { description: "  Extension 111 - Lester Tan  ", amountCents: 2500, taxable: false },
      { description: "", amountCents: 100 },
      { description: "no amount" },
      { description: "zero", amountCents: 0 },
      { description: "negative", amountCents: -500 },
      { description: "NaN", amountCents: "abc" },
      { description: "too big", amountCents: 25_000_001 },
      null,
      "string",
      42,
    ],
  });
  assert.deepEqual(parsed, [
    { description: "Contabo server", amountCents: 4000, taxable: false },
    { description: "Extension 111 - Lester Tan", amountCents: 2500, taxable: false },
  ]);
});

test("taxable is only true on an explicit === true", () => {
  const parsed = parseBillingRecurringCustomLines({
    [BILLING_RECURRING_CUSTOM_LINES_METADATA_KEY]: [
      { description: "a", amountCents: 100, taxable: true },
      { description: "b", amountCents: 100, taxable: "yes" },
      { description: "c", amountCents: 100, taxable: 1 },
    ],
  });
  assert.deepEqual(parsed.map((l) => l.taxable), [true, false, false]);
});

test("entry count is capped at 20", () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ description: `line ${i}`, amountCents: 100 }));
  const parsed = parseBillingRecurringCustomLines({ [BILLING_RECURRING_CUSTOM_LINES_METADATA_KEY]: entries });
  assert.equal(parsed.length, 20);
});

test("built invoice lines carry the CUSTOM type, quantity 1 and the recurring_custom kind", () => {
  const lines = buildRecurringCustomInvoiceLines({
    [BILLING_RECURRING_CUSTOM_LINES_METADATA_KEY]: [
      { description: "Contabo server", amountCents: 4000 },
      { description: "Extension 111 - Lester Tan", amountCents: 2500 },
    ],
  });
  assert.deepEqual(lines, [
    {
      type: "CUSTOM",
      description: "Contabo server",
      quantity: 1,
      unitPriceCents: 4000,
      amountCents: 4000,
      taxable: false,
      metadata: { lineItemKind: "recurring_custom" },
    },
    {
      type: "CUSTOM",
      description: "Extension 111 - Lester Tan",
      quantity: 1,
      unitPriceCents: 2500,
      amountCents: 2500,
      taxable: false,
      metadata: { lineItemKind: "recurring_custom" },
    },
  ]);
});

test("invoiceEngine pushes recurring custom lines into the preview before the period stamp", () => {
  // The defect this guards is placement, not parsing: the lines must be in the
  // preview's lineItems array before applyBillingPeriodToRecurringLines runs so
  // they carry servicePeriod metadata and scale on multi-month invoices.
  const src = readFileSync(path.join(__dirname, "invoiceEngine.ts"), "utf8").replace(/\r\n/g, "\n");
  const pushAt = src.indexOf("lineItems.push(...buildRecurringCustomInvoiceLines(settings.metadata))");
  const stampAt = src.indexOf("applyBillingPeriodToRecurringLines(lineItems", pushAt);
  assert.ok(pushAt > 0, "invoiceEngine no longer pushes recurring custom lines");
  assert.ok(stampAt > pushAt, "recurring custom lines must be pushed before the period stamp");
  assert.match(src, /import \{ buildRecurringCustomInvoiceLines \} from "\.\/billingRecurringCustomLines"/);
});
