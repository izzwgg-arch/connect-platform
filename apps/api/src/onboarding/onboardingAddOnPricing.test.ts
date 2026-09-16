/**
 * Cold calling ($65/ext) and CRM ($20/ext), set by an admin on the sign-up link
 * (Izzy, 2026-09-16). The promise: the review screen, the first invoice and
 * month 2 all bill the same thing — and the customer can never set it.
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { quoteOnboarding } from "@connect/shared";
import { buildOnboardingPricing, quoteInputForSubmission } from "./quoteInput";
import { carryServerOwnedAnswers } from "./serverOwnedAnswers";
import { onboardingAddOnRecurringLines } from "./onboardingBillingDefaults";

const exts = (n: number) => Array.from({ length: n }, (_, i) => ({ displayName: `P${i}`, extNumber: String(101 + i) }));

test("cold calling on every extension: $65 each + E911 + fees", () => {
  const sub = { answers: { extensions: exts(3), pricing: { coldCalling: { extensions: "all" } } } };
  const q = quoteOnboarding(quoteInputForSubmission(sub));
  assert.deepStrictEqual(q.lines.map((l) => [l.key, l.quantity, l.unitCents]), [
    ["cold_calling_extensions", 3, 6500],
    ["e911", 1, 300],
    ["telecom_fees", 1, 200],
  ]);
  assert.strictEqual(q.monthlyTotalCents, 3 * 6500 + 300 + 200);
});

test("3 extensions, 2 cold calling, CRM on 2: $65×2 + $30×1 + $20×2 + fees", () => {
  const sub = { answers: { extensions: exts(3), pricing: { coldCalling: { extensions: 2 }, crm: { extensions: 2 } } } };
  const q = quoteOnboarding(quoteInputForSubmission(sub));
  assert.strictEqual(q.monthlyTotalCents, 2 * 6500 + 3000 + 2 * 2000 + 300 + 200);
});

test("a count larger than the extensions set up is clamped", () => {
  const sub = { answers: { extensions: exts(1), pricing: { coldCalling: { extensions: 5 }, crm: { extensions: 5 } } } };
  assert.strictEqual(quoteOnboarding(quoteInputForSubmission(sub)).monthlyTotalCents, 6500 + 2000 + 500);
});

test("no pricing = the plain $35 sign-up, unchanged", () => {
  assert.strictEqual(quoteOnboarding(quoteInputForSubmission({ answers: { extensions: exts(1) } })).monthlyTotalCents, 3500);
});

test("the autosave can never set, change or clear pricing", () => {
  const stored = { pricing: { coldCalling: { extensions: "all" } } };
  const kept: any = carryServerOwnedAnswers(stored, { company: {}, pricing: { coldCalling: { extensions: 1 } } });
  assert.deepStrictEqual(kept.pricing, stored.pricing, "stored value wins");
  const cleared: any = carryServerOwnedAnswers(stored, { company: {} });
  assert.deepStrictEqual(cleared.pricing, stored.pricing, "an autosave without the key does not clear it");
  const injected: any = carryServerOwnedAnswers(null, { company: {}, pricing: { crm: { extensions: 9 } } });
  assert.strictEqual(injected.pricing, undefined, "a client-sent pricing is dropped when nothing is stored");
});

test("admin form → stored shape", () => {
  assert.strictEqual(buildOnboardingPricing({}), undefined);
  assert.strictEqual(buildOnboardingPricing({ coldCalling: { enabled: false, extensions: 2 } }), undefined);
  assert.deepStrictEqual(buildOnboardingPricing({ coldCalling: { enabled: true, extensions: null } }), { coldCalling: { extensions: "all" } });
  assert.deepStrictEqual(buildOnboardingPricing({ coldCalling: { enabled: true, extensions: 2 }, crm: { enabled: true, extensions: "all" } }), { coldCalling: { extensions: 2 }, crm: { extensions: "all" } });
});

test("month 2: partial cold calling = $35×N difference line, CRM = $20×N; all = price change, no line", () => {
  const partial = onboardingAddOnRecurringLines({ coldCallingAll: false, coldCallingExtensions: 2, crmExtensions: 3 });
  assert.deepStrictEqual(partial.map((l) => [l.addon, l.amountCents, l.taxable]), [["cold_calling", 7000, false], ["crm", 6000, false]]);
  assert.deepStrictEqual(onboardingAddOnRecurringLines({ coldCallingAll: true, coldCallingExtensions: 3, crmExtensions: 0 }), []);
});

test("the review /quote route prices the add-ons (a $30 review and a $65 charge must never happen)", () => {
  const src = readFileSync(path.join(__dirname, "publicRoutes.ts"), "utf8").replace(/\r\n/g, "\n");
  const route = src.slice(src.indexOf('"/onboarding/:token/quote"'), src.indexOf('"/onboarding/:token/checkout"'));
  assert.ok(route.includes("coldCallingExtensions:") && route.includes("crmExtensions:"), "quote route passes both add-ons");
});
