// ── The month-2 promise ──────────────────────────────────────────────────────
//
// Checkout and the sign-up report email promise "$35 a month, including tax"
// for one extension + one number. The first invoice is built straight from the
// quote, but every LATER invoice comes from the recurring engine — so these
// tests pin the whole chain: stamp a fresh onboarding tenant, run the real
// invoice preview, and require the total to equal the quote to the cent.
//
// One shared mock DB + one invoiceEngine import for the whole file: ESM caches
// the engine against the first "@connect/db" mock it sees, so per-test
// mock.module calls would silently test against a stale mock (the engine's own
// test file has the same constraint).

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { quoteOnboarding } from "@connect/shared";
import { ensureOnboardingBillingDefaults, onboardingTelecomFeesConfig } from "./onboardingBillingDefaults";

// Schema defaults for TenantBillingSettings (packages/db/prisma/schema.prisma)
// — what a row created by a bare upsert actually contains.
function settingsDefaults(tenantId: string): Record<string, unknown> {
  return {
    tenantId,
    extensionPriceCents: 3000,
    additionalPhoneNumberPriceCents: 1000,
    smsPriceCents: 1000,
    firstPhoneNumberFree: true,
    smsBillingEnabled: false,
    taxEnabled: false,
    taxProfileId: null,
    taxProfile: null,
    autoBillingEnabled: false,
    billingDayOfMonth: 1,
    paymentTermsDays: 15,
    creditsCents: 0,
    discountPercent: 0,
    pbxDidPriceCents: 0,
    invoiceSupportPhone: null,
    metadata: null,
    billingPlan: null,
    billingPlanId: null,
    nextBillingPlanId: null,
    nextBillingPlanEffectiveAt: null,
    nextBillingPlan: null,
    defaultPaymentMethodId: null,
    defaultPaymentMethod: null,
  };
}

// Mutable state mirroring what a tenant looks like the month AFTER a
// one-person onboarding finished: one 3-digit extension, the purchased number
// synced from the PBX (PbxTenantInboundDid) — and, faithfully to production,
// NOTHING in the Connect phoneNumber table, because onboarding never writes it.
const state = {
  phoneNumberRows: [] as Array<{ id: string; phoneNumber: string }>,
  pbxDids: [{ id: "d1", e164: "8455550100" }] as Array<{ id: string; e164: string }>,
};
const settingsStore = new Map<string, Record<string, unknown>>();

const db = {
  tenantBillingSettings: {
    findUnique: async ({ where }: any) => settingsStore.get(where.tenantId) ?? null,
    upsert: async ({ where, create, update }: any) => {
      const existing = settingsStore.get(where.tenantId);
      const row = existing
        ? { ...existing, ...update }
        : { ...settingsDefaults(where.tenantId), ...create };
      settingsStore.set(where.tenantId, row);
      return { ...row };
    },
  },
  extension: {
    findMany: async () => [{ id: "e1", extNumber: "101", displayName: "Owner" }],
  },
  phoneNumber: { findMany: async () => state.phoneNumberRows },
  tenant: {
    findUnique: async () => ({ smsSubscriptionRequired: false, smsBillingEnforced: false, smsSendMode: null }),
  },
  tenantPbxLink: {
    findUnique: async () => ({ pbxInstanceId: "pbx1", pbxTenantId: "vt1" }),
  },
  pbxTenantInboundDid: {
    findMany: async () => state.pbxDids,
  },
  billingInvoice: {
    findFirst: async () => null,
    findMany: async () => [],
    count: async () => 0,
  },
  billingEventLog: { create: async () => ({}) },
};

mock.module("@connect/db", { namedExports: { db } });

async function previewFor(tenantId: string) {
  const { buildBillingInvoicePreview } = await import("../billing/invoiceEngine");
  // One clean month, like the month-2 billing run would use.
  return buildBillingInvoicePreview({
    tenantId,
    periodStart: new Date(Date.UTC(2026, 8, 1, 0, 0, 0, 0)), // Sept 1 2026
    periodEnd: new Date(Date.UTC(2026, 9, 0, 23, 59, 59, 999)), // Sept 30 2026
  });
}

test("month-2 preview for a fresh onboarding tenant equals the sign-up quote ($35)", async () => {
  await ensureOnboardingBillingDefaults(db, "t-fresh");
  const preview = await previewFor("t-fresh");

  const quote = quoteOnboarding({ extensions: 1, phoneNumbers: 1, smsEnabled: false });
  assert.equal(quote.monthlyTotalCents, 3500, "the quote itself must be $35 for 1 ext + 1 number");
  assert.equal(
    preview.totalCents,
    quote.monthlyTotalCents,
    `month-2 preview (${preview.totalCents}¢) must equal the onboarding quote (${quote.monthlyTotalCents}¢)`,
  );

  const ext = preview.lineItems.find((l) => l.type === "EXTENSION");
  assert.equal(ext?.amountCents, 3000, "extension line must be the promised tax-included $30");
  const e911 = preview.lineItems.find((l) => l.type === "E911_FEE");
  assert.equal(e911?.amountCents, 300, "E911 must bill $3 for the ONE number, even though it is the free first number");
  assert.equal(e911?.quantity, 1);
  const reg = preview.lineItems.find((l) => l.type === "REGULATORY_FEE");
  assert.equal(reg?.amountCents, 200, "flat telecom & regulatory fee must be $2");
  assert.equal(preview.lineItems.find((l) => l.type === "SALES_TAX"), undefined, "no sales tax on top — the $30 already includes it");
});

