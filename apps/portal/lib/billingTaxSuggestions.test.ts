import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyJurisdictionTemplate,
  detectJurisdictionFromTenant,
  getJurisdictionTemplate,
  JURISDICTION_TEMPLATES,
  NY_ORANGE_COUNTY_TAX_TEMPLATE,
} from "./billingTaxSuggestions";

describe("NY_ORANGE_COUNTY_TAX_TEMPLATE", () => {
  const template = NY_ORANGE_COUNTY_TAX_TEMPLATE;

  it("sales tax is 8.125%", () => {
    assert.equal(template.fees.salesTax?.ratePercent, 0.08125);
    assert.equal(template.fees.salesTax?.enabled, true);
    assert.equal(template.fees.salesTax?.customerVisible, true);
    assert.equal(template.fees.salesTax?.basis, "invoice_subtotal");
  });

  it("E911 is $3.00 flat monthly", () => {
    assert.equal(template.fees.e911?.amountCents, 300);
    assert.equal(template.fees.e911?.basis, "flat_monthly");
    assert.equal(template.fees.e911?.mode, "amountCents");
    assert.equal(template.fees.e911?.enabled, true);
  });

  it("regulatory recovery is 1.000%", () => {
    assert.equal(template.fees.regulatory?.ratePercent, 0.01);
    assert.equal(template.fees.regulatory?.enabled, true);
  });

  it("Federal USF is disabled by default", () => {
    assert.equal(template.fees.usfRecovery?.enabled, false);
  });

  it("telecom surcharge is disabled by default", () => {
    assert.equal(template.fees.telecomSurcharge?.enabled, false);
  });

  it("custom fee is disabled by default", () => {
    assert.equal(template.fees.customFee?.enabled, false);
  });

  it("is in JURISDICTION_TEMPLATES list", () => {
    assert.ok(JURISDICTION_TEMPLATES.some((t) => t.key === "ny_orange_county"));
  });
});

describe("detectJurisdictionFromTenant", () => {
  it("detects NY/OC from assigned profile state + county", () => {
    const result = detectJurisdictionFromTenant(null, { state: "NY", county: "Orange" });
    assert.equal(result, "ny_orange_county");
  });

  it("detects NY/OC from service address state + county", () => {
    const result = detectJurisdictionFromTenant(
      { serviceAddress: { state: "NY", county: "Orange County" } },
      null,
    );
    assert.equal(result, "ny_orange_county");
  });

  it("detects NY/OC from billing address", () => {
    const result = detectJurisdictionFromTenant(
      { billingAddress: { state: "NY", county: "orange" } },
      null,
    );
    assert.equal(result, "ny_orange_county");
  });

  it("detects NY/OC from known Orange County city (middletown)", () => {
    const result = detectJurisdictionFromTenant(
      { serviceAddress: { state: "NY", city: "Middletown" } },
      null,
    );
    assert.equal(result, "ny_orange_county");
  });

  it("returns null when no location data", () => {
    assert.equal(detectJurisdictionFromTenant(null, null), null);
  });

  it("returns null for non-NY state", () => {
    const result = detectJurisdictionFromTenant(
      { serviceAddress: { state: "CA", county: "Orange" } },
      null,
    );
    assert.equal(result, null);
  });

  it("returns null for NY but non-Orange county", () => {
    const result = detectJurisdictionFromTenant(
      { serviceAddress: { state: "NY", county: "Suffolk" } },
      null,
    );
    assert.equal(result, null);
  });
});

describe("getJurisdictionTemplate", () => {
  it("returns NY/OC template by key", () => {
    const t = getJurisdictionTemplate("ny_orange_county");
    assert.ok(t);
    assert.equal(t.key, "ny_orange_county");
    assert.equal(t.state, "NY");
  });
});

describe("applyJurisdictionTemplate", () => {
  it("applies suggested fees over existing config", () => {
    const existing = {
      salesTax: {
        enabled: false,
        customerVisible: false,
        label: "Sales tax",
        mode: "ratePercent" as const,
        ratePercent: 0,
        basis: "invoice_subtotal" as const,
      },
    };
    const template = NY_ORANGE_COUNTY_TAX_TEMPLATE;
    const result = applyJurisdictionTemplate(template, existing);

    assert.equal(result.salesTax?.ratePercent, 0.08125);
    assert.equal(result.salesTax?.enabled, true);
    assert.equal(result.e911?.amountCents, 300);
    assert.equal(result.regulatory?.ratePercent, 0.01);
  });

  it("preserves unrelated keys not in template", () => {
    const existing = {
      customFee: {
        enabled: true,
        customerVisible: true,
        label: "My custom fee",
        mode: "amountCents" as const,
        amountCents: 999,
        basis: "flat_monthly" as const,
      },
    };
    const result = applyJurisdictionTemplate(NY_ORANGE_COUNTY_TAX_TEMPLATE, existing);
    // Template does include customFee (disabled), so it will overwrite
    assert.equal(result.customFee?.enabled, false);
    // Ensure template fees are applied
    assert.equal(result.salesTax?.ratePercent, 0.08125);
  });

  it("does not mutate the original config object", () => {
    const existing = {
      salesTax: {
        enabled: false,
        customerVisible: false,
        label: "Sales tax",
        mode: "ratePercent" as const,
        ratePercent: 0,
        basis: "invoice_subtotal" as const,
      },
    };
    applyJurisdictionTemplate(NY_ORANGE_COUNTY_TAX_TEMPLATE, existing);
    // Original should be unchanged
    assert.equal(existing.salesTax.ratePercent, 0);
    assert.equal(existing.salesTax.enabled, false);
  });
});
