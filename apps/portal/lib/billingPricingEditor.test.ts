import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BILLING_ITEM_PRICE_KEYS,
  buildTenantPricingSavePayload,
  isBillingUnitPriceEditable,
  type TenantPricingSaveDraft,
} from "./billingPricingEditor";

const here = dirname(fileURLToPath(import.meta.url));
const workspacePath = join(
  here,
  "../app/(platform)/admin/billing/_components/AdminPricingWorkspace.tsx",
);

function baseDraft(overrides: Partial<TenantPricingSaveDraft> = {}): TenantPricingSaveDraft {
  return {
    extensionPriceCents: 2500,
    additionalPhoneNumberPriceCents: 500,
    smsPriceCents: 1000,
    firstPhoneNumberFree: true,
    smsBillingEnabled: true,
    flatRateEnabled: false,
    flatRateAmountCents: 0,
    tollFreeDidPriceCents: 1500,
    quantityOverrides: {
      extensions: { mode: "auto", quantity: 3 },
      virtualExtensions: { mode: "manual", quantity: 2 },
      phoneNumbers: { mode: "auto", quantity: 1 },
      tollFreeNumbers: { mode: "auto", quantity: 0 },
      smsPackages: { mode: "auto", quantity: 1 },
    },
    ...overrides,
  };
}

test("virtual extensions share extension price and are editable in custom pricing mode", () => {
  assert.equal(BILLING_ITEM_PRICE_KEYS.virtual, "extensionPriceCents");
  assert.equal(isBillingUnitPriceEditable("extensionPriceCents", false), true);
  assert.equal(isBillingUnitPriceEditable("extensionPriceCents", true), false);
  assert.equal(isBillingUnitPriceEditable("tollFreeDidPriceCents", true), true);
});

test("buildTenantPricingSavePayload persists edited extension and virtual manual quantity", () => {
  const draft = baseDraft({
    extensionPriceCents: 3200,
    quantityOverrides: {
      extensions: { mode: "auto", quantity: 3 },
      virtualExtensions: { mode: "manual", quantity: 4 },
      phoneNumbers: { mode: "auto", quantity: 1 },
      tollFreeNumbers: { mode: "auto", quantity: 0 },
      smsPackages: { mode: "auto", quantity: 1 },
    },
  });
  const payload = buildTenantPricingSavePayload(draft, false);

  assert.equal(payload.extensionPriceCents, 3200);
  assert.equal(payload.billingPricingMode, "custom");
  assert.deepEqual(payload.billingQuantityOverrides, {
    extensions: { mode: "auto", quantity: null },
    virtualExtensions: { mode: "manual", quantity: 4 },
    phoneNumbers: { mode: "auto", quantity: null },
    tollFreeNumbers: { mode: "auto", quantity: null },
    smsPackages: { mode: "auto", quantity: null },
  });
});

test("save payload includes all billable unit prices in custom mode", () => {
  const draft = baseDraft({
    extensionPriceCents: 2100,
    additionalPhoneNumberPriceCents: 600,
    tollFreeDidPriceCents: 1800,
    smsPriceCents: 900,
  });
  const payload = buildTenantPricingSavePayload(draft, false);

  assert.equal(payload.extensionPriceCents, 2100);
  assert.equal(payload.additionalPhoneNumberPriceCents, 600);
  assert.equal(payload.tollFreeDidPriceCents, 1800);
  assert.equal(payload.smsPriceCents, 900);
});

test("catalog mode only sends toll-free override plus quantity overrides", () => {
  const draft = baseDraft({ extensionPriceCents: 9999, tollFreeDidPriceCents: 2200 });
  const payload = buildTenantPricingSavePayload(draft, true);

  assert.equal(payload.extensionPriceCents, undefined);
  assert.equal(payload.tollFreeDidPriceCents, 2200);
  assert.equal(
    (payload.billingQuantityOverrides as { virtualExtensions: { mode: string; quantity: number } }).virtualExtensions
      .quantity,
    2,
  );
});

test("AdminPricingWorkspace uses focus-aware money inputs and editable virtual extension price", () => {
  const src = readFileSync(workspacePath, "utf8");
  assert.match(src, /BillingMoneyInput/);
  assert.match(src, /BillingQuantityInput/);
  assert.match(src, /priceKey: "extensionPriceCents" as const/);
  assert.match(src, /billing-price-input-\$\{item\.key\}/);
  assert.match(src, /buildTenantPricingSavePayload/);
  assert.doesNotMatch(src, /priceKey: null,\s*\n\s*chip: resolvedQuantities\.modes\.virtualExtensions/);
});

test("edit extensions, virtual extensions, local, toll-free, and SMS prices then save", () => {
  const draft = baseDraft({
    extensionPriceCents: 2750,
    additionalPhoneNumberPriceCents: 550,
    tollFreeDidPriceCents: 1650,
    smsPriceCents: 1150,
    quantityOverrides: {
      extensions: { mode: "manual", quantity: 5 },
      virtualExtensions: { mode: "manual", quantity: 3 },
      phoneNumbers: { mode: "manual", quantity: 2 },
      tollFreeNumbers: { mode: "manual", quantity: 1 },
      smsPackages: { mode: "manual", quantity: 1 },
    },
  });
  const saved = buildTenantPricingSavePayload(draft, false);
  const reloaded = {
    extensionPriceCents: saved.extensionPriceCents,
    additionalPhoneNumberPriceCents: saved.additionalPhoneNumberPriceCents,
    tollFreeDidPriceCents: saved.tollFreeDidPriceCents,
    smsPriceCents: saved.smsPriceCents,
    overrides: saved.billingQuantityOverrides,
  };

  assert.deepEqual(reloaded, {
    extensionPriceCents: 2750,
    additionalPhoneNumberPriceCents: 550,
    tollFreeDidPriceCents: 1650,
    smsPriceCents: 1150,
    overrides: {
      extensions: { mode: "manual", quantity: 5 },
      virtualExtensions: { mode: "manual", quantity: 3 },
      phoneNumbers: { mode: "manual", quantity: 2 },
      tollFreeNumbers: { mode: "manual", quantity: 1 },
      smsPackages: { mode: "manual", quantity: 1 },
    },
  });
});
