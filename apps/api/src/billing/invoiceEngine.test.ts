import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { EXTERNAL_TELECOM_STUB_PROVIDER_ID, TAX_PROFILE_PROVIDER_ID } from "./taxProvider";

// ---------------------------------------------------------------------------
// Shared fake DB factory for discount / period / preview tests
// ---------------------------------------------------------------------------
function makePreviewDb(overrides: { settings?: Record<string, unknown>; extensionCount?: number } = {}) {
  const settings: Record<string, unknown> = {
    tenantId: "t-preview",
    taxEnabled: false,
    taxProfileId: null,
    taxProfile: null,
    paymentTermsDays: 15,
    extensionPriceCents: 3000,
    additionalPhoneNumberPriceCents: 1000,
    smsPriceCents: 1000,
    firstPhoneNumberFree: true,
    smsBillingEnabled: false,
    creditsCents: 0,
    discountPercent: 0,
    billingPlan: null,
    metadata: {},
    ...(overrides.settings ?? {}),
  };
  const extCount = overrides.extensionCount ?? 2;
  const exts = Array.from({ length: extCount }, (_, i) => ({
    id: `e${i + 1}`,
    extNumber: `10${i + 1}`,
    displayName: "Agent",
  }));
  return {
    tenantBillingSettings: {
      upsert: async () => ({ ...settings }),
    },
    extension: { findMany: async () => exts },
    phoneNumber: { findMany: async () => [] },
    tenant: {
      findUnique: async (args: { select?: Record<string, boolean> }) => {
        if (args?.select?.billingSettings) return { name: "T", billingSettings: { billingEmail: null } };
        return { smsSubscriptionRequired: false, smsBillingEnforced: false, smsSendMode: null };
      },
    },
    billingInvoice: {
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "inv-x", lineItems: [], ...data }),
      findUnique: async () => null,
      update: async ({ data }: { data: Record<string, unknown> }) => data,
    },
    billingEventLog: { create: async () => ({}) },
    emailJob: { findFirst: async () => null, create: async () => ({}) },
  };
}

afterEach(() => {
  mock.restoreAll();
});

