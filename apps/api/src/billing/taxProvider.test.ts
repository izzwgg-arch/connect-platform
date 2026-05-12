import test from "node:test";
import assert from "node:assert/strict";
import {
  EXTERNAL_TELECOM_STUB_PROVIDER_ID,
  ExternalTelecomTaxProviderStub,
  readTaxProviderIdFromSettings,
  resolveTaxProvider,
  TaxProfileTaxProvider,
  TAX_PROFILE_PROVIDER_ID,
} from "./taxProvider";

test("TaxProfileTaxProvider matches legacy calculateTaxLines for enabled profile", () => {
  const p = new TaxProfileTaxProvider();
  const taxProfile = {
    id: "tp1",
    name: "NY Test",
    state: "NY",
    county: "Orange",
    salesTaxRate: 0.08,
    e911FeePerExtension: 50,
    regulatoryFeePercent: 0.01,
    regulatoryFeeEnabled: true,
  };
  const r = p.calculateTaxes({
    tenantId: "t1",
    taxEnabled: true,
    taxProfile,
    taxProfileId: "tp1",
    taxableSubtotalCents: 10000,
    extensionCount: 2,
  });
  assert.equal(r.lines.length, 3);
  assert.equal(r.audit.providerId, TAX_PROFILE_PROVIDER_ID);
  assert.equal(r.audit.taxProfileId, "tp1");
  assert.equal(r.audit.jurisdiction?.state, "NY");
  assert.ok(r.lines.every((l) => l.metadata?.taxProviderId === TAX_PROFILE_PROVIDER_ID));
});

test("TaxProfileTaxProvider no lines when tax enabled but profile missing", () => {
  const p = new TaxProfileTaxProvider();
  const r = p.calculateTaxes({
    tenantId: "t1",
    taxEnabled: true,
    taxProfile: null,
    taxProfileId: null,
    taxableSubtotalCents: 5000,
    extensionCount: 1,
  });
  assert.equal(r.lines.length, 0);
  assert.ok(r.audit.notes?.some((n) => /tax_enabled_but_no_tax_profile/.test(n)));
});

test("External stub returns empty lines with stub audit", () => {
  const p = new ExternalTelecomTaxProviderStub();
  const r = p.calculateTaxes({
    tenantId: "t1",
    taxEnabled: true,
    taxProfile: { salesTaxRate: 0.1 },
    taxProfileId: "x",
    taxableSubtotalCents: 1000,
    extensionCount: 0,
  });
  assert.equal(r.lines.length, 0);
  assert.equal(r.audit.providerId, EXTERNAL_TELECOM_STUB_PROVIDER_ID);
  assert.ok(r.audit.notes?.some((n) => /stub/i.test(n)));
});

test("resolveTaxProvider reads metadata.taxProviderId", () => {
  const stub = resolveTaxProvider({ metadata: { taxProviderId: EXTERNAL_TELECOM_STUB_PROVIDER_ID } });
  assert.equal(stub.id, EXTERNAL_TELECOM_STUB_PROVIDER_ID);
  const def = resolveTaxProvider({ metadata: {} });
  assert.equal(def.id, TAX_PROFILE_PROVIDER_ID);
});

test("readTaxProviderIdFromSettings env fallback", () => {
  const prev = process.env.BILLING_TAX_PROVIDER;
  try {
    process.env.BILLING_TAX_PROVIDER = EXTERNAL_TELECOM_STUB_PROVIDER_ID;
    assert.equal(readTaxProviderIdFromSettings({ metadata: {} }), EXTERNAL_TELECOM_STUB_PROVIDER_ID);
  } finally {
    if (prev === undefined) delete process.env.BILLING_TAX_PROVIDER;
    else process.env.BILLING_TAX_PROVIDER = prev;
  }
});

test("deterministic line amounts for same inputs", () => {
  const p = new TaxProfileTaxProvider();
  const input = {
    tenantId: "t",
    taxEnabled: true,
    taxProfile: { salesTaxRate: 0.04, e911FeePerExtension: 0, regulatoryFeePercent: 0, regulatoryFeeEnabled: false },
    taxProfileId: "p",
    taxableSubtotalCents: 2000,
    extensionCount: 0,
  };
  const a = p.calculateTaxes(input);
  const b = p.calculateTaxes(input);
  assert.deepEqual(
    a.lines.map((l) => l.amountCents),
    b.lines.map((l) => l.amountCents),
  );
});
