// ── What a submission owes: input derivation ────────────────────────────────
//
// Pure and db-free so it can be unit tested and so the /quote route can price
// a sign-up BEFORE submit locks it: requestedExtensions rows only exist after
// submit — before that, the autosaved answers are the truth. The same goes for
// the smsEnabled column, which is stamped at submit and stays false until then.

export type QuoteInput = {
  extensions: number;
  phoneNumbers: number;
  smsEnabled: boolean;
  tollFreeNumber: boolean;
  /** Admin-set on the link (answers.pricing) — see readOnboardingPricing. */
  coldCallingExtensions: number;
  crmExtensions: number;
};

/**
 * What an ADMIN set on the link before sending it (Izzy, 2026-09-16): a
 * cold-calling company pays $65 per cold-calling extension, and CRM is $20 per
 * extension. `"all"` follows however many extensions the customer sets up; a
 * number is "this many of them". Lives in answers.pricing, which the autosave
 * can never write (serverOwnedAnswers.ts).
 */
export type OnboardingPricingCount = "all" | number;
export type OnboardingPricing = { coldCalling?: { extensions: OnboardingPricingCount }; crm?: { extensions: OnboardingPricingCount } };

function readCount(v: any): OnboardingPricingCount | null {
  const raw = v?.extensions;
  if (raw === "all") return "all";
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function readOnboardingPricing(answers: any): OnboardingPricing {
  const p = answers?.pricing;
  const out: OnboardingPricing = {};
  const cc = readCount(p?.coldCalling);
  if (cc != null) out.coldCalling = { extensions: cc };
  const crm = readCount(p?.crm);
  if (crm != null) out.crm = { extensions: crm };
  return out;
}

/** Resolve a count against the extensions actually set up. */
export function resolvePricingCount(count: OnboardingPricingCount | undefined, extensions: number): number {
  if (count == null) return 0;
  return count === "all" ? extensions : Math.min(extensions, count);
}

/** "tollfree" and "vanity" picks both price as the $15/month toll-free number. */
export function isTollFreeNumberKind(kind: unknown): boolean {
  const k = String(kind ?? "").toLowerCase();
  return k === "tollfree" || k === "vanity";
}

export function quoteInputForSubmission(sub: {
  requestedExtensions?: Array<unknown> | null;
  smsEnabled?: boolean | null;
  answers?: any;
}): QuoteInput {
  const submitted = Array.isArray(sub?.requestedExtensions) ? sub.requestedExtensions.length : 0;

  // Pre-submit fallback: count autosaved rows the same way submit will keep
  // them — a row needs both a name and a number to become an extension.
  const drafted = Array.isArray(sub?.answers?.extensions)
    ? sub.answers.extensions.filter(
        (e: any) => String(e?.displayName ?? "").trim() && String(e?.extNumber ?? "").trim(),
      ).length
    : 0;
  const extensions = submitted > 0 ? submitted : drafted;

  // One number today. Extra numbers are an explicit choice; when the wizard
  // grows that option it sets answers.phone.extraNumbers and this picks it up
  // without the pricing needing to change.
  const extra = Number(sub?.answers?.phone?.extraNumbers ?? 0);
  const phoneNumbers = 1 + (Number.isFinite(extra) && extra > 0 ? Math.floor(extra) : 0);

  const smsEnabled =
    submitted > 0
      ? !!sub?.smsEnabled
      : sub?.answers?.addons?.smsEnabled != null
        ? !!sub.answers.addons.smsEnabled
        : !!sub?.smsEnabled;

  // The $15 toll-free line only applies to a NEW toll-free/vanity pick — a
  // stale numberKind left behind after switching to "bring my number" must
  // never surcharge a port.
  const choice = String(sub?.answers?.phone?.choice ?? "");
  const tollFreeNumber = choice !== "port" && isTollFreeNumberKind(sub?.answers?.phone?.numberKind);

  const pricing = readOnboardingPricing(sub?.answers);
  const coldCallingExtensions = resolvePricingCount(pricing.coldCalling?.extensions, extensions);
  const crmExtensions = resolvePricingCount(pricing.crm?.extensions, extensions);

  return { extensions, phoneNumbers, smsEnabled, tollFreeNumber, coldCallingExtensions, crmExtensions };
}

/**
 * Admin form input → the stored answers.pricing shape. `enabled:false` or a
 * missing block means "not on this link". `extensions` null/"all" = every
 * extension; a positive number = that many. Returns undefined when neither
 * add-on is on, so a plain link stores nothing.
 */
export function buildOnboardingPricing(input: {
  coldCalling?: { enabled?: boolean; extensions?: number | "all" | null } | null;
  crm?: { enabled?: boolean; extensions?: number | "all" | null } | null;
}): OnboardingPricing | undefined {
  const one = (b: any): { extensions: OnboardingPricingCount } | undefined => {
    if (!b?.enabled) return undefined;
    const n = Math.floor(Number(b.extensions));
    return { extensions: b.extensions == null || b.extensions === "all" || !(n > 0) ? "all" : n };
  };
  const out: OnboardingPricing = {};
  const cc = one(input.coldCalling);
  const crm = one(input.crm);
  if (cc) out.coldCalling = cc;
  if (crm) out.crm = crm;
  return cc || crm ? out : undefined;
}
