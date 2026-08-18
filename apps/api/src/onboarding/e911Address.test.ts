import test from "node:test";
import assert from "node:assert/strict";

import {
  E911_ADDRESS_TYPES,
  buildE911Address,
  normalizeAddressType,
  parseServiceAddressLine,
  splitStreetLine,
} from "./e911Address";

// ── The unit designator ───────────────────────────────────────────────────────

test("normalizeAddressType maps what people actually type onto VoIP.ms's list", () => {
  assert.equal(normalizeAddressType("Ste"), "Suite");
  assert.equal(normalizeAddressType("ste."), "Suite");
  assert.equal(normalizeAddressType("APT"), "Apartment");
  assert.equal(normalizeAddressType("#"), "Unit");
  assert.equal(normalizeAddressType("fl"), "Floor");
  assert.equal(normalizeAddressType("Bldg"), "Building");
  assert.equal(normalizeAddressType("PH"), "Penthouse");
});

test("an unknown designator is dropped, never guessed", () => {
  // A wrong designator is not worth failing a 911 registration over — the
  // street line still carries it into other_info.
  assert.equal(normalizeAddressType("Pod"), "");
  assert.equal(normalizeAddressType(""), "");
  assert.equal(normalizeAddressType(null), "");
});

test("every alias resolves to a value VoIP.ms actually publishes", () => {
  for (const raw of ["ste", "apt", "#", "fl", "rm", "bldg", "ofc", "spc", "trlr", "uppr", "lowr", "bsmt"]) {
    const mapped = normalizeAddressType(raw);
    assert.ok(
      (E911_ADDRESS_TYPES as readonly string[]).includes(mapped),
      `${raw} → ${mapped} is not one of the 24 types VoIP.ms accepts`,
    );
  }
});

// ── Splitting the street line ─────────────────────────────────────────────────

test("street number is split out — the API refuses it glued to the name", () => {
  // Proven live 2026-08-17: "30 ROBERT PITT DR" as street_name answers
  // missing_street_number. This split is the whole reason the wizard stopped
  // collecting one address line.
  assert.deepEqual(splitStreetLine("30 Robert Pitt Dr"), {
    streetNumber: "30", streetName: "Robert Pitt Dr", addressType: "", addressNumber: "",
  });
});

test("a trailing unit is pulled off, comma or not", () => {
  assert.deepEqual(splitStreetLine("30 Robert Pitt Dr Suite 200"), {
    streetNumber: "30", streetName: "Robert Pitt Dr", addressType: "Suite", addressNumber: "200",
  });
  assert.deepEqual(splitStreetLine("123 Main St, Apt 4B"), {
    streetNumber: "123", streetName: "Main St", addressType: "Apartment", addressNumber: "4B",
  });
  assert.deepEqual(splitStreetLine("45 Elm Street #2"), {
    streetNumber: "45", streetName: "Elm Street", addressType: "Unit", addressNumber: "2",
  });
});

test("a street type is NOT mistaken for a unit designator", () => {
  // The regression that would quietly truncate every address: "Main Street"
  // ends in a word, but "Street" is not a unit.
  assert.deepEqual(splitStreetLine("1 Main Street"), {
    streetNumber: "1", streetName: "Main Street", addressType: "", addressNumber: "",
  });
  assert.deepEqual(splitStreetLine("9 College Road"), {
    streetNumber: "9", streetName: "College Road", addressType: "", addressNumber: "",
  });
});

test("house numbers with a letter or a dash survive", () => {
  assert.equal(splitStreetLine("30A Main St").streetNumber, "30A");
  assert.equal(splitStreetLine("30-12 Queens Blvd").streetNumber, "30-12");
});

test("a street line with no number leaves streetNumber empty rather than inventing one", () => {
  const r = splitStreetLine("Main Street");
  assert.equal(r.streetNumber, "");
  assert.equal(r.streetName, "Main Street");
});

// ── The legacy one-line address ───────────────────────────────────────────────

