/**
 * The customer's service address, turned into the shape VoIP.ms E911 wants.
 *
 * Pure functions only — no network, no database. Everything that talks to
 * VoIP.ms lives in voipMsE911.ts, so the fiddly parsing below can be tested
 * against real customer addresses without touching the provider.
 *
 * ⛔ THE PARAMETER NAMES IN VOIP.MS'S OWN WSDL ARE WRONG FOR THE REST API.
 * The WSDL (complexType e911ProvisionInput) says `zip`; the REST endpoint
 * answers `missing_zip` for `zip` and only accepts **`zip_code`**. It also
 * requires **`email`**, which the WSDL does not list at all. Both were found
 * by probing the live API on 2026-08-17 — the same trap that made every
 * addLNPPort filing fail. Do not "correct" these names from the WSDL.
 *
 * Proven live 2026-08-17 against voip.ms/api/v1/rest.php:
 *   required  → did, full_name, street_number, street_name, city, state,
 *               country, zip_code, email, language   (each omitted one
 *               answers `missing_<field>`)
 *   optional  → address_type, address_number, other_info
 *   lenient   → an alphanumeric unit ("4B") is fine, a unit type with no
 *               number is fine, "30A" is a fine street number, ZIP+4 is fine,
 *               and matching is case-insensitive.
 */

/**
 * The 24 unit designators VoIP.ms accepts, read from its own
 * `e911AddressTypes` method on 2026-08-17. Anything outside this list is
 * dropped rather than guessed — a wrong designator is not worth failing a
 * 911 registration over, and the street line still carries the unit in
 * `other_info`.
 */
export const E911_ADDRESS_TYPES = [
  "Apartment", "Basement", "Building", "Department", "Floor", "Front",
  "Hanger", "Key", "Lobby", "Lot", "Lower", "Office", "Penthouse", "Pier",
  "Rear", "Room", "Side", "Slip", "Space", "Stop", "Suite", "Trailer",
  "Unit", "Upper",
] as const;

export type E911AddressType = (typeof E911_ADDRESS_TYPES)[number];

/** How people actually write those designators on a form. */
const ADDRESS_TYPE_ALIASES: Record<string, E911AddressType> = {
  "#": "Unit",
  apt: "Apartment",
  apto: "Apartment",
  appt: "Apartment",
  apartment: "Apartment",
  bsmt: "Basement",
  basement: "Basement",
  bldg: "Building",
  building: "Building",
  dept: "Department",
  department: "Department",
  fl: "Floor",
  flr: "Floor",
  floor: "Floor",
  front: "Front",
  frnt: "Front",
  hangar: "Hanger",
  hanger: "Hanger",
  key: "Key",
  lbby: "Lobby",
  lobby: "Lobby",
  lot: "Lot",
  lower: "Lower",
  lowr: "Lower",
  office: "Office",
  ofc: "Office",
  ph: "Penthouse",
  penthouse: "Penthouse",
  pier: "Pier",
  rear: "Rear",
  rm: "Room",
  room: "Room",
  side: "Side",
  slip: "Slip",
  space: "Space",
  spc: "Space",
  stop: "Stop",
  ste: "Suite",
  suite: "Suite",
  trlr: "Trailer",
  trailer: "Trailer",
  unit: "Unit",
  uppr: "Upper",
  upper: "Upper",
};

/** The address as VoIP.ms E911 wants it, one field per API parameter. */
export type E911Address = {
  fullName: string;
  streetNumber: string;
  streetName: string;
  addressType: string;
  addressNumber: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  email: string;
  otherInfo: string;
};

/** Fields VoIP.ms refuses the request without (proven live, see the header). */
export const E911_REQUIRED_FIELDS = [
  "fullName", "streetNumber", "streetName", "city", "state", "zip", "country", "email",
] as const;

export type E911AddressBuild =
  | { ok: true; address: E911Address }
  | { ok: false; address: E911Address; missing: string[] };

/** "Ste" / "#" / "apt." → the value VoIP.ms publishes, or "" when unknown. */
export function normalizeAddressType(raw: unknown): string {
  const key = String(raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!key) return "";
  return ADDRESS_TYPE_ALIASES[key] || "";
}

export type SplitStreet = {
  streetNumber: string;
  streetName: string;
  addressType: string;
  addressNumber: string;
};

/**
 * Split one street line into the pieces the API insists on.
 *
 * ⛔ `street_number` MUST be its own parameter — sending "30 ROBERT PITT DR"
 * as the street name answers `missing_street_number` (proven live). This is
 * the whole reason the wizard cannot keep collecting a single address line.
 *
 *   "30 Robert Pitt Dr Suite 200" → 30 | Robert Pitt Dr | Suite | 200
 *   "123 Main St, Apt 4B"         → 123 | Main St | Apartment | 4B
 *   "45B Elm Street #2"           → 45B | Elm Street | Unit | 2
 */
