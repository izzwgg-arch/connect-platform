/**
 * Pay-by-phone amount handling — star-as-decimal DTMF entry and the prompt
 * splicing that reads an amount back in the IVR's own recorded voice.
 *
 * ⛔ THE STAR IS THE DECIMAL POINT (Izzy, 2026-08-25): "25 star 37" = $25.37.
 *   That rule is what the recorded prompt 05_amount_prompt teaches callers, so
 *   this parser and that recording must never drift apart.
 * ⛔ Amounts are read back by SPLICING the recorded number set (num_0..num_20,
 *   num_30..num_90, num_hundred, num_thousand, 16_dollars, 17_cents, 18_and) —
 *   never by any TTS at call time, so the voice never switches mid-sentence.
 *   Both shipped voice sets (Stephen + Kristen) carry the identical file names.
 *
 * Pure module — no imports, fully drivable by the stress suite.
 */

export const PAY_MIN_CENTS = 1; // their api's floor ($0.01)
export const PAY_MAX_CENTS = 9999999; // their api's ceiling ($99,999.99)

export type AmountParse =
  | { ok: true; cents: number }
  | { ok: false; reason: "empty" | "bad_chars" | "multi_star" | "too_many_decimals" | "too_large" | "zero" };

/**
 * Parse a DTMF amount string. Digits are dollars; an optional single `*`
 * starts the cents; at most two digits may follow it ("25*3" = $25.30 —
 * decimal digits read left to right, exactly like a written decimal).
 * "*50" = $0.50 (no dollars keyed). "#" or anything else is refused.
 */
export function parseStarDecimalAmount(raw: string): AmountParse {
  const input = String(raw ?? "").trim();
  if (input.length === 0) return { ok: false, reason: "empty" };
  if (!/^[0-9*]+$/.test(input)) return { ok: false, reason: "bad_chars" };
  const starCount = (input.match(/\*/g) ?? []).length;
  if (starCount > 1) return { ok: false, reason: "multi_star" };

  let dollarsPart = input;
  let centsPart = "";
  if (starCount === 1) {
    const idx = input.indexOf("*");
    dollarsPart = input.slice(0, idx);
    centsPart = input.slice(idx + 1);
  }
  if (centsPart.length > 2) return { ok: false, reason: "too_many_decimals" };
  // Guard absurd keying before Number() can lose precision.
  if (dollarsPart.replace(/^0+/, "").length > 5) return { ok: false, reason: "too_large" };

  const dollars = dollarsPart.length ? Number(dollarsPart) : 0;
  const cents = centsPart.length ? Number(centsPart.padEnd(2, "0")) : 0;
  const total = dollars * 100 + cents;
  if (total > PAY_MAX_CENTS) return { ok: false, reason: "too_large" };
  if (total < PAY_MIN_CENTS) return { ok: false, reason: "zero" };
  return { ok: true, cents: total };
}

/** Prompt refs for 0–999,999 using the recorded number set. */
export function numberToPromptRefs(n: number): string[] {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) throw new Error(`number out of prompt range: ${n}`);
  if (n === 0) return ["num_0"];
  const out: string[] = [];
  const push = (v: number) => {
    // v is 1..999
    const hundreds = Math.floor(v / 100);
    const rest = v % 100;
    if (hundreds > 0) out.push(`num_${hundreds}`, "num_hundred");
    if (rest > 0) {
      if (rest <= 20) out.push(`num_${rest}`);
      else {
        const tens = Math.floor(rest / 10) * 10;
        const ones = rest % 10;
        out.push(`num_${tens}`);
        if (ones > 0) out.push(`num_${ones}`);
      }
    }
  };
  const thousands = Math.floor(n / 1000);
  const under = n % 1000;
  if (thousands > 0) {
    push(thousands);
    out.push("num_thousand");
  }
  if (under > 0) push(under);
  return out;
}

/**
 * "$25.37" → [num_20, num_5, 16_dollars, 18_and, num_30, num_7, 17_cents].
 * Whole dollars skip the cents clause; cents-only skips the dollars clause.
 */
export function amountToPromptRefs(cents: number): string[] {
  if (!Number.isInteger(cents) || cents < 0 || cents > PAY_MAX_CENTS) {
    throw new Error(`amount out of range: ${cents}`);
  }
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  const refs: string[] = [];
  if (dollars > 0) {
    refs.push(...numberToPromptRefs(dollars), "16_dollars");
    if (rem > 0) refs.push("18_and", ...numberToPromptRefs(rem), "17_cents");
  } else {
    refs.push(...numberToPromptRefs(rem), "17_cents");
  }
  return refs;
}

/** Display form used in audit rows and rep-facing screens: "$25.37". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
