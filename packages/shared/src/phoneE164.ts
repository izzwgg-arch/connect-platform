/**
 * Shared US/Canada (+1) phone normalization for SMS, threads, and routing.
 * Strips formatting; 10-digit numbers get +1; 11-digit starting with 1 become +1XXXXXXXXXX.
 */

const NON_DIGITS = /[^\d+]/g;

/** Remove spaces, dashes, parens, dots — keep leading + and digits. */
export function stripPhoneFormatting(input: string): string {
  const s = String(input ?? "").trim();
  if (!s) return "";
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "+" && out.length === 0) {
      out += c;
      continue;
    }
    if (c >= "0" && c <= "9") out += c;
  }
  return out;
}

export type NormalizePhoneResult =
  | { ok: true; e164: string; digits: string }
  | { ok: false; error: string };

/**
 * Normalize to E.164 for NANP (default country +1).
 * Accepts: 8455551234, 18455551234, +18455551234, (845) 555-1234, etc.
 */
export function normalizeUsCanadaToE164(raw: string): NormalizePhoneResult {
  const cleaned = stripPhoneFormatting(raw);
  if (!cleaned) return { ok: false, error: "empty" };

  let digits = cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;
  digits = digits.replace(/\D/g, "");
  if (!digits) return { ok: false, error: "no_digits" };

  if (digits.length === 10) {
    return { ok: true, e164: `+1${digits}`, digits: `1${digits}` };
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    const rest = digits.slice(1);
    if (rest.length !== 10) return { ok: false, error: "invalid_length" };
    return { ok: true, e164: `+1${rest}`, digits };
  }
  if (digits.length >= 10 && digits.length <= 15 && cleaned.startsWith("+")) {
    return { ok: true, e164: `+${digits}`, digits };
  }

  return { ok: false, error: "unsupported_format" };
}

/** Alias for thread keys / DB canonical column. */
export function canonicalSmsPhone(raw: string): NormalizePhoneResult {
  return normalizeUsCanadaToE164(raw);
}

export type SmsSenderKind = "e164" | "short_code" | "alphanumeric";
export type CanonicalSmsSenderResult =
  | { ok: true; sender: string; kind: SmsSenderKind }
  | { ok: false; error: string };

/** GSM caps alphanumeric sender IDs at 11 chars; the slack is for stray punctuation. */
const MAX_SMS_SENDER_LENGTH = 16;

/**
 * Canonical form for the SENDER of an inbound message.
 *
 * ⛔ Do NOT use this for the destination — a `to` must always be one of our own
 * DIDs and must stay on the strict `canonicalSmsPhone` path.
 *
 * A sender is not always a phone number. Verification codes, banks and every
 * other 2FA service send from a numeric SHORT CODE (WhatsApp uses `29283`), and
 * international traffic can arrive from an alphanumeric sender ID. Those are
 * legitimate inbound messages, and `normalizeUsCanadaToE164` rejects all of
 * them — it only accepts 10/11-digit NANP or a `+`-prefixed 10–15 digit number.
 *
 * The VoIP.ms poller used to feed the sender through the strict normalizer and
 * `return null` on failure with no log line, so **every shortcode message the
 * platform ever received was silently discarded** — 0 of 571 SMS threads had a
 * non-E.164 sender. That is why WhatsApp verification codes reached the carrier
 * and never reached anyone's inbox. See [[sms-shortcode-senders-were-dropped]].
 */
export function canonicalSmsSender(raw: string): CanonicalSmsSenderResult {
  const trimmed = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) return { ok: false, error: "empty" };

  const asPhone = normalizeUsCanadaToE164(trimmed);
  if (asPhone.ok) return { ok: true, sender: asPhone.e164, kind: "e164" };

  const stripped = stripPhoneFormatting(trimmed);
  const digits = stripped.startsWith("+") ? stripped.slice(1) : stripped;
  // Short codes are 3–8 digits (US/Canada use 5–6; other markets reach 8). Only
  // treat it as one when the whole sender was digits/formatting — never when we
  // merely found digits inside a longer string.
  if (digits.length >= 3 && digits.length <= 8 && /^[\d\s().+-]+$/.test(trimmed)) {
    return { ok: true, sender: digits, kind: "short_code" };
  }

  // Alphanumeric sender ID. Upper-cased so the thread key is stable across
  // carrier casing changes; the original spelling is kept in `externalSmsRaw`.
  if (trimmed.length <= MAX_SMS_SENDER_LENGTH && /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(trimmed)) {
    return { ok: true, sender: trimmed.toUpperCase(), kind: "alphanumeric" };
  }

  return { ok: false, error: "unsupported_sender" };
}
