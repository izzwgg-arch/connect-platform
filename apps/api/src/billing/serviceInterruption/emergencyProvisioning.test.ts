import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  COUNTRY_US,
  EmergencyProvisionError,
  buildEmergencyLocationPairs,
  buildEmergencyNumbersPairs,
  defaultEmergencyNumbers,
  splitStreet,
} from "./emergencyProvisioning";

const get = (p: Array<[string, string]>, k: string) => p.filter(([x]) => x === k).map(([, v]) => v);

const LOC = {
  csrf: "tok",
  name: "Matamim",
  streetNumber: "15",
  streetName: "Van Buren Dr",
  city: "Monroe",
  stateId: "3956",
  zipCode: "10950",
  cidName: "Matamim",
  cidNumber: "9293598299",
};

// ─── Address parsing ─────────────────────────────────────────────────────────

test("a street line splits into number and name", () => {
  assert.deepEqual(splitStreet("15 Van Buren Dr"), { streetNumber: "15", streetName: "Van Buren Dr" });
  assert.deepEqual(splitStreet("16 Depalma Dr"), { streetNumber: "16", streetName: "Depalma Dr" });
  assert.deepEqual(splitStreet("221B Baker Street"), { streetNumber: "221B", streetName: "Baker Street" });
});

test("a street line with no number keeps the whole thing as the street", () => {
  assert.deepEqual(splitStreet("Main Street"), { streetNumber: "", streetName: "Main Street" });
});

// ─── Location ────────────────────────────────────────────────────────────────

test("the location posts the address dispatch will be sent to", () => {
  const p = buildEmergencyLocationPairs(LOC);
  assert.deepEqual(get(p, "class"), ["emergency_locations"]);
  assert.deepEqual(get(p, "mode"), ["add"]);
  assert.deepEqual(get(p, "street_number"), ["15"]);
  assert.deepEqual(get(p, "street_name"), ["Van Buren Dr"]);
  assert.deepEqual(get(p, "city"), ["Monroe"]);
  assert.deepEqual(get(p, "state_id"), ["3956"]);
  assert.deepEqual(get(p, "zip_code"), ["10950"]);
  assert.deepEqual(get(p, "country_id"), [COUNTRY_US]);
});

test("the caller ID is the customer's own number, normalised", () => {
  assert.deepEqual(get(buildEmergencyLocationPairs(LOC), "cid_number"), ["9293598299"]);
  assert.deepEqual(get(buildEmergencyLocationPairs({ ...LOC, cidNumber: "1 (929) 359-8299" }), "cid_number"), ["9293598299"]);
});

test("a location with no usable caller ID is refused", () => {
  for (const bad of ["", "911", "abc", "12345"]) {
    assert.throws(() => buildEmergencyLocationPairs({ ...LOC, cidNumber: bad }), EmergencyProvisionError, bad);
  }
});

test("an incomplete address is refused rather than half-registered", () => {
  assert.throws(() => buildEmergencyLocationPairs({ ...LOC, city: "" }), EmergencyProvisionError);
  assert.throws(() => buildEmergencyLocationPairs({ ...LOC, zipCode: "" }), EmergencyProvisionError);
  assert.throws(() => buildEmergencyLocationPairs({ ...LOC, stateId: "" }), EmergencyProvisionError);
  assert.throws(() => buildEmergencyLocationPairs({ ...LOC, streetName: "  " }), EmergencyProvisionError);
});

test("the refusal explains the consequence, not just the field", () => {
  try {
    buildEmergencyLocationPairs({ ...LOC, city: "" });
    assert.fail("should refuse");
  } catch (e) {
    assert.match((e as Error).message, /wrong place/);
  }
});

// ─── Numbers, trunks, notifications ──────────────────────────────────────────

test("every customer gets 911 and the local EMS/fire line", () => {
  assert.deepEqual(defaultEmergencyNumbers(), [
    { number: "911", description: "Emergency services" },
    { number: "8457831212", description: "Local EMS and fire department" },
  ]);
});

const NUM = { csrf: "tok", description: "Matamim — emergency", trunkIds: ["129"], emailAddresses: ["izzywgg@gmail.com", "office@matamimweekly.com"] };

test("the category posts both numbers in order", () => {
  const p = buildEmergencyNumbersPairs(NUM);
  assert.deepEqual(get(p, "numbers[0][number]"), ["911"]);
  assert.deepEqual(get(p, "numbers[1][number]"), ["8457831212"]);
  assert.deepEqual(get(p, "numbers[2][number]"), []);
});

test("the tenant's own trunk carries the call", () => {
  assert.deepEqual(get(buildEmergencyNumbersPairs(NUM), "trunks[]"), ["129"]);
  assert.deepEqual(get(buildEmergencyNumbersPairs({ ...NUM, trunkIds: ["129", "130"] }), "trunks[]"), ["129", "130"]);
});

test("both the owner and the customer are notified", () => {
  assert.deepEqual(get(buildEmergencyNumbersPairs(NUM), "email_addresses[]"), [
    "izzywgg@gmail.com",
    "office@matamimweekly.com",
  ]);
});

test("a category with no trunk is refused — the call would have no way out", () => {
  assert.throws(() => buildEmergencyNumbersPairs({ ...NUM, trunkIds: [] }), EmergencyProvisionError);
  try {
    buildEmergencyNumbersPairs({ ...NUM, trunkIds: [] });
  } catch (e) {
    assert.match((e as Error).message, /no way out/);
  }
});

test("a category with no numbers is refused", () => {
  assert.throws(() => buildEmergencyNumbersPairs({ ...NUM, numbers: [] }), EmergencyProvisionError);
});

test("the numbers come from the one allow-list, not a second copy", async () => {
  const { EMERGENCY_ALLOWED_DESTINATIONS } = await import("./serviceInterruptionPolicy");
  assert.deepEqual(
    defaultEmergencyNumbers().map((n) => n.number),
    [...EMERGENCY_ALLOWED_DESTINATIONS],
  );
});
