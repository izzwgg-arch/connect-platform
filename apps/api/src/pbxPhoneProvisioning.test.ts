import { test } from "node:test";
import assert from "node:assert/strict";

import { comparePhones, PROVISIONING_GRANT_SQL } from "./pbxPhoneProvisioning";

/**
 * The comparison is the product. A list of MAC addresses helps nobody; "this
 * phone is on the network but the phone system has never heard of it" is the
 * sentence that saves an afternoon.
 *
 * The scenario throughout is the real one: Create A Box ext 102, whose panel
 * record carried a MAC one character different from the handset's, so VitalPBX
 * rewrote a file no phone ever downloaded — for seven weeks, with a clean 200
 * in the log the whole time.
 */

const HANDSET_REAL = "805e0c4d7e6b";      // what the phone actually is
const HANDSET_TYPO = "805e0c4d7e6c";      // what the panel had recorded

const pbxPhone = (mac: string, over: Partial<any> = {}) => ({
  mac,
  macRaw: mac,
  pbxTenant: 7,
  description: "102",
  model: "T53W",
  brand: "Yealink",
  ...over,
});

test("⛔ the wrong-MAC case is caught, and produces TWO actionable rows", () => {
  // This is the whole feature. The panel says one thing, the wire says another.
  const result = comparePhones({
    pbxPhones: [pbxPhone(HANDSET_TYPO)],
    networkPhones: [{ mac: HANDSET_REAL, ip: "192.168.44.10", vendor: "Yealink" }],
    networkScanned: true,
  });

  assert.equal(result.counts.missingFromPbx, 1, "the real handset is unknown to the phone system");
  assert.equal(result.counts.notOnNetwork, 1, "the recorded MAC matches nothing on the wire");
  assert.equal(result.counts.ok, 0);

  const onWire = result.rows.find((r) => r.mac === HANDSET_REAL)!;
  assert.equal(onWire.verdict, "missing_from_pbx");
  assert.equal(onWire.ip, "192.168.44.10");
  // The explanation must name the actual cause, not just state the symptom.
  assert.match(onWire.explanation, /hardware ID on its record is probably wrong/i);
});

test("a phone whose record is correct reads as ok", () => {
  const result = comparePhones({
    pbxPhones: [pbxPhone(HANDSET_REAL)],
    networkPhones: [{ mac: HANDSET_REAL, ip: "192.168.44.10", vendor: "Yealink" }],
    networkScanned: true,
  });
  assert.equal(result.counts.ok, 1);
  assert.equal(result.counts.missingFromPbx, 0);
  assert.equal(result.counts.notOnNetwork, 0);
  const row = result.rows[0];
  assert.equal(row.onPbx, true);
  assert.equal(row.onNetwork, true);
  assert.equal(row.model, "T53W");
});

test("different spellings of the same MAC still match", () => {
  // The panel stores bare hex, Windows ARP prints dashes. If these failed to
  // match, every correctly-configured phone would be reported as a fault.
  const result = comparePhones({
    pbxPhones: [pbxPhone("805e0c4d7e6b")],
    networkPhones: [{ mac: "80-5E-0C-4D-7E-6B" }],
    networkScanned: true,
  });
  assert.equal(result.counts.ok, 1);
});

test("⛔ 'not on the network' is never phrased as a fault", () => {
  // A phone at another site, on another subnet, or simply switched off looks
  // identical from here. Calling that broken would send someone hunting a
  // problem that does not exist.
  const result = comparePhones({
    pbxPhones: [pbxPhone(HANDSET_REAL)],
    networkPhones: [],
    networkScanned: true,
  });
  const row = result.rows[0];
  assert.equal(row.verdict, "not_on_network");
  assert.match(row.explanation, /switched off, at another site, or on a different network/i);
  assert.doesNotMatch(row.explanation, /broken|fault|error|wrong/i);
});

test("⛔ before any scan, an absence is reported as 'nothing to compare' — not as missing", () => {
  // The distinction that stops an empty inventory being read as "this office
  // has no phones".
  const result = comparePhones({
    pbxPhones: [pbxPhone(HANDSET_REAL)],
    networkPhones: [],
    networkScanned: false,
  });
  assert.match(result.rows[0].explanation, /Nobody has scanned a network yet/i);
});

