/**
 * Toll-free vs local DID classification for billing.
 *
 * Audit (2026-05): `PhoneNumber` has no `numberType` / `isTollFree` column.
 * Purchase flow uses provider `type: "local" | "tollfree"` but does not persist type on the row.
 * `capabilities` JSON stores sms/mms/voice only — not toll-free kind.
 *
 * Billing therefore classifies active DIDs by NANP toll-free NPA (E.164 +1XXXXXXXXXX).
 */

/** US/Canada toll-free area codes (NPA). */
export const NANP_TOLL_FREE_NPAS = new Set(["800", "833", "844", "855", "866", "877", "888"]);

export function digitsOnlyPhone(value: string): string {
  return String(value || "").replace(/\D/g, "");
}

/** True when `phoneNumber` is a US/Canada toll-free DID (+1 + toll-free NPA). */
export function isTollFreePhoneNumber(phoneNumber: string): boolean {
  const d = digitsOnlyPhone(phoneNumber);
  if (d.length === 11 && d.startsWith("1")) {
    return NANP_TOLL_FREE_NPAS.has(d.slice(1, 4));
  }
  if (d.length === 10) {
    return NANP_TOLL_FREE_NPAS.has(d.slice(0, 3));
  }
  return false;
}

export type PhoneNumberBillingRow = { id: string; phoneNumber: string };

export function splitPhoneNumbersByKind(rows: PhoneNumberBillingRow[]): {
  local: PhoneNumberBillingRow[];
  tollFree: PhoneNumberBillingRow[];
} {
  const local: PhoneNumberBillingRow[] = [];
  const tollFree: PhoneNumberBillingRow[] = [];
  for (const row of rows) {
    if (isTollFreePhoneNumber(row.phoneNumber)) tollFree.push(row);
    else local.push(row);
  }
  return { local, tollFree };
}
