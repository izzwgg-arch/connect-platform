// ── What a new customer pays ─────────────────────────────────────────────────
//
// Set by Izzy 2026-08-04. These are the numbers quoted in the sign-up wizard
// and charged on the first invoice, so they live in ONE place — a price that
// disagrees between the quote and the invoice is the kind of thing a customer
// never forgets.
//
// Money is in CENTS everywhere. Never floats: 0.1 + 0.2 is not 0.3, and that
// is not a rounding error anyone wants on a bill.

export const ONBOARDING_PRICES = {
  /** Per extension, per month, BEFORE tax. */
  extensionMonthlyCents: 2500,
  /**
   * Per extension, per month, WITH tax — the figure the customer is quoted and
   * agrees to. Izzy: "$25 an extension plus tax, which makes it $30 an
   * extension, with tax included."
   *
   * Held as its own number rather than derived from a tax rate on purpose:
   * the customer was promised a round $30, and a percentage would drift with
   * rate changes and rounding. The tax ENGINE
   * (apps/api/src/billing/billingTelecomFees.ts) still computes real tax for
   * the invoice; this is the promise made at sign-up.
   */
  extensionMonthlyWithTaxCents: 3000,
  /** E911, per phone number, per month. Matches the platform default. */
  e911MonthlyCents: 300,
  /** Business messaging, per month, flat. */
  smsMonthlyCents: 1000,
  /** Each LOCAL phone number BEYOND the first. The first local number is included. */
  additionalNumberMonthlyCents: 1000,
  /**
   * A toll-free (8xx) number — regular or vanity — per month. Izzy 2026-08-04:
   * toll-free is $15/month, and it does NOT ride the "first number included"
   * rule; that rule is for local numbers only.
   */
  tollFreeNumberMonthlyCents: 1500,
  /**
   * Telecom & regulatory fees, per month, flat per account. Izzy 2026-08-04:
   * one extension must always come to $35 — $30 the line, $3 E911, and $2
   * covering taxes and carrier/regulatory fees.
   */
  telecomFeesMonthlyCents: 200,
  /**
   * A COLD-CALLING extension, per month, tax included. Izzy 2026-09-16: "cold
   * calling is always double, so $65 an extension." It REPLACES the $30 line
   * for that extension — never added on top of it.
   */
  coldCallingExtensionMonthlyCents: 6500,
  /** CRM, per extension, per month, on top of the line. Izzy 2026-09-16: "$20 a month extra per extension for CRM." */
  crmPerExtensionMonthlyCents: 2000,
} as const;

export interface OnboardingQuoteInput {
  /** How many extensions they set up. */
  extensions: number;
  /** How many phone numbers in total (1 = just the main one). */
  phoneNumbers: number;
  smsEnabled: boolean;
  /**
   * The MAIN number they picked is toll-free (regular or vanity). Adds the
   * $15/month toll-free line; the "first number included" freebie then applies
   * to the first LOCAL number instead.
   */
  tollFreeNumber?: boolean;
  /**
   * How many of `extensions` are cold-calling lines ($65 instead of $30). Set
   * by an admin on the link, never by the customer; clamped to `extensions`.
   */
  coldCallingExtensions?: number;
  /** How many extensions carry CRM ($20 each on top). Admin-set; clamped to `extensions`. */
  crmExtensions?: number;
}

export interface QuoteLine {
  key: "extensions" | "cold_calling_extensions" | "crm" | "e911" | "sms" | "additional_numbers" | "tollfree_number" | "telecom_fees";
  /** Plain-English, customer-facing. */
  label: string;
  quantity: number;
  unitCents: number;
  totalCents: number;
  /** Shown under the line so nobody has to ask what it is. */
  note?: string;
}

export interface OnboardingQuote {
  lines: QuoteLine[];
  /** What they will be charged every month, tax included. */
  monthlyTotalCents: number;
}

/** "$30.00" — for anything a customer reads. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * The monthly bill for a new customer, itemised.
 *
 * Extensions are priced at the tax-included figure because that is what was
 * promised; every other line is a flat fee with no tax component quoted.
 */
