// ── The customer's price is all-inclusive ────────────────────────────────────
//
// Izzy's pricing model (2026-08-16):
//
//   customer_total = (extension_count × extension price) + ONE account fee
//
// with the commercial extension price at $30.00/month and the account fee at
// $5.00/month — charged ONCE per account, never once per extension. So one
// extension is $35.00, two are $65.00, five are $155.00.
//
// ⛔ THE RULE: that total is FINAL. Taxes, E911, telecom taxes and regulatory
// fees are NOT added on top of it — they live INSIDE it. What changes with the
// real fee amounts is how the same total is split:
//
//   net_service_revenue      = customer_total − total_actual_taxes_and_fees
//   net_revenue_per_extension = net_service_revenue / extension_count
//
// The $5 is a PRICING input, not a cap on real fees and not a tax line:
//
//   - fees ABOVE $5 (a second phone number is another $3 of E911) are absorbed
//     out of the per-extension service revenue — the customer's total does not
//     move;
//   - fees BELOW $5 leave the remainder as service revenue. It must never be
//     re-labelled as a government tax, and it isn't: only the fee lines the fee
//     engine actually produced are booked as taxes.
//
// The invariant this module exists to guarantee, on every invoice:
//
//   net_service_revenue + total_actual_taxes_and_fees = customer_total
//
// It holds by construction — the service revenue is derived by SUBTRACTING the
// real fees from the pinned total, never by adding anything up and hoping the
// rounding lands. Nothing here is hard-coded to $27.40 or any other split; the
// per-extension net is whatever this month's real fees leave behind.
//
// Money is in CENTS. Never floats — see packages/shared/src/onboardingPricing.ts.

/** Stored on `TenantBillingSettings.metadata.billingAccountFeeCents` — no migration. */
export const BILLING_ACCOUNT_FEE_METADATA_KEY = "billingAccountFeeCents";

/**
 * The fixed taxes-and-fees allocation every account carries, per month.
 * $5.00 — the "+ 5.00" in `(extension_count × 30.00) + 5.00`.
 */
export const DEFAULT_ACCOUNT_TAXES_AND_FEES_CENTS = 500;

