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
