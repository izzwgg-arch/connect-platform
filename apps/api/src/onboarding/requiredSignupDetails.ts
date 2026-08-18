/**
 * The details a sign-up may NEVER be submitted without.
 *
 * ⛔ WHY THIS EXISTS, and it is not a style preference. Until 2026-08-18
 * `publicSubmitSchema` marked `address`, `addressCity`, `addressState` and
 * `addressZip` every one of them `.optional()`, and `companyName` only
 * `min(1)`. The wizard checked them in the browser and the server did not —
 * so anything that reached /submit with them blank was accepted, a tenant was
 * created, a card was charged, and a 911 address was registered from whatever
 * happened to be lying in the autosaved answers blob.
 *
 * That is exactly how submission cmsyuwds40w8sqo132jep3wlb ended up carrying
 * one person's company name and another person's street address into a LIVE
 * E911 registration: two browsers shared one sign-up link, both autosaved into
 * the same `answers` record, and the fields the second person left blank kept
 * the first person's values straight through submit. A wrong 911 address sends
 * an ambulance to the wrong house — this gate is the one that must not be
 * client-side.
 *
 * ⛔ THE RULE THE GATE ENFORCES IS "CAN WE REGISTER 911 WITH THIS", not "are
 * the boxes non-empty". It deliberately asks the SAME question
 * `buildE911Address` will ask at provisioning time, so a sign-up can never pass
 * validation and then fail to register. It accepts the legacy one-line address
 * shape for the same reason: drafts saved before the split fields existed still
 * carry the whole address in `address`, and `parseServiceAddressLine` can read
 * it — refusing those would turn an old-but-finishable draft into a dead link.
 */

import { isUsStateCode, parseServiceAddressLine } from "./e911Address";

export type RequiredSignupDetailsInput = {
  companyName?: string | null;
  address?: string | null;
  addressCity?: string | null;
  addressState?: string | null;
  addressZip?: string | null;
};

/** Every field the gate can complain about, in the order the wizard shows them. */
export type RequiredSignupField =
  | "companyName"
  | "address"
  | "addressCity"
  | "addressState"
  | "addressZip";

export type RequiredSignupProblem = {
  field: RequiredSignupField;
  /** Customer-facing. Says what is missing and where to fix it. */
  message: string;
};

const s = (v: unknown): string => String(v ?? "").trim();

/**
 * The first thing wrong with the details, or null when they are usable.
 *
 * Returns ONE problem rather than a list on purpose: the wizard scrolls to a
 * single field and this is the field it should land on.
 */
export function requiredSignupDetailsProblem(
  input: RequiredSignupDetailsInput,
): RequiredSignupProblem | null {
  const company = s(input.companyName);
  if (company.length < 2) {
    return {
      field: "companyName",
      message: "A company name is required — go back to the Company step and enter it.",
    };
  }

  // The three split fields win when present; an older draft's single line is
  // parsed for whatever it can give. This mirrors buildE911Address exactly.
  const line = s(input.address);
  const parsed = parseServiceAddressLine(line);
  const street = s(input.address) ? s(parsed.address1) || line : "";
  const city = s(input.addressCity) || s(parsed.city);
  const state = s(input.addressState) || s(parsed.state);
  const zip = s(input.addressZip) || s(parsed.zip);

  const where = " This is the address emergency services are sent to when someone dials 911, so it can't be left blank.";

  if (!street) {
    return { field: "address", message: "A street address is required." + where };
  }
  // A street NUMBER is separately required by VoIP.ms — sending a street name
  // with no number answers `missing_street_number` and the registration fails
  // at provisioning time, long after the customer has paid.
  if (!/\d/.test(street)) {
    return {
      field: "address",
      message: `"${street}" doesn't include a street number — 911 registration needs one, like "13 Main St".`,
    };
  }
  if (!city) {
    return { field: "addressCity", message: "A city is required." + where };
  }
  // ⛔ A real state, not merely two letters: parseServiceAddressLine reads the
  // "Dr" in "30 Robert Pitt Dr" as a state, so a shape check alone would let a
  // street suffix through into a 911 registration.
  if (!isUsStateCode(state)) {
    return {
      field: "addressState",
      message: "A two-letter state is required, like NY." + where,
    };
  }
  if (!/^\d{5}(-\d{4})?$/.test(zip)) {
    return {
      field: "addressZip",
      message: "A five-digit ZIP code is required." + where,
    };
  }
  return null;
}