test("invoiceEngine preview + create: tax audit, provider routing, persisted metadata", async () => {
  const fakeTaxProfile = {
    id: "tp1",
    name: "NY OC",
    state: "NY",
    county: "Orange",
    salesTaxRate: 0.08,
    e911FeePerExtension: 50,
    regulatoryFeePercent: 0.01,
    regulatoryFeeEnabled: true,
  };

  const state: {
    settings: Record<string, unknown>;
    lastCreateData: Record<string, unknown> | null;
  } = {
    settings: {
      tenantId: "tenant-z",
      taxEnabled: true,
      taxProfileId: "tp1",
      taxProfile: fakeTaxProfile,
      paymentTermsDays: 15,
      extensionPriceCents: 3000,
      additionalPhoneNumberPriceCents: 1000,
      smsPriceCents: 1000,
      firstPhoneNumberFree: true,
      smsBillingEnabled: false,
      creditsCents: 0,
      discountPercent: 0,
      billingPlan: null,
      nextBillingPlanId: null,
      nextBillingPlanEffectiveAt: null,
      nextBillingPlan: null,
      metadata: {} as Record<string, unknown>,
    },
    lastCreateData: null,
  };

  // Mutable invoice slot shared by the mark-paid guard sub-tests below.
  // guardCapture uses an object wrapper so TypeScript can track the assignment inside
  // the async update() callback (plain `let x = null` causes narrowing to `never`).
  let guardInvoice: Record<string, unknown> = {};
  const guardCapture: { updateData: Record<string, unknown> | null } = { updateData: null };
  let guardUpdateCount = 0;

  const db = {
    tenantBillingSettings: {
      upsert: async () => ({
        ...state.settings,
        billingPlan: state.settings.billingPlan,
        nextBillingPlan: state.settings.nextBillingPlan,
        taxProfile: state.settings.taxProfile,
      }),
    },
    extension: {
      findMany: async () => [{ id: "e1", extNumber: "101", displayName: "Sales" }],
    },
    phoneNumber: { findMany: async () => [] },
    tenant: {
      findUnique: async (args: { select?: Record<string, boolean> }) => {
        if (args?.select?.billingSettings) return { name: "Tenant", billingSettings: { billingEmail: null } };
        return { smsSubscriptionRequired: false, smsBillingEnforced: false, smsSendMode: null };
      },
    },
    billingInvoice: {
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.lastCreateData = data;
        return { id: "inv-1", tenant: { name: "Tenant" }, lineItems: [], ...data };
      },
      // findUnique is used by markBillingInvoicePaid (guard tests below)
      findUnique: async () => guardInvoice,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        guardUpdateCount++;
        guardCapture.updateData = data;
        return { ...guardInvoice, ...data };
      },
    },
    billingEventLog: { create: async () => ({}) },
    emailJob: { findFirst: async () => null, create: async () => ({}) },
  };

  mock.module("@connect/db", {
    namedExports: { db },
  });

  const { buildBillingInvoicePreview, createBillingInvoice, markBillingInvoicePaid } = await import("./invoiceEngine");

  // ── existing: invoice preview + create ──────────────────────────────────────

  const preview1 = await buildBillingInvoicePreview({ tenantId: "tenant-z" });
  assert.ok(preview1.taxCalculationAudit);
  assert.equal(preview1.taxCalculationAudit.providerId, TAX_PROFILE_PROVIDER_ID);
  assert.equal(preview1.taxCalculationAudit.taxProfileId, "tp1");
  assert.ok(preview1.lineItems.some((li) => li.type === "SALES_TAX"));
  for (const li of preview1.lineItems) {
    if (li.type === "SALES_TAX" || li.type === "E911_FEE" || li.type === "REGULATORY_FEE") {
      assert.equal(li.metadata?.taxProviderId, TAX_PROFILE_PROVIDER_ID);
    }
  }

  state.settings.metadata = { taxProviderId: EXTERNAL_TELECOM_STUB_PROVIDER_ID };
  const preview2 = await buildBillingInvoicePreview({ tenantId: "tenant-z" });
  assert.equal(preview2.taxCents, 0);
  assert.equal(preview2.taxCalculationAudit.providerId, EXTERNAL_TELECOM_STUB_PROVIDER_ID);
  assert.equal(preview2.lineItems.filter((l) => ["SALES_TAX", "E911_FEE", "REGULATORY_FEE"].includes(l.type)).length, 0);

  state.settings.metadata = {};
  state.settings.taxEnabled = true;
  state.settings.taxProfile = null;
  state.settings.taxProfileId = null;
  const preview3 = await buildBillingInvoicePreview({ tenantId: "tenant-z" });
  assert.equal(preview3.taxCents, 0);
  assert.ok(preview3.taxCalculationAudit.notes?.some((n) => /tax_enabled_but_no_tax_profile/.test(n)));

  state.settings.taxProfile = fakeTaxProfile;
  state.settings.taxProfileId = "tp1";
  state.lastCreateData = null;
  await createBillingInvoice({ tenantId: "tenant-z", status: "OPEN" });
  const cap = state.lastCreateData as Record<string, unknown> | null;
  assert.ok(cap, "billingInvoice.create should capture payload");
  assert.ok(cap["metadata"] && typeof cap["metadata"] === "object");
  const meta = cap["metadata"] as { taxCalculationAudit?: { providerId?: string } };
  assert.ok(meta.taxCalculationAudit);
  assert.equal(meta.taxCalculationAudit.providerId, TAX_PROFILE_PROVIDER_ID);

  // ── Phase-0 guard: markBillingInvoicePaid ───────────────────────────────────
  // Three sub-cases reuse the same already-loaded invoiceEngine module above.

  // Guard case 1: partial amount → rejects, update must NOT be called
  guardInvoice = { id: "inv-g1", tenantId: "t1", totalCents: 10000, balanceDueCents: 10000, metadata: null };
  guardUpdateCount = 0;
  await assert.rejects(
    () => markBillingInvoicePaid("inv-g1", 5000),
    (err: any) => {
      assert.equal(err.code, "PARTIAL_PAYMENT_NOT_SUPPORTED", "error code must be PARTIAL_PAYMENT_NOT_SUPPORTED");
      assert.ok(typeof err.hint === "string" && err.hint.length > 0, "error must carry a hint");
      return true;
    },
  );
  assert.equal(guardUpdateCount, 0, "billingInvoice.update must NOT be called on partial amount");

  // Guard case 2: no amountCents → defaults to totalCents → PAID, balanceDue=0
  guardInvoice = { id: "inv-g2", tenantId: "t1", totalCents: 10000, balanceDueCents: 10000, metadata: null };
  guardCapture.updateData = null;
  await markBillingInvoicePaid("inv-g2");
  // Cast as `any` to bypass TypeScript's narrowing of guardCapture.updateData to null
  // (flow analysis from the explicit `= null` reset above would otherwise produce never).
  const d2 = guardCapture.updateData as any;
  assert.ok(d2, "billingInvoice.update must have been called (case 2)");
  assert.equal(d2.status, "PAID", "status must be PAID when no amount passed");
  assert.equal(d2.balanceDueCents, 0, "balanceDueCents must be 0");
  assert.equal(d2.amountPaidCents, 10000, "amountPaidCents must equal totalCents");

  // Guard case 3: amountCents === totalCents → PAID, balanceDue=0
  guardInvoice = { id: "inv-g3", tenantId: "t1", totalCents: 8500, balanceDueCents: 8500, metadata: null };
  guardCapture.updateData = null;
  await markBillingInvoicePaid("inv-g3", 8500);
  const d3 = guardCapture.updateData as any;
  assert.ok(d3, "billingInvoice.update must have been called (case 3)");
  assert.equal(d3.status, "PAID", "status must be PAID when exact amount passed");
  assert.equal(d3.balanceDueCents, 0, "balanceDueCents must be 0 for exact amount");
  assert.equal(d3.amountPaidCents, 8500, "amountPaidCents must equal the passed amount");

  // ── Phase A: discountPercent line item + tax base reduction ─────────────
  // Mock state at this point: taxEnabled=true, taxProfile=fakeTaxProfile (8% sales tax),
  // extensionPriceCents=3000, 1 extension (e1/101/Sales from db.extension.findMany).
  // Service charges: 1 × $30 = $30 (3000 cents).
  // discountPercent=0.1 → DISCOUNT line = −300 cents (taxable:true).
  // Taxable base = 3000 + (−300) = 2700 cents → sales tax = 2700 × 0.08 = 216 cents.

  state.settings.discountPercent = 0.1;
  state.settings.taxEnabled = true;
  state.settings.taxProfile = fakeTaxProfile;
  state.settings.taxProfileId = "tp1";
  state.settings.metadata = {};
  const previewDisc = await buildBillingInvoicePreview({ tenantId: "tenant-z" });

  const discountLine = previewDisc.lineItems.find((l) => l.type === "DISCOUNT");
  assert.ok(discountLine, "DISCOUNT line must exist when discountPercent=0.1");
  assert.equal(discountLine.amountCents, -300, "DISCOUNT = −10% of 1×$30 = −$3.00 (−300 cents)");

  // Tax base (taxable subtotal) = 3000 + (−300) = 2700 cents (discount reduces taxable base).
  // fakeTaxProfile: salesTax 8% on 2700 = 216, E911 $0.50/ext × 1 = 50, regulatory 1% on 2700 = 27 → total 293.
  const salesTaxLineDisc = previewDisc.lineItems.find((l) => l.type === "SALES_TAX");
  assert.ok(salesTaxLineDisc, "SALES_TAX line must exist when tax enabled");
  assert.equal(salesTaxLineDisc.amountCents, 216, "Sales tax = 8% of discounted base 2700 cents = 216 cents");
  assert.equal(previewDisc.taxCents, 293, "taxCents = sales(216) + E911(50) + regulatory(27) on discounted base");

  // discountPercent=0 → no DISCOUNT line
  state.settings.discountPercent = 0;
  const previewNoDisc = await buildBillingInvoicePreview({ tenantId: "tenant-z" });
  const noDiscountLine = previewNoDisc.lineItems.find((l) => l.type === "DISCOUNT");
  assert.equal(noDiscountLine, undefined, "No DISCOUNT line when discountPercent=0");

  // ── Phase 1: scheduled plan change preview logic ────────────────────────────
  // Context: 1 extension (e1/101/Sales), default prices.
  // All scheduled plan change scenarios are in this block to avoid ESM cache issues.

  const nextPlanFixture = {
    id: "plan-next",
    name: "Growth Plan",
    extensionPriceCents: 9900,
    additionalPhoneNumberPriceCents: 500,
    smsPriceCents: 500,
    firstPhoneNumberFree: false,
  };
  const currentPlanFixture = {
    id: "plan-curr",
    name: "Starter",
    extensionPriceCents: 3000,
    additionalPhoneNumberPriceCents: 1000,
    smsPriceCents: 1000,
    firstPhoneNumberFree: true,
  };
  const effectiveAt2027Jul = new Date(Date.UTC(2027, 6, 1, 0, 0, 0, 0));

  // No scheduled change → scheduledPlanChange absent, default prices used
  state.settings.extensionPriceCents = 3000;
  state.settings.billingPlan = null;
  state.settings.nextBillingPlanId = null;
  state.settings.nextBillingPlanEffectiveAt = null;
  state.settings.nextBillingPlan = null;
  state.settings.taxEnabled = false;
  state.settings.taxProfile = null;
  const scPreviewNoChange = await buildBillingInvoicePreview({ tenantId: "tenant-z" });
  const scExtLineNoChange = scPreviewNoChange.lineItems.find((l) => l.type === "EXTENSION");
  assert.ok(scExtLineNoChange, "EXTENSION line must exist (no scheduled change)");
  assert.equal(scExtLineNoChange.unitPriceCents, 3000, "no scheduled change: should use extensionPriceCents=3000");
  assert.equal(scPreviewNoChange.scheduledPlanChange, undefined, "scheduledPlanChange must be absent when nothing scheduled");

  // periodStart before effectiveAt → current plan prices, no scheduledPlanChange
  state.settings.extensionPriceCents = 0;
  state.settings.billingPlan = currentPlanFixture;
  state.settings.nextBillingPlanId = nextPlanFixture.id;
  state.settings.nextBillingPlanEffectiveAt = effectiveAt2027Jul;
  state.settings.nextBillingPlan = nextPlanFixture;
  const previewBeforeEff = await buildBillingInvoicePreview({
    tenantId: "tenant-z",
    periodStart: new Date(Date.UTC(2027, 5, 1, 0, 0, 0, 0)),  // June 2027 (before July eff)
    periodEnd: new Date(Date.UTC(2027, 6, 0, 23, 59, 59, 999)),
  });
  const extBeforeEff = previewBeforeEff.lineItems.find((l) => l.type === "EXTENSION");
  assert.ok(extBeforeEff, "EXTENSION line must exist (before effective)");
  assert.equal(extBeforeEff.unitPriceCents, 3000, "before effective date: must use current plan price 3000");
  assert.equal(previewBeforeEff.scheduledPlanChange, undefined, "scheduledPlanChange must be absent before effective date");

  // periodStart on effectiveAt → next plan prices, scheduledPlanChange present
  const previewOnEff = await buildBillingInvoicePreview({
    tenantId: "tenant-z",
    periodStart: new Date(Date.UTC(2027, 6, 1, 0, 0, 0, 0)),   // July 2027 (on eff date)
    periodEnd: new Date(Date.UTC(2027, 7, 0, 23, 59, 59, 999)),
  });
  const extOnEff = previewOnEff.lineItems.find((l) => l.type === "EXTENSION");
  assert.ok(extOnEff, "EXTENSION line must exist (on effective date)");
  assert.equal(extOnEff.unitPriceCents, 9900, "on effective date: must use next plan extensionPriceCents=9900");
  assert.ok(previewOnEff.scheduledPlanChange, "scheduledPlanChange must be present on effective date");
  assert.equal(previewOnEff.scheduledPlanChange!.planId, nextPlanFixture.id, "scheduledPlanChange.planId matches next plan");
  assert.equal(previewOnEff.scheduledPlanChange!.planName, "Growth Plan", "scheduledPlanChange.planName matches next plan");

  // periodStart after effectiveAt → still uses next plan prices
  const previewAfterEff = await buildBillingInvoicePreview({
    tenantId: "tenant-z",
    periodStart: new Date(Date.UTC(2027, 7, 1, 0, 0, 0, 0)),   // August 2027 (after eff)
    periodEnd: new Date(Date.UTC(2027, 8, 0, 23, 59, 59, 999)),
  });
  const extAfterEff = previewAfterEff.lineItems.find((l) => l.type === "EXTENSION");
  assert.ok(extAfterEff, "EXTENSION line must exist (after effective)");
  assert.equal(extAfterEff.unitPriceCents, 9900, "after effective date: still uses next plan price 9900");
  assert.ok(previewAfterEff.scheduledPlanChange, "scheduledPlanChange must still be present after effective date");

  // Reset state
  state.settings.extensionPriceCents = 3000;
  state.settings.billingPlan = null;
  state.settings.nextBillingPlanId = null;
  state.settings.nextBillingPlanEffectiveAt = null;
  state.settings.nextBillingPlan = null;
  state.settings.taxEnabled = true;
  state.settings.taxProfile = fakeTaxProfile;
  state.settings.taxProfileId = "tp1";
  state.settings.metadata = {};
});

