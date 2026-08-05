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
import {
  BILLING_TELECOM_FEES_METADATA_KEY,
  mergeBillingTelecomFeesIntoMetadata,
  type BillingTelecomFeesConfig,
} from "../billing/billingTelecomFees";

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

  const metadata = mergeBillingTelecomFeesIntoMetadata(
    settings?.metadata,
    onboardingTelecomFeesConfig({ tollFreeNumber: !!opts.tollFreeNumber }),
  );
  const smsPatch = opts.smsEnabled ? { smsBillingEnabled: true } : {};
  await dbc.tenantBillingSettings.upsert({
    where: { tenantId },
    create: { tenantId, taxEnabled: true, metadata, ...smsPatch },
    update: { taxEnabled: true, metadata, ...smsPatch },
  });
  return { stamped: true, reason: "stamped onboarding fee defaults" };
}
