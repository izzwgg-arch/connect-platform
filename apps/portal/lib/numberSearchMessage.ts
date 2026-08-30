/**
 * What the sign-up wizard says when a number search comes back with nothing.
 *
 * ⛔ WHY THIS EXISTS. Until 2026-08-18 an empty result rendered NOTHING AT ALL —
 * the results grid is gated on `numbers.length > 0` and no other branch covered
 * the empty case. A customer searching an area code with no stock saw a blank
 * space and no explanation, and the only feedback anywhere on the screen was
 * the Continue button's "Please pick a number from the list."
 *
 * That is not hypothetical. Submission cmsyuwds40w8sqo132jep3wlb (2026-08-18)
 * records a paying customer hammering Search for FIVE MINUTES across 415, 718,
 * 646, 917 and 347 — thirteen searches, every one "0 results", every one a blank
 * screen — before giving up and taking a 929 number they had not asked for.
 * VoIP.ms genuinely has no stock in those NPAs; nothing was broken. Nobody told
 * them.
 *
 * ⛔ THE DISTINCTION THIS FILE PROTECTS: "we found nothing" is NOT "the search
 * broke". The API keeps them apart (`error: "number_search_failed"`), and the
 * caller must keep them apart too — saying "not available" during a VoIP.ms
 * outage tells a customer a perfectly buyable number does not exist.
 */

// "areacode" is the SignalWire-first mode the upgraded wizard sends; the
// empty-state copy treats it exactly like a 3-digit starts-with search.
export type NumberSearchMode = "areacode" | "starts" | "contains" | "ends";

export type NumberSearchEmptyInput = {
  /** What the customer typed. Non-digits are ignored, exactly as the API does. */
  query: string;
  /** Where the digits should sit. Local tab only; toll-free has no picker. */
  mode?: NumberSearchMode;
  tab: "local" | "tollfree";
  /** The "spell a word" box, when that is what was searched. */
  vanity?: string;
};

/** The retry copy for a genuine failure — never used for an empty result. */
export const NUMBER_SEARCH_FAILED_MESSAGE =
  "We couldn't load available numbers just now — the number service may be briefly busy. Tap Search to try again in a few seconds.";

/**
 * A three-digit "starts with" search is the customer asking for an area code,
 * and it is worth naming as one: "Area code 718 is not available" is a fact they
 * can act on, where "no numbers starting with 718" reads like a typo.
 */
function isAreaCodeSearch(digits: string, mode: NumberSearchMode | undefined, tab: string): boolean {
  if (mode === "areacode") return tab === "local" && digits.length === 3;
  return tab === "local" && digits.length === 3 && (mode ?? "starts") === "starts";
}

export function numberSearchEmptyMessage(input: NumberSearchEmptyInput): string {
  const digits = String(input.query || "").replace(/\D/g, "");
  const word = String(input.vanity || "").trim();

  if (word) {
    return `No toll-free number spelling "${word.toUpperCase()}" is available right now. Try another word, or search by digits instead.`;
  }

  const tollFree = input.tab === "tollfree";

  if (!digits) {
    return tollFree
      ? "No toll-free numbers are available right now. Try searching for digits like 833, or pick a local number instead."
      : "No numbers are available right now. Try searching for an area code, like 845.";
  }

  if (isAreaCodeSearch(digits, input.mode, input.tab)) {
    return `Area code ${digits} is not available right now. Try a different area code.`;
  }

  const kind = tollFree ? "toll-free numbers" : "numbers";
  const where =
    input.mode === "ends" ? `ending in ${digits}`
    : input.mode === "contains" ? `containing ${digits}`
    : `starting with ${digits}`;

  return `No ${kind} ${where} are available right now. Try different digits${input.tab === "local" ? ", or another area code" : ""}.`;
}
