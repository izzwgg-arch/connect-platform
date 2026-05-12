import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { EXTERNAL_TELECOM_STUB_PROVIDER_ID, TAX_PROFILE_PROVIDER_ID } from "./taxProvider";

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
      billingPlan: null,
      metadata: {} as Record<string, unknown>,
    },
    lastCreateData: null,
  };

  const db = {
    tenantBillingSettings: {
      upsert: async () => ({
        ...state.settings,
        billingPlan: state.settings.billingPlan,
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
      update: async () => ({}),
    },
    billingEventLog: { create: async () => ({}) },
    emailJob: { findFirst: async () => null, create: async () => ({}) },
  };

  mock.module("@connect/db", {
    namedExports: { db },
  });

  const { buildBillingInvoicePreview, createBillingInvoice } = await import("./invoiceEngine");

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
});
