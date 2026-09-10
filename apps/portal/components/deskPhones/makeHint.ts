/**
 * What the customer told us about the make of their phones, and what we may do with it.
 *
 * ⛔⛔ THE ONE RULE IN THIS FILE: the make ORDERS the found list and NEVER filters it.
 * A person reading "Grandstream" off a sticker when the thing on their desk is a Yealink
 * is an ordinary mistake — labels are small, offices have mixed estates, and the make is
 * printed in six different places on some handsets. If we filtered, that mistake would
 * show them an EMPTY found screen while their phone was sitting right there in the scan
 * results, and the only conclusion available to them is that the wizard does not work.
 * Ordering costs nothing when they are right and costs nothing when they are wrong.
 *
 * ⛔ Kept out of the component on purpose. Logic that lives inside JSX cannot be driven
 * by a test, so the safety property above would be assertable only by reading source —
 * and "the list never gets shorter" is exactly the kind of claim that deserves to be
 * exercised rather than grepped.
 */
import { VENDOR_CATALOG, type VendorSlug } from "@connect/shared";

/** The sentinel the make dropdown uses for "I am not sure". Not a brand slug. */
export const MAKE_UNSURE = "unsure";

/** Only the fields the ordering actually reads, so a caller can pass its own row type. */
type HasVendor = { vendor?: string | null };

/**
 * The make as a phrase to show a person, or "" when they did not say.
 *
 * ⛔ Resolved through the catalogue rather than echoed back raw: the dropdown's value is
 * a slug (`flyingvoice`), and showing someone the slug they never typed reads as a bug.
 */
export function makeLabel(brand: string | null | undefined): string {
  const b = String(brand ?? "").trim();
  if (!b || b === MAKE_UNSURE) return "";
  return VENDOR_CATALOG[b as VendorSlug]?.displayName ?? "";
}

/** The make and model together, as one phrase to echo back. Empty when nothing was said. */
export function toldUsPhrase(brand: string | null | undefined, model: string | null | undefined): string {
  return [makeLabel(brand), String(model ?? "").trim()].filter(Boolean).join(" ");
}

/**
 * The found list with the chosen make first, and EVERY phone still present.
 *
 * Stable within each group: two phones of the chosen make keep the order discovery
 * found them in, so the list does not reshuffle between renders.
 */
export function orderPhonesByMake<T extends HasVendor>(phones: readonly T[], brand: string | null | undefined): T[] {
  const want = String(brand ?? "").trim().toLowerCase();
  if (!want || want === MAKE_UNSURE) return [...phones];

  const matches: T[] = [];
  const rest: T[] = [];
  for (const p of phones) {
    // ⛔ Both halves are pushed. There is deliberately no branch that drops a phone.
    (String(p.vendor ?? "").toLowerCase() === want ? matches : rest).push(p);
  }
  return [...matches, ...rest];
}
