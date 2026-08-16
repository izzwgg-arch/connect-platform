// ── The pricing model, pinned ────────────────────────────────────────────────
//
//   customer_total = (extension_count × $30.00) + $5.00
//   net_service_revenue = customer_total − total_actual_taxes_and_fees
//   net_revenue_per_extension = net_service_revenue / extension_count
//
// Izzy's examples are the first test below and they are exact, to the cent:
// 1 → $35, 2 → $65, 3 → $95, 5 → $155, 10 → $305. Everything after that pins
// the rules that make those numbers hold no matter what the real fees come to.
//
// ⛔ Nothing here hard-codes a net per extension. $27.40 appears once, as the
// arithmetic the engine is expected to REACH from a $18 fee bill — never as an
// input. Change the fees and the split moves; change the total and this fails.
//
// One shared mock DB + one invoiceEngine import for the whole file: ESM caches
// the engine against the first "@connect/db" mock it sees.

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ACCOUNT_TAXES_AND_FEES_CENTS,
  isAllInclusivePricingEnabled,
  isGovernmentTaxOrFeeLine,
  resolveAccountTaxesAndFeesCents,
  solveTaxInclusiveTaxableBase,
} from "./billingAccountPricing";

const state = {
  extensionCount: 1,
  metadata: {} as Record<string, unknown>,
  taxEnabled: false,
  pbxDids: [] as Array<{ id: string; e164: string }>,
};

const db = {
  tenantBillingSettings: {
    findUnique: async () => null,
    upsert: async () => ({
      tenantId: "t-price",
      extensionPriceCents: 3000,
      additionalPhoneNumberPriceCents: 1000,
      smsPriceCents: 1000,
      firstPhoneNumberFree: true,
      smsBillingEnabled: false,
      taxEnabled: state.taxEnabled,
      taxProfileId: null,
      taxProfile: null,
      billingDayOfMonth: 1,
      paymentTermsDays: 15,
      creditsCents: 0,
      discountPercent: 0,
      pbxDidPriceCents: 0,
      invoiceSupportPhone: null,
      billingPlan: null,
      nextBillingPlanId: null,
      nextBillingPlanEffectiveAt: null,
      nextBillingPlan: null,
      metadata: state.metadata,
    }),
  },
  extension: {
    findMany: async () =>
      Array.from({ length: state.extensionCount }, (_, i) => ({
        id: `e${i + 1}`,
        extNumber: String(101 + i),
        displayName: "Agent",
      })),
  },
  phoneNumber: { findMany: async () => [] },
  tenant: {
    findUnique: async () => ({ smsSubscriptionRequired: false, smsBillingEnforced: false, smsSendMode: null }),
  },
  tenantPbxLink: { findUnique: async () => null },
  pbxTenantInboundDid: { findMany: async () => state.pbxDids },
  billingInvoice: { findFirst: async () => null, findMany: async () => [], count: async () => 0 },
  billingEventLog: { create: async () => ({}) },
};

mock.module("@connect/db", { namedExports: { db } });

/** E911 at $3 per number + a flat $2 of telecom/regulatory — the live onboarding stamp. */
const ONBOARDING_FEES = {
  e911: {
    enabled: true,
    customerVisible: true,
    label: "Emergency calling (E911)",
    mode: "amountCents",
    amountCents: 300,
    basis: "per_phone_number",
  },
  regulatory: {
    enabled: true,
    customerVisible: true,
    label: "Telecom & regulatory fees",
    mode: "amountCents",
    amountCents: 200,
    basis: "flat_monthly",
  },
  salesTax: { enabled: false, customerVisible: false, label: "Sales tax", mode: "ratePercent", ratePercent: 0, basis: "invoice_subtotal" },
};

async function previewWith(opts: {
  extensions: number;
  metadata?: Record<string, unknown>;
  taxEnabled?: boolean;
  pbxDids?: Array<{ id: string; e164: string }>;
  /** Omit the opt-in flag, i.e. an account that existed before this shipped. */
  legacyPricing?: boolean;
}) {
  state.extensionCount = opts.extensions;
  state.metadata = opts.legacyPricing
    ? { ...(opts.metadata ?? {}) }
    : { billingAllInclusivePricing: true, ...(opts.metadata ?? {}) };
  state.taxEnabled = opts.taxEnabled ?? false;
  state.pbxDids = opts.pbxDids ?? [];
  const { buildBillingInvoicePreview } = await import("./invoiceEngine");
  return buildBillingInvoicePreview({
    tenantId: "t-price",
    periodStart: new Date(Date.UTC(2026, 8, 1, 0, 0, 0, 0)),
    periodEnd: new Date(Date.UTC(2026, 9, 0, 23, 59, 59, 999)),
  });
}

