/**
 * Jurisdiction-based tax/fee suggestion templates for the Admin Billing → Taxes page.
 *
 * These are suggested starting rates only — not legal advice.
 * Operators must confirm all values with their tax advisor before applying them.
 */

import type { BillingTelecomFeesConfig } from "./billingTelecomFees";

export type JurisdictionKey = "ny_orange_county";

export type JurisdictionTemplate = {
  key: JurisdictionKey;
  label: string;
  description: string;
  state: string;
  county?: string;
  fees: BillingTelecomFeesConfig;
};

/**
 * New York / Orange County suggested starting rates.
 * Sales tax: 8.125%, E911: $3.00 flat monthly, Regulatory: 1.000%.
 * Federal USF and telecom surcharge: off by default.
 */
export const NY_ORANGE_COUNTY_TAX_TEMPLATE: JurisdictionTemplate = {
  key: "ny_orange_county",
  label: "New York — Orange County",
  description:
    "Suggested starting rates for New York / Orange County. Confirm with your tax advisor.",
  state: "NY",
  county: "Orange",
  fees: {
    salesTax: {
      enabled: true,
      customerVisible: true,
      label: "Sales tax",
      description: "Suggested based on New York / Orange County. Confirm with your tax advisor.",
      suggested: true,
      mode: "ratePercent",
      ratePercent: 0.08125,
      basis: "invoice_subtotal",
    },
    e911: {
      enabled: true,
      customerVisible: true,
      label: "Suggested E911 fee",
      description: "Not a legal guarantee. Confirm E911 obligations with your advisor.",
      suggested: true,
      mode: "amountCents",
      amountCents: 300,
      basis: "flat_monthly",
    },
    regulatory: {
      enabled: true,
      customerVisible: true,
      label: "Regulatory recovery fee",
      description: "Percent of taxable service subtotal.",
      suggested: true,
      mode: "ratePercent",
      ratePercent: 0.01,
      basis: "invoice_subtotal",
    },
    telecomSurcharge: {
      enabled: false,
      customerVisible: false,
      label: "Telecom surcharge",
      description: "Optional carrier surcharge (estimate only until invoiced).",
      suggested: true,
      mode: "ratePercent",
      ratePercent: 0,
      basis: "invoice_subtotal",
    },
    usfRecovery: {
      enabled: false,
      customerVisible: false,
      label: "Federal / USF recovery fee",
      description: "Optional USF-style recovery (estimate only until invoiced).",
      suggested: true,
      mode: "ratePercent",
      ratePercent: 0,
      basis: "invoice_subtotal",
    },
    customFee: {
      enabled: false,
      customerVisible: false,
      label: "Other custom fee",
      description: "Custom flat or unit fee (estimate only until invoiced).",
      suggested: false,
      mode: "amountCents",
      amountCents: 0,
      basis: "flat_monthly",
    },
  },
};

export const JURISDICTION_TEMPLATES: JurisdictionTemplate[] = [
  NY_ORANGE_COUNTY_TAX_TEMPLATE,
];

/**
 * Detect the best matching jurisdiction from a tenant's settings and assigned TaxProfile.
 * Checks TaxProfile state/county first, then serviceAddress, then billingAddress.
 * Returns null if no match is found.
 */
export function detectJurisdictionFromTenant(
  settings: Record<string, unknown> | null | undefined,
  assignedProfile: { state?: string; county?: string | null } | null | undefined,
): JurisdictionKey | null {
  // Check assigned TaxProfile state/county
  if (
    assignedProfile?.state &&
    String(assignedProfile.state).toUpperCase() === "NY" &&
    String(assignedProfile.county || "").toLowerCase().includes("orange")
  ) {
    return "ny_orange_county";
  }
  // Check service address
  const sa = settings?.serviceAddress;
  if (sa && typeof sa === "object" && !Array.isArray(sa)) {
    const addr = sa as Record<string, unknown>;
    const state = String(addr.state ?? addr.stateCode ?? "").toUpperCase();
    const county = String(addr.county ?? "").toLowerCase();
    if (state === "NY" && county.includes("orange")) return "ny_orange_county";
    // Also accept city-based detection for Middletown / Newburgh / Port Jervis
    if (state === "NY") {
      const city = String(addr.city ?? "").toLowerCase();
      if (["middletown", "newburgh", "port jervis", "goshen", "warwick", "monroe"].some((c) => city.includes(c))) {
        return "ny_orange_county";
      }
    }
  }
  // Check billing address
  const ba = settings?.billingAddress;
  if (ba && typeof ba === "object" && !Array.isArray(ba)) {
    const addr = ba as Record<string, unknown>;
    const state = String(addr.state ?? addr.stateCode ?? "").toUpperCase();
    const county = String(addr.county ?? "").toLowerCase();
    if (state === "NY" && county.includes("orange")) return "ny_orange_county";
  }
  return null;
}

/** Look up a jurisdiction template by key. */
export function getJurisdictionTemplate(key: JurisdictionKey): JurisdictionTemplate | undefined {
  return JURISDICTION_TEMPLATES.find((t) => t.key === key);
}

/**
 * Merge a jurisdiction template's fees over the current fees, preserving manual
 * overrides for any key the operator already customised (non-suggested keys kept as-is).
 * Template-suggested keys are always overwritten.
 */
export function applyJurisdictionTemplate(
  template: JurisdictionTemplate,
  current: BillingTelecomFeesConfig,
): BillingTelecomFeesConfig {
  const result: BillingTelecomFeesConfig = { ...current };
  for (const [key, templateFee] of Object.entries(template.fees) as [keyof BillingTelecomFeesConfig, (typeof template.fees)[keyof typeof template.fees]][]) {
    if (!templateFee) continue;
    // Always overwrite keys included in the template (they carry suggested: true/false)
    result[key] = { ...templateFee };
  }
  return result;
}