export function quoteOnboarding(input: OnboardingQuoteInput): OnboardingQuote {
  const extensions = Math.max(0, Math.floor(input.extensions || 0));
  const numbers = Math.max(0, Math.floor(input.phoneNumbers || 0));
  const tollFree = !!input.tollFreeNumber && numbers > 0;
  // The toll-free number is priced on its own $15 line — it neither consumes
  // the "first number included" freebie (that's for local numbers) nor gets
  // charged again as a $10 extra.
  const localNumbers = numbers - (tollFree ? 1 : 0);
  const extraNumbers = Math.max(0, localNumbers - 1); // the first LOCAL number is included
  const lines: QuoteLine[] = [];
  const clamp = (n: unknown) => Math.min(extensions, Math.max(0, Math.floor(Number(n) || 0)));
  const coldCalling = clamp(input.coldCallingExtensions);
  const regular = extensions - coldCalling;
  const crm = clamp(input.crmExtensions);

  if (regular > 0) {
    lines.push({
      key: "extensions",
      label: regular === 1 ? "Phone line" : "Phone lines",
      quantity: regular,
      unitCents: ONBOARDING_PRICES.extensionMonthlyWithTaxCents,
      totalCents: regular * ONBOARDING_PRICES.extensionMonthlyWithTaxCents,
      note: "One for each person. Tax is already included.",
    });
  }
  if (coldCalling > 0) {
    lines.push({
      key: "cold_calling_extensions",
      label: coldCalling === 1 ? "Cold-calling phone line" : "Cold-calling phone lines",
      quantity: coldCalling,
      unitCents: ONBOARDING_PRICES.coldCallingExtensionMonthlyCents,
      totalCents: coldCalling * ONBOARDING_PRICES.coldCallingExtensionMonthlyCents,
      note: "Phone lines used for outbound cold calling. Tax is already included.",
    });
  }
  if (crm > 0) {
    lines.push({
      key: "crm",
      label: "CRM",
      quantity: crm,
      unitCents: ONBOARDING_PRICES.crmPerExtensionMonthlyCents,
      totalCents: crm * ONBOARDING_PRICES.crmPerExtensionMonthlyCents,
      note: crm === 1 ? "CRM for one extension." : `CRM for ${crm} extensions.`,
    });
  }
  if (numbers > 0) {
    lines.push({
      key: "e911",
      label: "Emergency calling (E911)",
      quantity: numbers,
      unitCents: ONBOARDING_PRICES.e911MonthlyCents,
      totalCents: numbers * ONBOARDING_PRICES.e911MonthlyCents,
      note: "Required on every phone number so 911 knows where you are.",
    });
  }
  if (tollFree) {
    lines.push({
      key: "tollfree_number",
      label: "Toll-free number",
      quantity: 1,
      unitCents: ONBOARDING_PRICES.tollFreeNumberMonthlyCents,
      totalCents: ONBOARDING_PRICES.tollFreeNumberMonthlyCents,
      note: "Your toll-free (8xx) number.",
    });
  }
  if (extraNumbers > 0) {
    lines.push({
      key: "additional_numbers",
      label: extraNumbers === 1 ? "Extra phone number" : "Extra phone numbers",
      quantity: extraNumbers,
      unitCents: ONBOARDING_PRICES.additionalNumberMonthlyCents,
      totalCents: extraNumbers * ONBOARDING_PRICES.additionalNumberMonthlyCents,
      note: "Your first number is included.",
    });
  }
  if (input.smsEnabled) {
    lines.push({
      key: "sms",
      label: "Text messaging",
      quantity: 1,
      unitCents: ONBOARDING_PRICES.smsMonthlyCents,
      totalCents: ONBOARDING_PRICES.smsMonthlyCents,
      note: "Send and receive texts on your business number.",
    });
  }
  // Flat, per-account, always on any real quote: it is what makes the promised
  // "one line = $35" arithmetic land ($30 + $3 E911 + $2 fees).
  if (lines.length > 0) {
    lines.push({
      key: "telecom_fees",
      label: "Telecom & regulatory fees",
      quantity: 1,
      unitCents: ONBOARDING_PRICES.telecomFeesMonthlyCents,
      totalCents: ONBOARDING_PRICES.telecomFeesMonthlyCents,
      note: "Covers taxes and carrier fees.",
    });
  }

  return { lines, monthlyTotalCents: lines.reduce((sum, l) => sum + l.totalCents, 0) };
}

/** One-line summary for a confirmation screen or an email. */
export function describeQuote(quote: OnboardingQuote): string {
  if (quote.lines.length === 0) return "Nothing to pay yet.";
  return `${formatCents(quote.monthlyTotalCents)} a month, including tax.`;
}