test("customer_total = (extension_count × $30) + $5, to the cent", async () => {
  const expected: Array<[extensions: number, totalCents: number]> = [
    [1, 3500],
    [2, 6500],
    [3, 9500],
    [5, 15500],
    [10, 30500],
  ];
  for (const [extensions, totalCents] of expected) {
    const preview = await previewWith({ extensions });
    assert.equal(preview.totalCents, totalCents, `${extensions} extension(s) must total ${totalCents}¢`);
    assert.equal(preview.accountPricing.accountFeeCents, 500, "the $5 is charged ONCE per account, never per extension");
    assert.equal(preview.accountPricing.extensionCount, extensions);
  }
});

test("the real taxes and fees live INSIDE the total, and the split always closes", async () => {
  // 5 extensions, one phone number: E911 $3 + $2 flat = $5 of real fees.
  const preview = await previewWith({
    extensions: 5,
    taxEnabled: true,
    metadata: { billingTelecomFees: ONBOARDING_FEES },
    pbxDids: [{ id: "d1", e164: "8455550100" }],
  });
  const ap = preview.accountPricing;

  assert.equal(preview.totalCents, 15500, "5 × $30 + $5 = $155, and taxes do not move it");
  assert.equal(ap.totalTaxesAndFeesCents, 500, "$3 E911 + $2 regulatory");
  assert.equal(ap.netServiceRevenueCents, 15000);
  assert.equal(ap.netRevenuePerExtensionCents, 3000);
  assert.equal(
    ap.netServiceRevenueCents + ap.totalTaxesAndFeesCents,
    ap.customerTotalCents,
    "net_service_revenue + total_actual_taxes_and_fees = customer_total",
  );
  assert.equal(
    preview.lineItems.reduce((sum, l) => sum + l.amountCents, 0),
    preview.totalCents,
    "the line items must add up to what the customer pays",
  );
});

test("fees ABOVE $5 are absorbed from service revenue — the customer's total does not move", async () => {
  // Six numbers → $18 of E911, plus $2 flat… but the customer still pays $155.
  const preview = await previewWith({
    extensions: 5,
    taxEnabled: true,
    metadata: {
      billingTelecomFees: { ...ONBOARDING_FEES, regulatory: { ...ONBOARDING_FEES.regulatory, enabled: false } },
    },
    pbxDids: Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, e164: `84555501${10 + i}` })),
  });
  const ap = preview.accountPricing;

  assert.equal(ap.totalTaxesAndFeesCents, 1800, "6 numbers × $3 E911 = $18 of real fees");
  assert.equal(preview.totalCents, 15500, "⛔ the customer's total is FINAL — the excess over $5 comes out of revenue");
  // Izzy's worked example: $155 − $18 = $137, and $137 / 5 = $27.40.
  assert.equal(ap.netServiceRevenueCents, 13700);
  assert.equal(ap.netRevenuePerExtensionCents, 2740);
  assert.equal(ap.netRevenuePerExtensionCentsExact, 2740);
  assert.ok(ap.serviceRevenueAdjustmentCents < 0, "revenue was absorbed, not added");

  const ext = preview.lineItems.find((l) => l.type === "EXTENSION");
  assert.equal(ext?.quantity, 5);
  assert.equal(ext?.amountCents, 13700, "5 extensions × $27.40 net = $137.00");
  assert.equal(ext?.unitPriceCents, 2740);
  assert.equal(ext?.metadata?.listUnitPriceCents, 3000, "the commercial price is still $30 — the net is what is left of it");
});

test("fees BELOW $5 leave the remainder as service revenue — never relabelled as tax", async () => {
  // One number, E911 only: $3 of real government fee against a $5 allocation.
  const preview = await previewWith({
    extensions: 5,
    taxEnabled: true,
    metadata: {
      billingTelecomFees: { ...ONBOARDING_FEES, regulatory: { ...ONBOARDING_FEES.regulatory, enabled: false } },
    },
    pbxDids: [{ id: "d1", e164: "8455550100" }],
  });
  const ap = preview.accountPricing;

  assert.equal(ap.totalTaxesAndFeesCents, 300, "only the $3 actually owed is booked as a government fee");
  assert.equal(preview.totalCents, 15500);
  assert.equal(ap.netServiceRevenueCents, 15200, "the other $2 stays service revenue");
  assert.equal(ap.netRevenuePerExtensionCents, 3040);
  assert.equal(
    preview.lineItems.filter((l) => ["SALES_TAX", "E911_FEE", "REGULATORY_FEE"].includes(l.type)).length,
    1,
    "no invented tax line for the unspent part of the allocation",
  );
});

