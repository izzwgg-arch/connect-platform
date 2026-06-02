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
    virtualExtensionPriceCents: 1800,
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

test("virtual extensions use independent price field", () => {
  assert.equal(BILLING_ITEM_PRICE_KEYS.virtual, "virtualExtensionPriceCents");
  assert.equal(BILLING_ITEM_PRICE_KEYS.extensions, "extensionPriceCents");
  assert.notEqual(BILLING_ITEM_PRICE_KEYS.virtual, BILLING_ITEM_PRICE_KEYS.extensions);
});

test("virtual extension price is editable in catalog mode via metadata override", () => {
  assert.equal(isBillingUnitPriceEditable("virtualExtensionPriceCents", true), true);
  assert.equal(isBillingUnitPriceEditable("extensionPriceCents", true), false);
});

test("save payload persists independent extension and virtual extension prices", () => {
  const draft = baseDraft({
    extensionPriceCents: 3200,
    virtualExtensionPriceCents: 1400,
  });
  const payload = buildTenantPricingSavePayload(draft, false);

  assert.equal(payload.extensionPriceCents, 3200);
  assert.equal(payload.virtualExtensionPriceCents, 1400);
  assert.notEqual(payload.extensionPriceCents, payload.virtualExtensionPriceCents);
});

test("catalog mode sends virtual extension metadata override without extension price", () => {
  const draft = baseDraft({ extensionPriceCents: 9999, virtualExtensionPriceCents: 1200 });
  const payload = buildTenantPricingSavePayload(draft, true);

  assert.equal(payload.extensionPriceCents, undefined);
  assert.equal(payload.virtualExtensionPriceCents, 1200);
});

test("AdminPricingWorkspace wires virtual extensions to virtualExtensionPriceCents", () => {
  const src = readFileSync(workspacePath, "utf8");
  assert.match(src, /virtualExtensionPriceCents/);
  assert.match(src, /priceKey: "virtualExtensionPriceCents" as const/);
  assert.doesNotMatch(src, /priceKey: "extensionPriceCents" as const,\s*\n\s*chip:\s*\n\s*parseVirtualExtensionPriceCentsFromMetadata/);
});

test("edit extensions, virtual extensions, local, toll-free, and SMS prices then save", () => {
  const draft = baseDraft({
    extensionPriceCents: 2750,
    virtualExtensionPriceCents: 1950,
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

  assert.deepEqual(
    {
      extensionPriceCents: saved.extensionPriceCents,
      virtualExtensionPriceCents: saved.virtualExtensionPriceCents,
      additionalPhoneNumberPriceCents: saved.additionalPhoneNumberPriceCents,
      tollFreeDidPriceCents: saved.tollFreeDidPriceCents,
      smsPriceCents: saved.smsPriceCents,
      overrides: saved.billingQuantityOverrides,
    },
    {
      extensionPriceCents: 2750,
      virtualExtensionPriceCents: 1950,
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
    },
  );
});
