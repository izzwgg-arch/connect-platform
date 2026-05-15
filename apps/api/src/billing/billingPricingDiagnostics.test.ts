import test from "node:test";
import assert from "node:assert/strict";
import { mergeTenantBillingSettingsMetadata } from "./billingTenantSettingsMetadata";
import {
  BILLING_PRICING_MODE_METADATA_KEY,
  parseBillingPricingMode,
  resolveTenantBillingPricing,
} from "./billingPricingResolution";
import { buildPricingPreviewExplanation } from "./billingPricingExplanation";
import { buildTenantPricingDiagnosticsFromPreview } from "./billingPricingDiagnostics";
import type { BillingInvoicePreview } from "./invoiceEngine";
import type { BillingPricingResolution } from "./billingPricingResolution";
import { canAccessPlatformAdminBillingRoutes } from "./billingAuth";

const planPro = {
  id: "p-pro",
  code: "pro",
  name: "Pro",
  active: true,
  extensionPriceCents: 5000,
  additionalPhoneNumberPriceCents: 2000,
  smsPriceCents: 1500,
  firstPhoneNumberFree: false,
};

function wrapPreview(opts: {
  pricingMode: BillingPricingResolution["mode"];
  resolution: BillingPricingResolution;
  pricingPreviewExplanation: NonNullable<BillingInvoicePreview["pricingPreviewExplanation"]>;
}): BillingInvoicePreview {
  return {
    tenantId: "tenant-x",
    periodStart: new Date("2027-06-01T00:00:00.000Z"),
    periodEnd: new Date("2027-06-30T23:59:59.999Z"),
    dueDate: new Date("2027-07-15T00:00:00.000Z"),
    usage: {} as BillingInvoicePreview["usage"],
    lineItems: [],
    subtotalCents: 999,
    taxCents: 0,
    totalCents: 999,
    taxCalculationAudit: {} as BillingInvoicePreview["taxCalculationAudit"],
    pricingResolution: opts.resolution,
    pricingPreviewExplanation: opts.pricingPreviewExplanation,
  };
}

function explainAndWrap(input: Parameters<typeof buildPricingPreviewExplanation>[0]): BillingInvoicePreview {
  const expl = buildPricingPreviewExplanation(input);
  const resolution = input.pricingResolution;
  return wrapPreview({ pricingMode: input.pricingMode, resolution, pricingPreviewExplanation: expl });
}

test("buildPricingPreviewExplanation: deep-freeze over resolution (does not tweak invoice totals source)", () => {
  const resolution = resolveTenantBillingPricing({
    mode: "legacy",
    settings: {
      extensionPriceCents: 0,
      additionalPhoneNumberPriceCents: 0,
      smsPriceCents: 0,
      firstPhoneNumberFree: true,
    },
    activePlan: planPro,
  });
  const snap = structuredClone(resolution) as BillingPricingResolution;
  buildPricingPreviewExplanation({
    pricingMode: "legacy",
    pricingResolution: resolution,
    tenantPricing: {
      extensionPriceCents: 0,
      additionalPhoneNumberPriceCents: 0,
      smsPriceCents: 0,
      firstPhoneNumberFree: true,
    },
    hasScheduledChange: false,
    scheduledPlanChange: undefined,
    activePlanForPreview: planPro,
  });
  assert.deepEqual(resolution, snap);
});

test("buildTenantPricingDiagnosticsFromPreview: catalog with stale tenant row → warning + tenantOverridesDetected path", () => {
  const mode = parseBillingPricingMode({ [BILLING_PRICING_MODE_METADATA_KEY]: "catalog" });
  assert.equal(mode, "catalog");
  const resolution = resolveTenantBillingPricing({
    mode: "catalog",
    settings: {
      extensionPriceCents: 9900,
      additionalPhoneNumberPriceCents: 500,
      smsPriceCents: 500,
      firstPhoneNumberFree: true,
    },
    activePlan: planPro,
  });
  const preview = explainAndWrap({
    pricingMode: "catalog",
    pricingResolution: resolution,
    tenantPricing: {
      extensionPriceCents: 9900,
      additionalPhoneNumberPriceCents: 500,
      smsPriceCents: 500,
      firstPhoneNumberFree: true,
    },
    hasScheduledChange: false,
    activePlanForPreview: planPro,
  });
  const diag = buildTenantPricingDiagnosticsFromPreview({
    tenantId: "tenant-x",
    settings: {
      metadata: { [BILLING_PRICING_MODE_METADATA_KEY]: "catalog" },
      billingPlanId: "p-pro",
      billingPlan: planPro,
      nextBillingPlanId: null,
      nextBillingPlanEffectiveAt: null,
      nextBillingPlan: null,
      extensionPriceCents: 9900,
      additionalPhoneNumberPriceCents: 500,
      smsPriceCents: 500,
      firstPhoneNumberFree: true,
    },
    preview,
  });
  assert.equal(diag.mode, "catalog");
  assert.equal(diag.pricingPreviewExplanation.tenantOverridesDetected, true);
  assert.ok(diag.warnings.some((w) => /Catalog mode:/i.test(w) && /differ/i.test(w)));
});