test("number present in BOTH the phoneNumber table and the PBX sync is charged E911 once", async () => {
  state.phoneNumberRows = [{ id: "p1", phoneNumber: "8455550100" }];
  state.pbxDids = [{ id: "d1", e164: "8455550100" }];
  try {
    await ensureOnboardingBillingDefaults(db, "t-both");
    const preview = await previewFor("t-both");
    assert.equal(preview.lineItems.find((l) => l.type === "E911_FEE")?.amountCents, 300, "one real number → one $3 E911, not two");
    assert.equal(preview.totalCents, 3500);
  } finally {
    state.phoneNumberRows = [];
    state.pbxDids = [{ id: "d1", e164: "8455550100" }];
  }
});

test("wizard's SMS choice recurs: month-2 preview with messaging = quote with messaging ($45)", async () => {
  await ensureOnboardingBillingDefaults(db, "t-sms", { smsEnabled: true });
  const preview = await previewFor("t-sms");
  const quote = quoteOnboarding({ extensions: 1, phoneNumbers: 1, smsEnabled: true });
  assert.equal(quote.monthlyTotalCents, 4500);
  assert.equal(preview.totalCents, quote.monthlyTotalCents, "SMS $10 from the quote must recur in month 2");
});

test("toll-free pick recurs: month-2 preview with a toll-free number = quote with toll-free ($50)", async () => {
  await ensureOnboardingBillingDefaults(db, "t-tollfree", { tollFreeNumber: true });
  const preview = await previewFor("t-tollfree");
  const quote = quoteOnboarding({ extensions: 1, phoneNumbers: 1, smsEnabled: false, tollFreeNumber: true });
  assert.equal(quote.monthlyTotalCents, 5000, "the quote itself must be $50 for 1 ext + toll-free");
  assert.equal(preview.totalCents, quote.monthlyTotalCents, "the $15 toll-free line must recur in month 2");
  const tf = preview.lineItems.find((l) => l.description === "Toll-free number");
  assert.equal(tf?.amountCents, 1500, "the recurring toll-free line must be exactly $15");
});

test("no toll-free pick → no $15 line stamped (the flag is opt-in)", async () => {
  await ensureOnboardingBillingDefaults(db, "t-local-only");
  const preview = await previewFor("t-local-only");
  assert.equal(preview.lineItems.find((l) => l.description === "Toll-free number"), undefined);
  assert.equal(preview.totalCents, 3500);
});

test("stamp is idempotent and never overwrites operator-configured billing", async () => {
  // Fresh tenant → stamped.
  const first = await ensureOnboardingBillingDefaults(db, "t1");
  assert.equal(first.stamped, true);
  const row = settingsStore.get("t1")!;
  assert.equal(row.taxEnabled, true, "fee lines only build when taxEnabled — the stamp must switch it on");
  assert.ok((row.metadata as any).billingTelecomFees, "fee config must land in metadata");

  // Re-run → no-op.
  const again = await ensureOnboardingBillingDefaults(db, "t1");
  assert.equal(again.stamped, false);

  // Operator already enabled taxes (their own profile, no metadata config) → hands off.
  settingsStore.set("t-op", { ...settingsDefaults("t-op"), taxEnabled: true });
  const op = await ensureOnboardingBillingDefaults(db, "t-op");
  assert.equal(op.stamped, false);
  assert.equal(settingsStore.get("t-op")!.metadata, null, "operator tenant's metadata must be untouched");

  // Operator configured their own fee schedule → hands off.
  settingsStore.set("t-fees", {
    ...settingsDefaults("t-fees"),
    metadata: { billingTelecomFees: { e911: { enabled: true, mode: "amountCents", amountCents: 999, basis: "per_extension" } } },
  });
  const fees = await ensureOnboardingBillingDefaults(db, "t-fees");
  assert.equal(fees.stamped, false);
  assert.equal(
    ((settingsStore.get("t-fees")!.metadata as any).billingTelecomFees.e911.amountCents),
    999,
    "operator's own fee amounts must survive",
  );
});

test("stamped config matches the quote's constants exactly", () => {
  const cfg = onboardingTelecomFeesConfig();
  assert.equal(cfg.e911?.amountCents, 300);
  assert.equal(cfg.e911?.basis, "per_phone_number");
  assert.equal(cfg.e911?.enabled, true);
  assert.equal(cfg.regulatory?.amountCents, 200);
  assert.equal(cfg.regulatory?.basis, "flat_monthly");
  assert.equal(cfg.regulatory?.enabled, true);
  assert.equal(cfg.salesTax?.enabled, false, "tax is included in the $30 — never added on top");
  assert.equal(cfg.customFee, undefined, "no toll-free line unless the wizard picked one");

  const tf = onboardingTelecomFeesConfig({ tollFreeNumber: true });
  assert.equal(tf.customFee?.enabled, true);
  assert.equal(tf.customFee?.amountCents, 1500);
  // FLAT on purpose: per_toll_free_did counts phoneNumber rows, which
  // onboarding never writes — that basis would bill $0 and break the promise.
  assert.equal(tf.customFee?.basis, "flat_monthly");
  assert.equal(tf.customFee?.label, "Toll-free number");
  // ⛔ It is OUR charge, not a tax — customer totals are all-inclusive, so this
  // must ADD to the total instead of being absorbed out of service revenue.
  assert.equal(tf.customFee?.serviceCharge, true);
  assert.notEqual(cfg.e911?.serviceCharge, true, "a real fee must never be marked as revenue");
  assert.notEqual(cfg.regulatory?.serviceCharge, true);
});