test("no tax config at all: the whole $5 is service revenue, and nothing is called a tax", async () => {
  const preview = await previewWith({ extensions: 3 });
  assert.equal(preview.totalCents, 9500);
  assert.equal(preview.taxCents, 0);
  assert.equal(preview.accountPricing.totalTaxesAndFeesCents, 0);
  assert.equal(preview.accountPricing.netServiceRevenueCents, 9500);
  assert.equal(
    preview.lineItems.filter((l) => ["SALES_TAX", "E911_FEE", "REGULATORY_FEE"].includes(l.type)).length,
    0,
  );
});

test("a percentage tax is owed on the service revenue, not on the tax-inclusive total", async () => {
  const preview = await previewWith({
    extensions: 5,
    taxEnabled: true,
    metadata: {
      billingTelecomFees: {
        salesTax: {
          enabled: true,
          customerVisible: true,
          label: "Sales tax",
          mode: "ratePercent",
          ratePercent: 0.10,
          basis: "invoice_subtotal",
        },
      },
    },
  });
  const ap = preview.accountPricing;

  assert.equal(preview.totalCents, 15500);
  // 10% of the SERVICE base, not of the $155 the customer pays: b + 0.10b = 15500
  // → b = 14091 (to the cent), tax 1409. Taxing the all-in total would book 1550
  // and tax the tax.
  assert.equal(ap.taxableBaseCents, 14091);
  assert.equal(ap.totalTaxesAndFeesCents, 1409);
  assert.equal(ap.netServiceRevenueCents, 14091);
  assert.equal(ap.netServiceRevenueCents + ap.totalTaxesAndFeesCents, 15500);
});

test("a customFee marked serviceCharge is revenue: it raises the total and is never booked as tax", async () => {
  const preview = await previewWith({
    extensions: 1,
    taxEnabled: true,
    metadata: {
      billingTelecomFees: {
        ...ONBOARDING_FEES,
        customFee: {
          enabled: true,
          customerVisible: true,
          label: "Toll-free number",
          mode: "amountCents",
          amountCents: 1500,
          basis: "flat_monthly",
          serviceCharge: true,
        },
      },
    },
    pbxDids: [{ id: "d1", e164: "8005550100" }],
  });
  const ap = preview.accountPricing;

  assert.equal(preview.totalCents, 5000, "$30 + $5 account fee + the $15 toll-free line");
  assert.equal(ap.totalTaxesAndFeesCents, 500, "only the $3 E911 and $2 regulatory are government charges");
  assert.equal(ap.netServiceRevenueCents, 4500);
});

test("⛔ an UNMARKED customFee is a real fee and is absorbed — six live tenants keep their $2 there", async () => {
  // Trust Bookkeepings / Luxure / Smooth Leasing / Secro / ADDB shape: E911 $3
  // flat + a $2 "Other custom fee" that IS the telecom & regulatory charge.
  const preview = await previewWith({
    extensions: 5,
    taxEnabled: true,
    metadata: {
      billingTelecomFees: {
        e911: { enabled: true, customerVisible: true, label: "Suggested E911 fee", mode: "amountCents", amountCents: 300, basis: "flat_monthly" },
        customFee: { enabled: true, customerVisible: true, label: "Other custom fee", mode: "amountCents", amountCents: 200, basis: "flat_monthly" },
      },
    },
  });
  const ap = preview.accountPricing;

  assert.equal(ap.totalTaxesAndFeesCents, 500, "the unmarked $2 is a fee, not revenue");
  assert.equal(preview.totalCents, 15500, "their bill stays on the formula — it must NOT go up by $2");
  assert.equal(ap.netServiceRevenueCents, 15000);
});

