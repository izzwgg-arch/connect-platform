import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeBillingTelecomFeesIntoMetadata,
  mergeTelecomFeesWithDefaults,
  parseBillingTelecomFees,
  taxProfilePatchFromTelecomFees,
  validateBillingTelecomFeesInput,
} from "./billingTelecomFees";
import { mergeTenantBillingSettingsMetadata } from "./billingTenantSettingsMetadata";

test("validateBillingTelecomFeesInput persists e911 manual amount", () => {
  const r = validateBillingTelecomFeesInput({
    e911: {
      enabled: true,
      customerVisible: true,
      label: "Suggested E911 fee",
      mode: "amountCents",
      amountCents: 300,
      basis: "per_did",
    },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value?.e911?.amountCents, 300);
});

test("validateBillingTelecomFeesInput rejects negative amountCents", () => {
  const r = validateBillingTelecomFeesInput({
    e911: {
      enabled: true,
      customerVisible: true,
      label: "E911",
      mode: "amountCents",
      amountCents: -1,
      basis: "per_extension",
    },
  });
  assert.equal(r.ok, false);
});

test("parseBillingTelecomFees reads stored config", () => {
  const parsed = parseBillingTelecomFees({
    billingTelecomFees: {
      salesTax: {
        enabled: true,
        customerVisible: true,
        label: "Sales tax",
        mode: "ratePercent",
        ratePercent: 0.08125,
        basis: "invoice_subtotal",
      },
    },
  });
  assert.equal(parsed?.salesTax?.ratePercent, 0.08125);
});

test("taxProfilePatchFromTelecomFees maps enabled fees", () => {
  const patch = taxProfilePatchFromTelecomFees({
    salesTax: {
      enabled: true,
      customerVisible: true,
      label: "Sales tax",
      mode: "ratePercent",
      ratePercent: 0.08,
      basis: "invoice_subtotal",
    },
    e911: {
      enabled: true,
      customerVisible: true,
      label: "E911",
      mode: "amountCents",
      amountCents: 300,
      basis: "per_did",
    },
    regulatory: { enabled: false, customerVisible: false, label: "Reg", mode: "ratePercent", ratePercent: 0.01, basis: "invoice_subtotal" },
  });
  assert.equal(patch.salesTaxRate, 0.08);
  assert.equal(patch.e911FeePerExtension, 300);
  assert.equal(patch.regulatoryFeeEnabled, false);
});

test("mergeTenantBillingSettingsMetadata preserves unrelated keys with telecom fees", () => {
  const merged = mergeTenantBillingSettingsMetadata(
    { taxProviderId: "tax_profile_v1", billingFlatRate: { enabled: true, amountCents: 100, appliesTo: "extensions" } },
    {
      billingTelecomFees: {
        e911: {
          enabled: true,
          customerVisible: true,
          label: "E911",
          mode: "amountCents",
          amountCents: 300,
          basis: "per_did",
        },
      },
    },
  );
  assert.equal(merged.taxProviderId, "tax_profile_v1");
  assert.ok((merged.billingTelecomFees as Record<string, unknown>)?.e911);
});

test("mergeTelecomFeesWithDefaults uses NY Orange suggested rates", () => {
  const fees = mergeTelecomFeesWithDefaults(null, { state: "NY", county: "Orange", salesTaxRate: 0, e911FeePerExtension: 0 });
  assert.equal(fees.salesTax?.suggested, true);
  assert.equal(fees.salesTax?.ratePercent, 0.08125);
  assert.equal(fees.e911?.amountCents, 300);
});

test("mergeBillingTelecomFeesIntoMetadata null removes key", () => {
  const m = mergeBillingTelecomFeesIntoMetadata({ billingTelecomFees: { e911: { enabled: true } } }, null);
  assert.equal(m.billingTelecomFees, undefined);
});
