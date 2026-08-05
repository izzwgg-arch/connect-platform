// ── What a submission owes: input derivation ────────────────────────────────
//
// Pure and db-free so it can be unit tested and so the /quote route can price
// a sign-up BEFORE submit locks it: requestedExtensions rows only exist after
// submit — before that, the autosaved answers are the truth. The same goes for
// the smsEnabled column, which is stamped at submit and stays false until then.

export type QuoteInput = { extensions: number; phoneNumbers: number; smsEnabled: boolean; tollFreeNumber: boolean };

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

  return { extensions, phoneNumbers, smsEnabled, tollFreeNumber };
}
