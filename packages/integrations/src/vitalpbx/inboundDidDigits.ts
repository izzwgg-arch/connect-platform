/** Digits-only normalization for inbound DID keys (CDR + Ombutel + cache). */

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/** 10-digit US-style key: strips leading 1 from 11-digit NANP. */
export function normalizeInboundDidDigits(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = digitsOnly(raw);
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length < 3) return null;
  return d;
}