export function parseAccountTaxesAndFeesCents(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[BILLING_ACCOUNT_FEE_METADATA_KEY];
  if (raw === null || raw === undefined) return null;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * The account fee for this tenant. Defaults to $5.00; a per-tenant override
 * (including `0`, for an account that was sold without it) wins.
 */
export function resolveAccountTaxesAndFeesCents(metadata: unknown): number {
  const stored = parseAccountTaxesAndFeesCents(metadata);
  return stored === null ? DEFAULT_ACCOUNT_TAXES_AND_FEES_CENTS : stored;
}

export function mergeAccountTaxesAndFeesIntoMetadata(
  prev: unknown,
  accountFeeCents: number | null | undefined,
): Record<string, unknown> {
  const prevMeta =
    prev && typeof prev === "object" && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  if (accountFeeCents === undefined) return prevMeta;
  if (accountFeeCents === null) {
    delete prevMeta[BILLING_ACCOUNT_FEE_METADATA_KEY];
    return prevMeta;
  }
  return { ...prevMeta, [BILLING_ACCOUNT_FEE_METADATA_KEY]: Math.max(0, Math.round(accountFeeCents)) };
}

/**
 * Is this fee line an actual tax / government fee — something owed to somebody
 * else, and therefore something that lives INSIDE the customer's total?
 *
 * ⛔ Judge it by the config's explicit `serviceCharge` flag, NEVER by which
 * bucket it sits in. `customFee` looks like the commercial bucket and is not:
 * on 2026-08-16, six live tenants (Trust Bookkeepings, Luxure, Smooth Leasing,
 * Secro, ADDB, Solidify) carry their real $2.00–$2.44 telecom & regulatory fee
 * there under the generic label "Other custom fee", while the one genuinely
 * commercial user of it — onboarding's $15/month toll-free number — is
 * elsewhere in the same bucket. Splitting on the key alone would have raised
 * six customers' bills by $2 and booked a government charge as income.
 *
 * So: default to "this is a real fee". Only a config that says otherwise is
 * treated as service revenue that ADDS to what the customer owes.
 */
export function isGovernmentTaxOrFeeLine(line: { metadata?: Record<string, unknown> | null }): boolean {
  return line.metadata?.telecomFeeIsServiceCharge !== true;
}

export type TaxInclusiveBaseSolution<T> = {
  /** The taxable service revenue the fees were actually computed against. */
  taxableBaseCents: number;
  /** Whatever `computeFees` returned at `taxableBaseCents` — fee lines + audit. */
  fees: T;
  totalFeesCents: number;
  converged: boolean;
  iterations: number;
};

/**
 * Back out the taxable service revenue hiding inside a tax-INCLUSIVE price.
 *
 * A percentage fee (sales tax, USF/regulatory recovery) is owed on the SERVICE
 * revenue, not on the customer's all-in total — charging 8% of a total that
 * already contains the 8% taxes the tax. So we solve for the base `b` where
 *
 *   b + fees(b) = taxable_gross
 *
 * by fixed-point iteration: each pass re-asks the real fee engine what it would
 * charge on the current base. Percentage rates sum to well under 1, so it
 * contracts fast (typically 2–3 passes); integer rounding can make the last
 * cent oscillate, which is why this is capped rather than looped to a fixed
 * point. That is harmless — the caller derives service revenue by SUBTRACTING
 * the returned fees from the pinned total, so `net + fees = total` holds at
 * whatever base we stop on. Only the last cent of a percentage line is at
 * stake, and the returned fees are always the ones computed AT the returned
 * base, so the audit trail never disagrees with the invoice.
 *
 * Fixed-amount fees (E911 at $3 a number) do not depend on the base at all —
 * for a tenant with only those, the first pass is already exact.
 */
export function solveTaxInclusiveTaxableBase<T>(input: {
  taxableGrossCents: number;
  computeFees: (taxableBaseCents: number) => { result: T; totalFeesCents: number };
  maxIterations?: number;
}): TaxInclusiveBaseSolution<T> {
  const gross = Math.max(0, Math.round(Number(input.taxableGrossCents) || 0));
  const maxIterations = Math.max(1, input.maxIterations ?? 12);

  let base = gross;
  let evaluated = input.computeFees(base);
  for (let i = 1; i <= maxIterations; i++) {
    const next = Math.max(0, gross - evaluated.totalFeesCents);
    if (next === base) {
      return { taxableBaseCents: base, fees: evaluated.result, totalFeesCents: evaluated.totalFeesCents, converged: true, iterations: i };
    }
    base = next;
    evaluated = input.computeFees(base);
  }
  return {
    taxableBaseCents: base,
    fees: evaluated.result,
    totalFeesCents: evaluated.totalFeesCents,
    converged: false,
    iterations: maxIterations,
  };
}

/**
 * What the split came out as. Persisted on `BillingInvoice.metadata.accountPricing`
 * and returned on the preview so accounting can read the real numbers instead of
 * re-deriving them from line items.
 */
export type BillingAccountPricingSummary = {
  /** False = this invoice has no billable extension to price per-extension against. */
  applied: boolean;
  reason: string;
  extensionCount: number;
  /** The configured allocation, per month. */
  accountFeeCentsPerMonth: number;
  /** …scaled by the invoice's billing month count. */
  accountFeeCents: number;
  /** The final, all-inclusive amount the customer owes. */
  customerTotalCents: number;
  /**
   * Every real tax / E911 / regulatory / telecom fee line on this invoice —
   * government charges only. Operator `customFee` lines are service revenue and
   * are deliberately NOT counted here.
   */
  totalTaxesAndFeesCents: number;
  /** customer_total − total_actual_taxes_and_fees. */
  netServiceRevenueCents: number;
  /** net_service_revenue / extension_count, rounded to the cent for display. */
  netRevenuePerExtensionCents: number;
  /** …and unrounded, for accounting that cannot afford the rounding. */
  netRevenuePerExtensionCentsExact: number;
  /**
   * accountFee − actual fees, applied to the extension line. Positive = the
   * real fees came in under the $5 allocation; negative = the excess was
   * absorbed out of service revenue.
   */
  serviceRevenueAdjustmentCents: number;
  /** The service base the percentage fees were computed on. */
  taxableBaseCents: number;
  /**
   * True when the real fees outran the extension line's whole revenue, so it
   * clamped at zero and the customer's total had to rise above the formula
   * rather than go negative. Should never happen in practice — it is here so a
   * pathological fee config is visible instead of silent.
   */
  feesExceedCommercialRevenue: boolean;
};

export function buildAccountPricingSummary(input: {
  applied: boolean;
  reason: string;
  extensionCount: number;
  accountFeeCentsPerMonth: number;
  accountFeeCents: number;
  customerTotalCents: number;
  totalTaxesAndFeesCents: number;
  serviceRevenueAdjustmentCents: number;
  taxableBaseCents: number;
  feesExceedCommercialRevenue: boolean;
}): BillingAccountPricingSummary {
  const extensionCount = Math.max(0, Math.round(input.extensionCount));
  // Derived by SUBTRACTION, never summed — this is what makes
  // net + fees = total true on every invoice regardless of rounding.
  const netServiceRevenueCents = input.customerTotalCents - input.totalTaxesAndFeesCents;
  const perExtensionExact = extensionCount > 0 ? netServiceRevenueCents / extensionCount : 0;
  return {
    applied: input.applied,
    reason: input.reason,
    extensionCount,
    accountFeeCentsPerMonth: input.accountFeeCentsPerMonth,
    accountFeeCents: input.accountFeeCents,
    customerTotalCents: input.customerTotalCents,
    totalTaxesAndFeesCents: input.totalTaxesAndFeesCents,
    netServiceRevenueCents,
    netRevenuePerExtensionCents: Math.round(perExtensionExact),
    netRevenuePerExtensionCentsExact: Math.round(perExtensionExact * 10000) / 10000,
    serviceRevenueAdjustmentCents: input.serviceRevenueAdjustmentCents,
    taxableBaseCents: input.taxableBaseCents,
    feesExceedCommercialRevenue: input.feesExceedCommercialRevenue,
  };
}
