// ── Month 2 must equal the sign-up quote ─────────────────────────────────────
//
// The wizard's first invoice is built line-by-line from the quote
// (packages/shared/src/onboardingPricing.ts): $30/extension tax included,
// $3 E911 per phone number, $2/month flat telecom & regulatory fees — one
// extension + one number = $35, and the checkout page and report email both
// say "$35 a month, including tax".
//
// The RECURRING engine (billing/invoiceEngine.ts) knows none of that: it bills
// from TenantBillingSettings, where extensions default to the right $30 but
// E911 and the $2 fee only exist if metadata.billingTelecomFees says so — and
// fee lines only build at all when taxEnabled is on. A tenant created by
// onboarding with nothing stamped would get a $30 month-2 bill and quietly
// break the $35 promise.
//
// So every tenant onboarding creates (or adopts) gets stamped here with a fee
// config that reproduces the quote exactly. Two deliberate choices:
//
//   - E911 uses the `per_phone_number` basis (every active number, including
//     the "first number free" one and PBX-synced DIDs) — the quote charges E911
//     per NUMBER, and the older `per_did` basis counts only billable numbers,
//     which is zero for a one-number tenant.
//   - salesTax is stamped explicitly DISABLED: the $30 extension price already
//     includes tax, so a percentage on top would double-charge it.
//
// The stamp refuses to touch any tenant that already has a fee config or has
// taxes enabled — operator-configured billing always wins, and re-runs are
// no-ops.

import { ONBOARDING_PRICES } from "@connect/shared";
import { writeServiceInterruption } from "../billing/serviceInterruption/serviceInterruptionSettings";
import {
  BILLING_TELECOM_FEES_METADATA_KEY,
  mergeBillingTelecomFeesIntoMetadata,
  type BillingTelecomFeesConfig,
} from "../billing/billingTelecomFees";
import { mergeAllInclusivePricingIntoMetadata } from "../billing/billingAccountPricing";

/** The recurring-billing mirror of the sign-up quote's fee lines. */
export function onboardingTelecomFeesConfig(opts: { tollFreeNumber?: boolean } = {}): BillingTelecomFeesConfig {
  return {
    // The wizard's toll-free (or vanity) pick recurs as its $15/month line.
    // FLAT on purpose: the `per_toll_free_did` basis counts phoneNumber rows,
    // and onboarding never writes those — a per-DID basis would quietly bill
    // $0 in month 2 and break the quoted price.
    ...(opts.tollFreeNumber
      ? {
          customFee: {
            enabled: true,
            customerVisible: true,
            label: "Toll-free number",
            description: "Your toll-free (8xx) number.",
            mode: "amountCents" as const,
            amountCents: ONBOARDING_PRICES.tollFreeNumberMonthlyCents,
            basis: "flat_monthly" as const,
            // ⛔ This one is OUR charge, not a tax. Customer prices are
            // all-inclusive, so a real fee lives inside the total while this
            // adds to it — see billing/billingAccountPricing.ts.
            serviceCharge: true,
          },
        }
      : {}),
    e911: {
      enabled: true,
      customerVisible: true,
      label: "Emergency calling (E911)",
      description: "Required on every phone number so 911 knows where you are.",
      mode: "amountCents",
      amountCents: ONBOARDING_PRICES.e911MonthlyCents,
      basis: "per_phone_number",
    },
    regulatory: {
      enabled: true,
      customerVisible: true,
      label: "Telecom & regulatory fees",
      description: "Covers taxes and carrier fees.",
      mode: "amountCents",
      amountCents: ONBOARDING_PRICES.telecomFeesMonthlyCents,
      basis: "flat_monthly",
    },
    salesTax: {
      enabled: false,
      customerVisible: false,
      label: "Sales tax",
      description: "Included in the quoted extension price — never added on top.",
      mode: "ratePercent",
      ratePercent: 0,
      basis: "invoice_subtotal",
    },
  };
}

export type OnboardingBillingStampResult = { stamped: boolean; reason: string };

/**
 * Stamp an onboarding-created tenant's billing settings so its recurring
 * invoices match the sign-up quote. Idempotent, and refuses to overwrite any
 * billing an operator (or an earlier stamp) already configured.
 *
 * `smsEnabled` mirrors the wizard's messaging choice onto smsBillingEnabled so
 * the $10/month SMS line from the quote recurs too (it is only ever switched
 * ON here — never off). `tollFreeNumber` does the same for a toll-free/vanity
 * pick: the $15/month line recurs as a flat fee.
 */