// ---------------------------------------------------------------------------
// Phase A: discount line item + tax base reduction
// ---------------------------------------------------------------------------


test("invoiceEngine: buildBillingInvoicePreview with periodMonth/periodYear returns correct period bounds", async () => {
  const db = makePreviewDb({ extensionCount: 1 });
  mock.module("@connect/db", { namedExports: { db } });
  const { buildBillingInvoicePreview } = await import("./invoiceEngine");

  // March 2027: periodStart = 2027-03-01, periodEnd = 2027-03-31
  const preview = await buildBillingInvoicePreview({
    tenantId: "t-preview",
    periodStart: new Date(Date.UTC(2027, 2, 1, 0, 0, 0, 0)),
    periodEnd: new Date(Date.UTC(2027, 3, 0, 23, 59, 59, 999)),
  });

  assert.equal(preview.periodStart.getUTCFullYear(), 2027, "year must be 2027");
  assert.equal(preview.periodStart.getUTCMonth(), 2, "month must be March (index 2)");
  assert.equal(preview.periodStart.getUTCDate(), 1, "periodStart must be the 1st");
  assert.equal(preview.periodEnd.getUTCMonth(), 2, "periodEnd must still be in March");
  assert.equal(preview.periodEnd.getUTCDate(), 31, "March has 31 days");
});

test("invoiceEngine: buildBillingInvoicePreview does not write to DB (no billingInvoice.create call)", async () => {
  let createCount = 0;
  const db = makePreviewDb({ extensionCount: 1 });
  const originalCreate = db.billingInvoice.create;
  db.billingInvoice.create = async (args: any) => {
    createCount++;
    return originalCreate(args);
  };

  mock.module("@connect/db", { namedExports: { db } });
  const { buildBillingInvoicePreview } = await import("./invoiceEngine");

  await buildBillingInvoicePreview({ tenantId: "t-preview" });
  assert.equal(createCount, 0, "buildBillingInvoicePreview must not call billingInvoice.create");
});

// Note: Phase 1 scheduled plan change preview tests live inside the main "invoiceEngine preview + create"
// test block above (state-mutation approach) to avoid Node.js ESM module caching issues.