test("⛔ a record with an unreadable MAC is REPORTED, not silently dropped", () => {
  // It is one of the ways provisioning breaks, so hiding it would hide exactly
  // what this module exists to surface.
  const result = comparePhones({
    pbxPhones: [pbxPhone("", { macRaw: "not-a-mac" })],
    networkPhones: [],
    networkScanned: true,
  });
  assert.equal(result.counts.unreadable, 1);
  const row = result.rows[0];
  assert.equal(row.verdict, "unreadable_mac");
  assert.equal(row.macFormatted, "not-a-mac");
  assert.match(row.explanation, /no phone will ever ask for/i);
});

test("a blank MAC is shown as (blank) rather than an empty cell", () => {
  const result = comparePhones({
    pbxPhones: [pbxPhone("", { macRaw: "" })],
    networkPhones: [],
    networkScanned: true,
  });
  assert.equal(result.rows[0].macFormatted, "(blank)");
});

test("two devices with unreadable MACs both appear", () => {
  // They must not collapse into one row just because their MAC key is empty.
  const result = comparePhones({
    pbxPhones: [
      pbxPhone("", { macRaw: "junk-1", description: "101" }),
      pbxPhone("", { macRaw: "junk-2", description: "103" }),
    ],
    networkPhones: [],
    networkScanned: true,
  });
  assert.equal(result.counts.unreadable, 2);
});

test("MACs are formatted for humans", () => {
  const result = comparePhones({
    pbxPhones: [pbxPhone(HANDSET_REAL)],
    networkPhones: [],
    networkScanned: true,
  });
  assert.equal(result.rows[0].macFormatted, "80:5e:0c:4d:7e:6b");
});

test("a device on the network that is not a phone still surfaces", () => {
  // A laptop shows as missing_from_pbx, which is correct and harmless — the
  // screen separates known phone makes from everything else.
  const result = comparePhones({
    pbxPhones: [],
    networkPhones: [{ mac: "aabbccddeeff", ip: "192.168.44.55", vendor: null }],
    networkScanned: true,
  });
  assert.equal(result.counts.missingFromPbx, 1);
  assert.equal(result.rows[0].vendor, null);
});

test("⛔ the grant is the narrowest possible — SELECT only, three tables", () => {
  // A read-only feature must never ask for more than read on what it reads.
  assert.match(PROVISIONING_GRANT_SQL, /GRANT SELECT ON/);
  assert.doesNotMatch(PROVISIONING_GRANT_SQL, /ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP/i);
  assert.doesNotMatch(PROVISIONING_GRANT_SQL, /provisioning`\.\*/);
  for (const table of ["devices", "phone_models", "brands"]) {
    assert.ok(PROVISIONING_GRANT_SQL.includes(`\`${table}\``), `${table} missing from the grant`);
  }
});

/* ── the column that does not exist (2026-08-25) ──────────────────────
 *
 * `provisioning.phone_models` has NO `name` column — the model string is
 * `pm.model`. The original select said `pm.name`, which threw "Unknown column"
 * on EVERY call, was caught by the error handler, and reported the whole PBX as
 * unreachable. It shipped that way and was never noticed because nothing had
 * ever consumed this data until the first real desk-phone customer run
 * (A plus center, 2026-08-25). Verified against the live PBX:
 * SHOW COLUMNS FROM provisioning.phone_models → id, brand_id, model, …
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the provisioning select reads pm.model — phone_models has no name column", () => {
  const src = readFileSync(join(__dirname, "pbxPhoneProvisioning.ts"), "utf8").replace(/\r?\n/g, "\n");
  // ⛔ Strip comments first: the doc block deliberately quotes the broken
  // `pm.name`, and a naive substring match fails on the very comment that
  // records why the guard exists (the documented trap, again).
  const executable = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
    .join("\n");
  assert.ok(/pm\.model\s+AS model/.test(executable), "the model column must be pm.model");
  assert.ok(!/pm\.name/.test(executable), "pm.name is not a column; selecting it kills every call");
});