test("the account fee is once per MONTH — a 3-month invoice carries three of them", async () => {
  state.extensionCount = 2;
  state.metadata = { billingAllInclusivePricing: true };
  state.taxEnabled = false;
  state.pbxDids = [];
  const { buildBillingInvoicePreview } = await import("./invoiceEngine");
  const preview = await buildBillingInvoicePreview({
    tenantId: "t-price",
    periodStart: new Date("2028-01-01T05:00:00.000Z"),
    periodEnd: new Date("2028-04-01T03:59:59.999Z"),
    billingMonthCount: 3,
  });
  assert.equal(preview.accountPricing.accountFeeCents, 1500);
  assert.equal(preview.totalCents, 19500, "(2 × $30 + $5) × 3 months");
});

test("a per-tenant override replaces the $5 — including zeroing it", async () => {
  const zeroed = await previewWith({ extensions: 2, metadata: { billingAccountFeeCents: 0 } });
  assert.equal(zeroed.accountPricing.accountFeeCents, 0);
  assert.equal(zeroed.totalCents, 6000, "2 × $30, no account fee");

  const raised = await previewWith({ extensions: 2, metadata: { billingAccountFeeCents: 750 } });
  assert.equal(raised.totalCents, 6750);
});

// ── ⛔ The gate: no existing account's total may move ────────────────────────
//
// Izzy, 2026-08-16: "do not change any existing invoice totals. This is only
// going forward." Every tenant that existed before this shipped has no
// `billingAllInclusivePricing` flag, and must bill exactly as it did.

test("⛔ WITHOUT the opt-in flag nothing changes: no $5, taxes still added on top", async () => {
  const legacy = await previewWith({
    extensions: 5,
    taxEnabled: true,
    metadata: { billingTelecomFees: ONBOARDING_FEES },
    pbxDids: [{ id: "d1", e164: "8455550100" }],
    legacyPricing: true,
  });

  // 5 × $30 = $150 of service, and E911 $3 + regulatory $2 ON TOP = $155.
  assert.equal(legacy.accountPricing.applied, false);
  assert.equal(legacy.accountPricing.reason, "legacy_pricing_taxes_added_on_top");
  assert.equal(legacy.accountPricing.accountFeeCents, 0, "no account fee is charged to an existing account");
  assert.equal(legacy.lineItems.find((l) => l.type === "EXTENSION")?.amountCents, 15000, "the extension line is untouched");
  assert.equal(legacy.lineItems.find((l) => l.type === "EXTENSION")?.unitPriceCents, 3000, "still $30 a line, not a net");
  assert.equal(legacy.taxCents, 500);
  assert.equal(legacy.totalCents, 15500, "$150 + $5 of tax on top — exactly what this tenant billed before");

  // Same tenant, six numbers: the old math adds every $3 on top and the total RISES.
  const legacyMoreNumbers = await previewWith({
    extensions: 5,
    taxEnabled: true,
    metadata: { billingTelecomFees: { ...ONBOARDING_FEES, regulatory: { ...ONBOARDING_FEES.regulatory, enabled: false } } },
    pbxDids: Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, e164: `84555501${10 + i}` })),
    legacyPricing: true,
  });
  assert.equal(legacyMoreNumbers.totalCents, 16800, "$150 + 6 × $3 E911, added on top as before");
});

test("the reporting half runs for EVERY tenant, opted in or not", async () => {
  // The net-revenue figures are an accounting readout, not a price change — an
  // existing account gets them without its total moving a cent.
  const legacy = await previewWith({
    extensions: 5,
    taxEnabled: true,
    metadata: { billingTelecomFees: ONBOARDING_FEES },
    pbxDids: [{ id: "d1", e164: "8455550100" }],
    legacyPricing: true,
  });
  const ap = legacy.accountPricing;
  assert.equal(ap.customerTotalCents, 15500);
  assert.equal(ap.totalTaxesAndFeesCents, 500);
  assert.equal(ap.netServiceRevenueCents, 15000);
  assert.equal(ap.netRevenuePerExtensionCents, 3000);
  assert.equal(ap.netServiceRevenueCents + ap.totalTaxesAndFeesCents, ap.customerTotalCents);
});

test("no billable extension: the model does not apply and taxes are not carved out of nothing", async () => {
  const preview = await previewWith({
    extensions: 0,
    taxEnabled: true,
    metadata: { billingTelecomFees: ONBOARDING_FEES },
    pbxDids: [{ id: "d1", e164: "8455550100" }],
  });
  assert.equal(preview.accountPricing.applied, false);
  assert.equal(preview.accountPricing.accountFeeCents, 0, "no $5 charge for an account with no service");
  assert.equal(preview.totalCents, 500, "fees only — the old additive behaviour, with nothing to absorb them");
});