test("buildTenantPricingDiagnosticsFromPreview: custom + scheduled plan → bespoke warning text", () => {
  const next = { ...planPro, id: "p-next", name: "Enterprise" };
  const mode = parseBillingPricingMode({ [BILLING_PRICING_MODE_METADATA_KEY]: "custom" });
  assert.equal(mode, "custom");
  const resolution = resolveTenantBillingPricing({
    mode: "custom",
    settings: {
      extensionPriceCents: 1111,
      additionalPhoneNumberPriceCents: 222,
      smsPriceCents: 333,
      firstPhoneNumberFree: false,
    },
    activePlan: planPro,
  });
  const preview = explainAndWrap({
    pricingMode: "custom",
    pricingResolution: resolution,
    tenantPricing: {
      extensionPriceCents: 1111,
      additionalPhoneNumberPriceCents: 222,
      smsPriceCents: 333,
      firstPhoneNumberFree: false,
    },
    hasScheduledChange: false,
    activePlanForPreview: planPro,
  });
  const diag = buildTenantPricingDiagnosticsFromPreview({
    tenantId: "tenant-y",
    settings: {
      metadata: { [BILLING_PRICING_MODE_METADATA_KEY]: "custom" },
      billingPlanId: planPro.id,
      billingPlan: planPro,
      nextBillingPlanId: next.id,
      nextBillingPlanEffectiveAt: new Date("2027-08-01T00:00:00.000Z"),
      nextBillingPlan: next,
      extensionPriceCents: 1111,
      additionalPhoneNumberPriceCents: 222,
      smsPriceCents: 333,
      firstPhoneNumberFree: false,
    },
    preview,
  });
  assert.ok(diag.warnings.some((w) => /Custom mode/i.test(w) && /scheduled plan change/i.test(w)));
});

test("GET pricing-diagnostics-shaped payload keys (-assembler contract)", () => {
  const resolution = resolveTenantBillingPricing({
    mode: "legacy",
    settings: {
      extensionPriceCents: 0,
      additionalPhoneNumberPriceCents: 0,
      smsPriceCents: 0,
      firstPhoneNumberFree: true,
    },
    activePlan: planPro,
  });
  const preview = explainAndWrap({
    pricingMode: "legacy",
    pricingResolution: resolution,
    tenantPricing: { extensionPriceCents: 0, additionalPhoneNumberPriceCents: 0, smsPriceCents: 0, firstPhoneNumberFree: true },
    hasScheduledChange: false,
    activePlanForPreview: planPro,
  });
  const diag = buildTenantPricingDiagnosticsFromPreview({
    tenantId: "tenant-z",
    settings: {
      metadata: {},
      billingPlanId: planPro.id,
      billingPlan: planPro,
      nextBillingPlanId: null,
      nextBillingPlanEffectiveAt: null,
      nextBillingPlan: null,
      extensionPriceCents: 0,
      additionalPhoneNumberPriceCents: 0,
      smsPriceCents: 0,
      firstPhoneNumberFree: true,
    },
    preview,
  });
  assert.ok(Array.isArray(diag.pricingState.warnings));
  assert.equal(diag.pricingState.mode, diag.mode);
  assert.equal(diag.pricingState.resolution.extensionPriceCents, diag.effectiveInvoicePricing.extensionPriceCents);

  for (const k of [
    "tenantId",
    "mode",
    "billingPlanCurrent",
    "billingPlanEffectiveForPreview",
    "tenantStoredPricing",
    "effectiveInvoicePricing",
    "catalogBaselinePricing",
    "differsFromPlan",
    "scheduledPlanChange",
    "previewPeriod",
    "warnings",
    "notices",
    "explanationLines",
    "resetToPlanPreview",
    "pricingPreviewExplanation",
    "pricingState",
    "fetchedAt",
  ] as const) {
    assert.ok(k in diag, `missing ${k}`);
  }
});