test("parseServiceAddressLine: the legacy one-line shapes we actually stored", () => {
  assert.deepEqual(parseServiceAddressLine("1 Main St, Monsey, NY 10952"), { address1: "1 Main St", city: "Monsey", state: "NY", zip: "10952" });
  assert.deepEqual(parseServiceAddressLine("123 Main St Apt 2, Spring Valley NY 10977-1234"), { address1: "123 Main St Apt 2", city: "Spring Valley", state: "NY", zip: "10977" });
  assert.deepEqual(parseServiceAddressLine("1 Main Street"), { address1: "1 Main Street", city: "", state: "", zip: "" });
  assert.deepEqual(parseServiceAddressLine(""), { address1: "", city: "", state: "", zip: "" });
});

// ── Building the registration ─────────────────────────────────────────────────

const SUBMISSION = {
  companyName: "Acme Bakery",
  mainEmail: "owner@acme.test",
  answers: {
    contact: { address: "30 Robert Pitt Dr Suite 200", addressCity: "Monsey", addressState: "ny", addressZip: "10952" },
  },
};

test("a structured sign-up builds a complete registration", () => {
  const built = buildE911Address(SUBMISSION);
  assert.equal(built.ok, true);
  assert.deepEqual(built.address, {
    // 911 dispatch needs to know what is at the address — that is the company.
    fullName: "Acme Bakery",
    streetNumber: "30",
    streetName: "Robert Pitt Dr",
    addressType: "Suite",
    addressNumber: "200",
    city: "Monsey",
    state: "NY", // upper-cased for the provider
    zip: "10952",
    country: "US",
    email: "owner@acme.test",
    otherInfo: "",
  });
});

test("a draft saved before the structured fields existed still registers", () => {
  // The whole point of keeping the legacy parser: an old draft finishing today
  // must not end up with no 911 address at all.
  const built = buildE911Address({
    companyName: "Old Draft Co",
    mainEmail: "old@draft.test",
    answers: { contact: { address: "12 Maple Ave, Spring Valley, NY 10977" } },
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.address.streetNumber, "12");
  assert.equal(built.address.streetName, "Maple Ave");
  assert.equal(built.address.city, "Spring Valley");
  assert.equal(built.address.state, "NY");
  assert.equal(built.address.zip, "10977");
});

test("structured fields the customer typed are never overwritten by the parser", () => {
  // Half-filled draft: city was typed, ZIP was not. Recover the ZIP from the
  // line but keep the typed city.
  const built = buildE911Address({
    companyName: "Half Co",
    mainEmail: "half@co.test",
    answers: { contact: { address: "12 Maple Ave, Wrongtown, NY 10977", addressCity: "Spring Valley" } },
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.address.city, "Spring Valley");
  assert.equal(built.address.zip, "10977");
});

test("an incomplete address is reported as incomplete, never half-registered", () => {
  const built = buildE911Address({
    companyName: "No Address Co",
    mainEmail: "x@y.test",
    answers: { contact: { address: "" } },
  });
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.ok(built.missing.includes("streetNumber"));
  assert.ok(built.missing.includes("city"));
  assert.ok(built.missing.includes("zip"));
  assert.ok(built.missing.includes("state"));
});

test("a missing company name or email is caught — VoIP.ms refuses both", () => {
  // Proven live: omitting full_name answers missing_fullname, omitting email
  // answers missing_email. Catching it here turns a provider rejection into a
  // plain-English line on the sign-up timeline.
  const noName = buildE911Address({ ...SUBMISSION, companyName: "" });
  assert.equal(noName.ok, false);
  if (!noName.ok) assert.ok(noName.missing.includes("fullName"));

  const noEmail = buildE911Address({ ...SUBMISSION, companyName: "Acme", mainEmail: "", billingEmail: "" });
  assert.equal(noEmail.ok, false);
  if (!noEmail.ok) assert.ok(noEmail.missing.includes("email"));
});

test("billing email stands in when there is no main email", () => {
  const built = buildE911Address({ ...SUBMISSION, mainEmail: "", billingEmail: "bills@acme.test" });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.address.email, "bills@acme.test");
});