export function splitStreetLine(line: unknown): SplitStreet {
  let rest = String(line ?? "").replace(/\s+/g, " ").trim();
  let streetNumber = "";

  // Leading house number, optionally with a letter ("30A") or a dash ("30-12").
  const lead = rest.match(/^(\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?)\s+(.+)$/);
  if (lead) {
    streetNumber = lead[1];
    rest = lead[2];
  }

  // Trailing unit designator, with or without a comma before it.
  let addressType = "";
  let addressNumber = "";
  const unit = rest.match(
    /[,\s]+(#|[A-Za-z]{2,10}\.?)\s*([A-Za-z0-9][A-Za-z0-9-]*)?$/,
  );
  if (unit) {
    const mappedType = normalizeAddressType(unit[1]);
    // Only treat it as a unit when the word really is a designator —
    // otherwise "Main Street" would lose "Street".
    if (mappedType) {
      addressType = mappedType;
      addressNumber = String(unit[2] || "").trim();
      rest = rest.slice(0, unit.index).replace(/[\s,]+$/, "");
    }
  }
  // "…, #4B" with the designator glued to the number.
  if (!addressType) {
    const hashed = rest.match(/[,\s]+#\s*([A-Za-z0-9][A-Za-z0-9-]*)$/);
    if (hashed) {
      addressType = "Unit";
      addressNumber = hashed[1];
      rest = rest.slice(0, hashed.index).replace(/[\s,]+$/, "");
    }
  }

  return { streetNumber, streetName: rest.replace(/[\s,]+$/, "").trim(), addressType, addressNumber };
}

/**
 * Legacy fallback: before the wizard collected city/state/ZIP separately, the
 * whole service address arrived as one free-text line ("123 Main St, Monsey,
 * NY 10952"). Pull the ZIP and 2-letter state off the end and take the last
 * comma part as the city.
 *
 * Lives here (rather than in voipMsProvisioning, where it started) so the
 * porting filing and the 911 registration can never drift apart on how they
 * read the same stored line. voipMsProvisioning re-exports it.
 */
export type ParsedAddressLine = { address1: string; city: string; state: string; zip: string };

export function parseServiceAddressLine(line: unknown): ParsedAddressLine {
  let rest = String(line ?? "").replace(/\s+/g, " ").trim();
  const zipMatch = rest.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  const zip = zipMatch ? zipMatch[1] : "";
  if (zipMatch) rest = rest.slice(0, zipMatch.index).replace(/[\s,]+$/, "");
  const stateMatch = rest.match(/[,\s]([A-Za-z]{2})\.?\s*$/);
  const state = stateMatch ? stateMatch[1].toUpperCase() : "";
  if (stateMatch) rest = rest.slice(0, stateMatch.index).replace(/[\s,]+$/, "");
  const parts = rest.split(",").map((p) => p.trim()).filter(Boolean);
  const city = parts.length > 1 ? parts.pop()! : "";
  return { address1: parts.join(", "), city, state, zip };
}

/**
 * Build the 911 registration address for a sign-up from what the customer
 * actually typed.
 *
 * The wizard's contact step is the source: `answers.contact.address` is the
 * STREET line and `addressCity` / `addressState` / `addressZip` sit beside it.
 * Drafts saved before those fields existed hold the whole address in
 * `address`, so a missing city or ZIP falls back to parsing that one line —
 * which is why an old draft finishing today still registers 911 correctly.
 *
 * `full_name` is the business, not the contact: 911 dispatch needs to know
 * what is at the address, and that is the company.
 */
export function buildE911Address(row: any): E911AddressBuild {
  const answers: any = row?.answers || {};
  const contact: any = answers.contact || {};
  const submit: any = answers.submit || {};

  const rawStreet = String(contact.address ?? submit.address ?? "").trim();
  let city = String(contact.addressCity ?? submit.addressCity ?? "").trim();
  let state = String(contact.addressState ?? submit.addressState ?? "").trim().toUpperCase();
  let zip = String(contact.addressZip ?? submit.addressZip ?? "").replace(/[^\d-]/g, "").slice(0, 10);

  let streetLine = rawStreet;
  if (!city || !zip || !state) {
    // Legacy single-line draft — recover whatever the structured fields lack,
    // and keep the structured values that ARE set (they were typed on purpose).
    const parsed = parseServiceAddressLine(rawStreet);
    if (parsed.city || parsed.zip || parsed.state) {
      streetLine = parsed.address1 || rawStreet;
      city = city || parsed.city;
      state = state || parsed.state;
      zip = zip || parsed.zip;
    }
  }

  const split = splitStreetLine(streetLine);

  const address: E911Address = {
    fullName: String(row?.companyName || "").trim(),
    streetNumber: split.streetNumber,
    streetName: split.streetName,
    addressType: split.addressType,
    addressNumber: split.addressNumber,
    city,
    state,
    zip,
    country: "US",
    email: String(row?.mainEmail || row?.billingEmail || "").trim(),
    // Anything we could not fit into a field still reaches the dispatcher's
    // notes rather than being dropped.
    otherInfo: split.streetNumber ? "" : streetLine.slice(0, 100),
  };

  const missing = E911_REQUIRED_FIELDS.filter((f) => !String((address as any)[f] || "").trim());
  return missing.length ? { ok: false, address, missing: [...missing] } : { ok: true, address };
}