test("resetToPlanPreview contract: maps custom row → catalog snapshot", () => {
  const diag = buildTenantPricingDiagnosticsFromPreview({
    tenantId: "t",
    settings: {
      metadata: { [BILLING_PRICING_MODE_METADATA_KEY]: "custom" },
      billingPlanId: planPro.id,
      billingPlan: planPro,
      nextBillingPlanId: null,
      nextBillingPlanEffectiveAt: null,
      nextBillingPlan: null,
      extensionPriceCents: 9000,
      additionalPhoneNumberPriceCents: 900,
      smsPriceCents: 900,
      firstPhoneNumberFree: true,
    },
    preview: explainAndWrap({
      pricingMode: "custom",
      pricingResolution: resolveTenantBillingPricing({
        mode: "custom",
        settings: {
          extensionPriceCents: 9000,
          additionalPhoneNumberPriceCents: 900,
          smsPriceCents: 900,
          firstPhoneNumberFree: true,
        },
        activePlan: planPro,
      }),
      tenantPricing: {
        extensionPriceCents: 9000,
        additionalPhoneNumberPriceCents: 900,
        smsPriceCents: 900,
        firstPhoneNumberFree: true,
      },
      hasScheduledChange: false,
      activePlanForPreview: planPro,
    }),
  });
  assert.equal(diag.resetToPlanPreview.after?.pricingMode, "catalog");
});

test("resetToPlanPreview before/after: pricing modes + mirrored plan cents", () => {
  const rtp = buildTenantPricingDiagnosticsFromPreview({
    tenantId: "t",
    settings: {
      metadata: {},
      billingPlanId: planPro.id,
      billingPlan: planPro,
      nextBillingPlanId: null,
      nextBillingPlanEffectiveAt: null,
      nextBillingPlan: null,
      extensionPriceCents: 777,
      additionalPhoneNumberPriceCents: 777,
      smsPriceCents: 777,
      firstPhoneNumberFree: false,
    },
    preview: explainAndWrap({
      pricingMode: "legacy",
      pricingResolution: resolveTenantBillingPricing({
        mode: "legacy",
        settings: { extensionPriceCents: 777, additionalPhoneNumberPriceCents: 777, smsPriceCents: 777, firstPhoneNumberFree: false },
        activePlan: planPro,
      }),
      tenantPricing: { extensionPriceCents: 777, additionalPhoneNumberPriceCents: 777, smsPriceCents: 777, firstPhoneNumberFree: false },
      hasScheduledChange: false,
      activePlanForPreview: planPro,
    }),
  }).resetToPlanPreview;
  assert.equal(rtp.canReset, true);
  assert(rtp.before && rtp.after);
  assert.equal(rtp.before.pricingMode === "catalog" || rtp.before.pricingMode === "custom" || rtp.before.pricingMode === "legacy", true);
  assert.equal(rtp.after!.pricingMode, "catalog");
  assert.equal(Number(rtp.after!.extensionPriceCents), planPro.extensionPriceCents);
});

test("mergeTenantBillingSettingsMetadata: mode-change audit would fire only when parseBillingPricingMode changes", () => {
  const fromLegacy = parseBillingPricingMode({});
  assert.equal(fromLegacy, "legacy");
  const toCatalogMeta = mergeTenantBillingSettingsMetadata({}, { billingPricingMode: "catalog" });
  const toCatalog = parseBillingPricingMode(toCatalogMeta);
  assert.notEqual(fromLegacy, toCatalog);

  const fromCatalogMeta = mergeTenantBillingSettingsMetadata({}, { billingPricingMode: "catalog" });
  const fromCatalog = parseBillingPricingMode(fromCatalogMeta);
  assert.equal(fromCatalog, "catalog");
  const sameAgain = parseBillingPricingMode(
    mergeTenantBillingSettingsMetadata(fromCatalogMeta as unknown, { billingPricingMode: "catalog" }),
  );
  assert.equal(fromCatalog, sameAgain);
});

test("GET pricing-diagnostics + platform billing routes: SUPER_ADMIN-only gate", () => {
  assert.equal(canAccessPlatformAdminBillingRoutes("SUPER_ADMIN"), true);
  assert.equal(canAccessPlatformAdminBillingRoutes("ADMIN"), false);
});