// ── Unit-level rules ────────────────────────────────────────────────────────

test("isAllInclusivePricingEnabled: opt-in only — ⛔ never flip this default", () => {
  assert.equal(isAllInclusivePricingEnabled(null), false);
  assert.equal(isAllInclusivePricingEnabled(undefined), false);
  assert.equal(isAllInclusivePricingEnabled({}), false, "an existing tenant's metadata must never opt itself in");
  assert.equal(isAllInclusivePricingEnabled({ billingAllInclusivePricing: false }), false);
  assert.equal(isAllInclusivePricingEnabled({ billingAllInclusivePricing: "true" }), false, "only a real boolean counts");
  assert.equal(isAllInclusivePricingEnabled({ billingAllInclusivePricing: 1 }), false);
  assert.equal(isAllInclusivePricingEnabled({ billingAllInclusivePricing: true }), true);
});

test("resolveAccountTaxesAndFeesCents: default $5, override wins, junk ignored", () => {
  assert.equal(DEFAULT_ACCOUNT_TAXES_AND_FEES_CENTS, 500);
  assert.equal(resolveAccountTaxesAndFeesCents(null), 500);
  assert.equal(resolveAccountTaxesAndFeesCents({}), 500);
  assert.equal(resolveAccountTaxesAndFeesCents({ billingAccountFeeCents: 0 }), 0);
  assert.equal(resolveAccountTaxesAndFeesCents({ billingAccountFeeCents: 1234 }), 1234);
  assert.equal(resolveAccountTaxesAndFeesCents({ billingAccountFeeCents: -1 }), 500, "negative is junk, not a credit");
  assert.equal(resolveAccountTaxesAndFeesCents({ billingAccountFeeCents: "nope" }), 500);
});

test("isGovernmentTaxOrFeeLine: only an explicitly-marked service charge is excluded", () => {
  assert.equal(isGovernmentTaxOrFeeLine({ metadata: { telecomFeeKey: "e911" } }), true);
  assert.equal(isGovernmentTaxOrFeeLine({ metadata: { telecomFeeKey: "salesTax" } }), true);
  assert.equal(isGovernmentTaxOrFeeLine({ metadata: { telecomFeeKey: "usfRecovery" } }), true);
  assert.equal(
    isGovernmentTaxOrFeeLine({ metadata: { telecomFeeKey: "customFee", telecomFeeIsServiceCharge: false } }),
    true,
    "⛔ the customFee BUCKET means nothing — live tenants keep real fees in it",
  );
  assert.equal(
    isGovernmentTaxOrFeeLine({ metadata: { telecomFeeKey: "customFee", telecomFeeIsServiceCharge: true } }),
    false,
  );
  // TaxProfile lines carry no fee metadata at all — they are all real taxes.
  assert.equal(isGovernmentTaxOrFeeLine({ metadata: { taxLineType: "SALES_TAX" } }), true);
  assert.equal(isGovernmentTaxOrFeeLine({}), true);
});

test("solveTaxInclusiveTaxableBase: fixed fees are exact on the first pass; percentages converge", () => {
  const fixed = solveTaxInclusiveTaxableBase({
    taxableGrossCents: 10000,
    computeFees: () => ({ result: "flat", totalFeesCents: 500 }),
  });
  assert.equal(fixed.taxableBaseCents, 9500);
  assert.equal(fixed.totalFeesCents, 500);
  assert.ok(fixed.converged);

  // 8% inclusive: b + round(0.08b) = 10000 → b = 9259, fee 741.
  const pct = solveTaxInclusiveTaxableBase({
    taxableGrossCents: 10000,
    computeFees: (base) => ({ result: base, totalFeesCents: Math.round(base * 0.08) }),
  });
  assert.equal(pct.taxableBaseCents + pct.totalFeesCents, 10000, "the base and its own fee must close on the gross");
  assert.equal(pct.taxableBaseCents, 9259);
  assert.ok(pct.converged);

  // The fees returned are always the ones computed AT the returned base, so the
  // audit trail can never disagree with the invoice.
  assert.equal(pct.fees, pct.taxableBaseCents);

  // A fee bigger than the whole gross clamps the base at zero rather than going negative.
  const drowned = solveTaxInclusiveTaxableBase({
    taxableGrossCents: 1000,
    computeFees: () => ({ result: null, totalFeesCents: 5000 }),
  });
  assert.equal(drowned.taxableBaseCents, 0);
});
