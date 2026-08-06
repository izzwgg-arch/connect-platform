/**
 * What an ElevenLabs key looks like, and what their refusals actually mean.
 *
 * Why this is shared rather than living next to one caller
 * ───────────────────────────────────────────────────────
 * Two processes ask the same question and have to give the same answer: the
 * API (the IVR Studio's "Make a recording" modal) and the agent (the owner's
 * ElevenLabs settings page). They didn't. On 2026-08-05 the settings page said
 * "Saved, but ElevenLabs couldn't be reached just now" — which reads as *our*
 * server being broken — while the Studio said "the key was rejected", which
 * reads as the owner having mistyped it. Neither said the one thing that was
 * true, and a whole day went into re-pasting a key that could never work.
 *
 * The trap this exists for
 * ───────────────────────
 * ElevenLabs retired their old key format (64 hex characters, no prefix) and
 * now refuse it server-side. Such a key works for months and then simply
 * stops, with no change on our side and no warning — so "it's definitely a
 * good, working key" is an entirely reasonable thing for its owner to believe.
 *
 * Their reply says exactly what's wrong: HTTP **400** (not 401) with
 * `detail.status = "invalid_api_key_prefix"` and "API key must start with
 * 'sk_'." We repeat that in plain English instead of flattening it into a
 * generic "rejected", and we never treat a 4xx as "couldn't reach them".
 */

/** Every key ElevenLabs issues today starts with this. */
export const ELEVENLABS_KEY_PREFIX = "sk_";

/**
 * The message for a retired-format key. Deliberately says the key cannot be
 * repaired: the failure looks identical to a typo, so anyone told merely to
 * "check the key" will re-paste the same dead key and report the same bug.
 */
export const ELEVENLABS_LEGACY_KEY_MESSAGE =
  'ElevenLabs no longer accepts this key. It is one of their old-style keys, and they now only accept keys that start with "sk_" — so re-pasting this one will not help, and nothing is wrong on Connect\'s side. Sign in at elevenlabs.io, go to Profile → API Keys, create a new key, and paste that one in.';

/** Said before we ask ElevenLabs anything, when the shape is already wrong. */
export const ELEVENLABS_LEGACY_KEY_WARNING =
  'That does not look like a current ElevenLabs key — theirs start with "sk_". Old-style keys are no longer accepted and will not work.';

export interface ElevenLabsKeyShape {
  /** Matches the format ElevenLabs issues today. */
  looksCurrent: boolean;
  /** The retired format: a long run of hex with no prefix. */
  looksLegacy: boolean;
  /** Last four characters — enough to tell two keys apart, never enough to use one. */
  last4: string;
  length: number;
}

/**
 * Describe a key without revealing it. `last4` is the same masked hint the
 * secret store already shows, and it earns its place: it is the only way for
 * someone to check that what they pasted is what actually got saved.
 */
export function describeElevenLabsKey(key: string | null | undefined): ElevenLabsKeyShape | null {
  const k = String(key ?? "").trim();
  if (!k) return null;
  return {
    looksCurrent: k.startsWith(ELEVENLABS_KEY_PREFIX),
    looksLegacy: !k.startsWith(ELEVENLABS_KEY_PREFIX) && /^[0-9a-f]{32,}$/i.test(k),
    last4: k.slice(-4),
    length: k.length,
  };
}

/**
 * Turn an ElevenLabs error body into a sentence a non-technical owner can act
 * on, or null when we recognise nothing (and the caller should fall back to
 * the status code).
 *
 * Order matters. `invalid_api_key_prefix` contains `invalid_api_key`, so the
 * specific case has to be tested first or the useful message is swallowed by
 * the generic one — which is precisely the bug this function was extended to
 * fix.
 *
 * The status code alone is never enough. A perfectly valid key on an account
 * with an unpaid invoice returns **401** on synthesis while `/voices` answers
 * 200; a dead-format key returns **400**, which reads like a malformed
 * request. Both are in `detail.status`, so read that first.
 */
export function classifyElevenLabsFailure(body: string): string | null {
  let code = "";
  try {
    const j = JSON.parse(body);
    code = String(j?.detail?.status || j?.detail?.code || j?.detail?.type || "");
  } catch {
    // Some errors come back as plain text; the substring checks below still work.
  }
  const hay = `${code} ${body}`.toLowerCase();

  // Must precede the generic invalid-key branch — see the note above.
  if (/invalid_api_key_prefix|must start with 'sk_'|must start with "sk_"/.test(hay)) {
    return ELEVENLABS_LEGACY_KEY_MESSAGE;
  }
  if (/payment_issue|payment_required|past_due|failed or incomplete payment/.test(hay)) {
    return "ElevenLabs has an unpaid invoice on the account, so it won't make new recordings. The key is fine — settle the bill at elevenlabs.io and this starts working again.";
  }
  if (/quota_exceeded|character limit|out of credits/.test(hay)) {
    return "The ElevenLabs account has used all its characters for this month. It resets on the next billing date, or you can upgrade the plan.";
  }
  if (/detected_unusual_activity|abuse/.test(hay)) {
    return "ElevenLabs has flagged unusual activity on the account and paused it. You'll need to sort that out with them directly.";
  }
  if (/invalid_api_key|missing_api_key|needs_authorization/.test(hay)) {
    return "The ElevenLabs key was rejected. Check it on the ElevenLabs settings page.";
  }
  if (/voice_not_found/.test(hay)) {
    return "That voice is no longer on the ElevenLabs account. Pick another one.";
  }
  return null;
}

/**
 * Is this failure about the key itself?
 *
 * Used where the only decision is "blame the key or blame the connection".
 * ElevenLabs answers a dead-format key with 400, so a route that only treats
 * 401 as a key problem tells the owner their provider was unreachable — the
 * single most misleading thing it could say, because it points at us.
 */
export function isElevenLabsKeyFailure(status: number, body = ""): boolean {
  if (/invalid_api_key|missing_api_key|needs_authorization|authentication_error/i.test(body)) return true;
  return status === 401 || status === 403 || status === 400;
}
