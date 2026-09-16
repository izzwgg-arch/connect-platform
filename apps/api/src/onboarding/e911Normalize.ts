/**
 * Rewrite a customer's typed address into the POSTAL form the emergency
 * database knows, before it is sent to the carrier for 911.
 *
 * Proven against Telnyx's own validator, 2026-09-16 (Loopcom's office):
 *   "33 NY 17M" / "33 NY-17M" / "33 Route 17M"     → 85009 "must be manually
 *                                                     validated" — NO suggestion
 *   "33 State Route 17M" + "Ste C" / "STE C"       → valid
 *   "33 State Route 17M" + "Suite C"               → 20209 invalid extended address
 *
 * Izzy: "there are two ways of doing it" — the NY State record / Facebook form
 * is "33 NY 17M" (what people type), the postal/911 form is "33 State Route 17M".
 * The same class as the Monsey → SPRING VALLEY rule
 * (e911-wants-the-municipality-not-the-postal-town).
 *
 * ⛔ Deliberately narrow: only rewrites shapes proven or unambiguous. Anything
 * else passes through untouched, and the carrier's VALIDATOR is still the gate —
 * a rewrite never registers an address on its own.
 */

/** USPS secondary-unit abbreviations (Publication 28 C2). */
const UNIT_ABBREV: Record<string, string> = {
  suite: "Ste",
  ste: "Ste",
  apartment: "Apt",
  apt: "Apt",
  floor: "Fl",
  fl: "Fl",
  building: "Bldg",
  bldg: "Bldg",
  room: "Rm",
  rm: "Rm",
  department: "Dept",
  dept: "Dept",
  unit: "Unit",
};

export function normalizeUnitType(raw: string): string {
  const k = String(raw || "").trim().replace(/\.$/, "").toLowerCase();
  return UNIT_ABBREV[k] ?? String(raw || "").trim();
}

/**
 * "NY 17M", "NY-17M", "N.Y. 17M", "NYS 17M", "Route 17M", "Rte 17M", "Rt. 17M",
 * "SR 17M", "State Rte 17M" → "State Route 17M" — only inside New York, where
 * the proof is. (Other states name their routes differently; not guessed.)
 */
export function normalizeStreetName(streetName: string, state: string): string {
  const s = String(streetName || "").trim();
  if (String(state || "").trim().toUpperCase() !== "NY") return s;
  const m = s.match(/^(?:N\.?\s?Y\.?\s?S?|NYS|Route|Rte\.?|Rt\.?|SR|State\s+(?:Route|Rte\.?|Rt\.?))[\s-]*(\d+[A-Za-z]?)$/i);
  return m ? `State Route ${m[1].toUpperCase()}` : s;
}

export function normalizeE911ForCarrier(a: {
  streetNumber: string;
  streetName: string;
  addressType?: string;
  addressNumber?: string;
  state: string;
}): { streetAddress: string; extendedAddress: string | null } {
  const street = [String(a.streetNumber || "").trim(), normalizeStreetName(a.streetName, a.state)].filter(Boolean).join(" ");
  const unitType = a.addressType ? normalizeUnitType(a.addressType) : "";
  const unitNo = String(a.addressNumber || "").trim();
  const extended = [unitType, unitNo].filter(Boolean).join(" ");
  return { streetAddress: street, extendedAddress: extended || null };
}