export async function ensureOnboardingBillingDefaults(
  dbc: any,
  tenantId: string,
  opts: { smsEnabled?: boolean; tollFreeNumber?: boolean } = {},
): Promise<OnboardingBillingStampResult> {
  const settings = await dbc.tenantBillingSettings.findUnique({ where: { tenantId } });

  const existingMeta =
    settings?.metadata && typeof settings.metadata === "object" && !Array.isArray(settings.metadata)
      ? (settings.metadata as Record<string, unknown>)
      : {};
  if (existingMeta[BILLING_TELECOM_FEES_METADATA_KEY]) {
    return { stamped: false, reason: "telecom fee config already present" };
  }
  if (settings?.taxEnabled) {
    return { stamped: false, reason: "taxes already enabled on this tenant" };
  }

  // ⛔ All-inclusive pricing is stamped HERE and only here — on a tenant this
  // sign-up is creating. It is the "going forward" half of Izzy's 2026-08-16
  // instruction: new accounts get the (extensions × price) + one account fee
  // model with real taxes carved out of the total, and no account that already
  // existed is touched. This stamp cannot reach one: it refuses any tenant that
  // already has a fee config or has taxes enabled (checked above).
  // Izzy, 2026-08-17: the overdue-account service interruption "goes from now
  // on for any new customer" — so a fresh sign-up has the switch ON. Existing
  // accounts are untouched (this stamp cannot reach them), and the sweep's
  // cutover date guarantees no failure from before it is ever acted on.
  const metadata = writeServiceInterruption(
    mergeAllInclusivePricingIntoMetadata(
      mergeBillingTelecomFeesIntoMetadata(
        settings?.metadata,
        onboardingTelecomFeesConfig({ tollFreeNumber: !!opts.tollFreeNumber }),
      ),
      true,
    ),
    { enabled: true },
  );
  const smsPatch = opts.smsEnabled ? { smsBillingEnabled: true } : {};
  await dbc.tenantBillingSettings.upsert({
    where: { tenantId },
    create: { tenantId, taxEnabled: true, metadata, ...smsPatch },
    update: { taxEnabled: true, metadata, ...smsPatch },
  });
  return { stamped: true, reason: "stamped onboarding fee defaults" };
}

// ── Admin-set add-ons: cold calling + CRM (Izzy, 2026-09-16) ────────────────
//
// The first invoice prices these from the quote. Month 2 must bill the same:
//   - cold calling on EVERY extension → the tenant's extension price becomes
//     $65, so extensions added later are cold-calling priced too;
//   - cold calling on SOME (N) → the price stays $30 and a recurring "$35 × N"
//     difference line rides billingRecurringCustomLines;
//   - CRM on N extensions → a recurring "$20 × N" line.
// Lines this writes are tagged `source: "onboarding_addon"` and replaced on
// every run, so a re-run (checkout revisit, then the build) never duplicates
// them, and lines anyone else put there are left alone.
// ⛔ Not behind the fee-config guard above: that guard makes the stamp a
// no-op after checkout, and the build's extension count is the final truth.

export type OnboardingAddOnBilling = { coldCallingAll: boolean; coldCallingExtensions: number; crmExtensions: number };

export function onboardingAddOnRecurringLines(a: OnboardingAddOnBilling): Array<{ description: string; amountCents: number; taxable: false; source: "onboarding_addon"; addon: string }> {
  const lines: Array<{ description: string; amountCents: number; taxable: false; source: "onboarding_addon"; addon: string }> = [];
  const diff = ONBOARDING_PRICES.coldCallingExtensionMonthlyCents - ONBOARDING_PRICES.extensionMonthlyWithTaxCents;
  if (!a.coldCallingAll && a.coldCallingExtensions > 0) {
    const n = a.coldCallingExtensions;
    lines.push({ description: `Cold-calling phone lines (${n} × $${diff / 100} over the standard line)`, amountCents: n * diff, taxable: false, source: "onboarding_addon", addon: "cold_calling" });
  }
  if (a.crmExtensions > 0) {
    const n = a.crmExtensions;
    lines.push({ description: `CRM (${n} extension${n === 1 ? "" : "s"} × $${ONBOARDING_PRICES.crmPerExtensionMonthlyCents / 100})`, amountCents: n * ONBOARDING_PRICES.crmPerExtensionMonthlyCents, taxable: false, source: "onboarding_addon", addon: "crm" });
  }
  return lines;
}

export async function applyOnboardingAddOnBilling(dbc: any, tenantId: string, a: OnboardingAddOnBilling): Promise<{ changed: boolean }> {
  const wantsAny = a.coldCallingAll || a.coldCallingExtensions > 0 || a.crmExtensions > 0;
  const settings = await dbc.tenantBillingSettings.findUnique({ where: { tenantId } });
  const meta: Record<string, unknown> =
    settings?.metadata && typeof settings.metadata === "object" && !Array.isArray(settings.metadata) ? { ...(settings.metadata as any) } : {};
  const existing = Array.isArray(meta.billingRecurringCustomLines) ? (meta.billingRecurringCustomLines as any[]) : [];
  const hadAddOns = existing.some((l) => l?.source === "onboarding_addon");
  if (!wantsAny && !hadAddOns) return { changed: false };
  const kept = existing.filter((l) => l?.source !== "onboarding_addon");
  const next = [...kept, ...onboardingAddOnRecurringLines(a)];
  if (next.length > 0) meta.billingRecurringCustomLines = next;
  else delete meta.billingRecurringCustomLines;
  const pricePatch = a.coldCallingAll ? { extensionPriceCents: ONBOARDING_PRICES.coldCallingExtensionMonthlyCents } : {};
  await dbc.tenantBillingSettings.upsert({
    where: { tenantId },
    create: { tenantId, metadata: meta, ...pricePatch },
    update: { metadata: meta, ...pricePatch },
  });
  return { changed: true };
}
