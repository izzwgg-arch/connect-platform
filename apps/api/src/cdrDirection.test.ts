/**
 * CDR direction tests — uses canonicalDirection / directionFromDcontext from cdrDirection.ts
 *
 *   npm test --workspace @connect/api
 */

import test from "node:test";
import assert from "node:assert/strict";
import { canonicalDirection, wouldOverride, cdrCanonicalDirectionSql, directionFromDcontext } from "./cdrDirection";

test("extension → external: override incoming to outgoing", () => {
  assert.equal(canonicalDirection("107", "8453519000", "incoming"), "outgoing");
});
test("extension → external: override unknown to outgoing", () => {
  assert.equal(canonicalDirection("102", "12125551234", "unknown"), "outgoing");
});
test("extension → external: already outgoing stays outgoing", () => {
  assert.equal(canonicalDirection("105", "9174561234", "outgoing"), "outgoing");
});
test("2-digit extension → 10-digit = outgoing", () => {
  assert.equal(canonicalDirection("10", "4155556789", "incoming"), "outgoing");
});
test("6-digit extension (max) → 10-digit = outgoing", () => {
  assert.equal(canonicalDirection("123456", "8005551234", "incoming"), "outgoing");
});

test("external → extension: stays incoming when stored correctly", () => {
  assert.equal(canonicalDirection("8453519000", "107", "incoming"), "incoming");
});
test("external → extension: override outgoing to incoming", () => {
  assert.equal(canonicalDirection("9174561234", "105", "outgoing"), "incoming");
});
test("external → extension: override unknown to incoming", () => {
  assert.equal(canonicalDirection("18005551234", "201", "unknown"), "incoming");
});

test("extension → extension: stays internal when already correct", () => {
  assert.equal(canonicalDirection("101", "202", "internal"), "internal");
});
test("extension → extension: override incoming to internal", () => {
  assert.equal(canonicalDirection("103", "104", "incoming"), "internal");
});
test("extension → extension: override outgoing to internal", () => {
  assert.equal(canonicalDirection("200", "300", "outgoing"), "internal");
});

test("both null: return stored direction", () => {
  assert.equal(canonicalDirection(null, null, "incoming"), "incoming");
  assert.equal(canonicalDirection(null, null, "outgoing"), "outgoing");
  assert.equal(canonicalDirection(null, null, "unknown"), "unknown");
});
test("external → external: no pattern, keep stored", () => {
  assert.equal(canonicalDirection("8005551234", "9174569000", "incoming"), "incoming");
});

test("+1 country code stripped from 11-digit 'to': classified as external", () => {
  assert.equal(canonicalDirection("107", "18453519000", "incoming"), "outgoing");
});
test("+1 country code stripped from 11-digit 'from': classified as external", () => {
  assert.equal(canonicalDirection("18005551234", "107", "outgoing"), "incoming");
});

test("empty string from/to: keep stored direction", () => {
  assert.equal(canonicalDirection("", "", "outgoing"), "outgoing");
});
test("from=null, to=extension: no pattern, keep stored", () => {
  assert.equal(canonicalDirection(null, "107", "incoming"), "incoming");
});

test("unknown stored with no pattern: still unknown", () => {
  assert.equal(canonicalDirection(null, null, "unknown"), "unknown");
});
test("invalid stored direction string: returns unknown", () => {
  assert.equal(canonicalDirection(null, null, "bogus"), "unknown");
});

test("wouldOverride: true for extension→external stored as incoming", () => {
  assert.equal(wouldOverride("107", "8453519000", "incoming"), true);
});
test("wouldOverride: false when already correctly classified outgoing", () => {
  assert.equal(wouldOverride("107", "8453519000", "outgoing"), false);
});
test("wouldOverride: false for correctly classified incoming", () => {
  assert.equal(wouldOverride("8453519000", "107", "incoming"), false);
});
test("wouldOverride: false for correctly classified internal", () => {
  assert.equal(wouldOverride("101", "202", "internal"), false);
});
test("wouldOverride: false when no pattern applies", () => {
  assert.equal(wouldOverride(null, null, "incoming"), false);
});

test("7-digit 'to': ambiguous local PSTN, not counted as external → keep stored", () => {
  assert.equal(canonicalDirection("105", "5551234", "incoming"), "incoming");
});
test("9-digit 'to': not in external range → keep stored", () => {
  assert.equal(canonicalDirection("105", "123456789", "incoming"), "incoming");
});
test("1-digit 'from': not in extension range → no pattern", () => {
  assert.equal(canonicalDirection("5", "8453519000", "incoming"), "incoming");
});

test("cdrCanonicalDirectionSql returns CASE statement", () => {
  const sql = cdrCanonicalDirectionSql();
  assert.ok(sql.includes("CASE"));
  assert.ok(sql.includes("END"));
});

test("dcontext ext-local: PSTN→PSTN call classified as outgoing", () => {
  assert.equal(canonicalDirection("8457990527", "8452449666", "incoming", "ext-local-gesheft"), "outgoing");
});
test("dcontext from-trunk: PSTN→PSTN classified as incoming", () => {
  assert.equal(canonicalDirection("8457990527", "8452449666", "outgoing", "from-trunk"), "incoming");
});
test("dcontext ext-local with short dest: classified as internal", () => {
  assert.equal(canonicalDirection("8457990527", "105", "incoming", "ext-local-gesheft"), "internal");
});
test("dcontext sub-local-dialing: outgoing call", () => {
  assert.equal(canonicalDirection("105", "8453519000", "incoming", "sub-local-dialing"), "outgoing");
});
test("dcontext from-internal with long dest: outgoing", () => {
  assert.equal(canonicalDirection("8457990527", "8452449666", "incoming", "from-internal"), "outgoing");
});
test("dcontext trk-trunk1-in: inbound", () => {
  assert.equal(canonicalDirection("8457990527", "8452449666", "unknown", "trk-trunk1-in"), "incoming");
});
test("dcontext trk-trunk1-dial: outgoing", () => {
  assert.equal(canonicalDirection("8457990527", "8452449666", "incoming", "trk-trunk1-dial"), "outgoing");
});
test("dcontext ivr-1: inbound", () => {
  assert.equal(canonicalDirection("8457990527", "8452449666", "unknown", "ivr-1"), "incoming");
});
test("dcontext t1_cos-default: outgoing", () => {
  assert.equal(canonicalDirection("8457990527", "8452449666", "incoming", "t1_cos-default"), "outgoing");
});
test("dcontext null: falls back to number heuristic (ext→PSTN = outgoing)", () => {
  assert.equal(canonicalDirection("107", "8453519000", "incoming", null), "outgoing");
});
test("dcontext empty string: falls back to number heuristic", () => {
  assert.equal(canonicalDirection("107", "8453519000", "incoming", ""), "outgoing");
});
test("dcontext takes priority even when number heuristic would disagree", () => {
  assert.equal(canonicalDirection("107", "202", "outgoing", "ext-local-foo"), "internal");
});

test("directionFromDcontext: from-trunk → incoming", () => {
  assert.equal(directionFromDcontext("from-trunk"), "incoming");
});
test("directionFromDcontext: from-pstn → incoming", () => {
  assert.equal(directionFromDcontext("from-pstn"), "incoming");
});
test("directionFromDcontext: ext-local-gesheft → outgoing (no dest)", () => {
  assert.equal(directionFromDcontext("ext-local-gesheft"), "outgoing");
});
test("directionFromDcontext: ext-local with extension dest → internal", () => {
  assert.equal(directionFromDcontext("ext-local-gesheft", "105"), "internal");
});
test("directionFromDcontext: unrecognized → null", () => {
  assert.equal(directionFromDcontext("some-random-context"), null);
});
test("directionFromDcontext: null → null", () => {
  assert.equal(directionFromDcontext(null), null);
});

test("wouldOverride: dcontext ext-local corrects PSTN→PSTN stored as incoming", () => {
  assert.equal(wouldOverride("8457990527", "8452449666", "incoming", "ext-local-gesheft"), true);
});
test("wouldOverride: dcontext ext-local already outgoing → no override", () => {
  assert.equal(wouldOverride("8457990527", "8452449666", "outgoing", "ext-local-gesheft"), false);
});

test("merged dcontexts: outbound trunk wins over inbound leg", () => {
  const d = canonicalDirection("201", "8455551212", "incoming", null, {
    dcontexts: ["from-trunk-inbound", "trk-voip-dial"],
    channelNames: [],
    telephonyDirectionHint: "incoming",
  });
  assert.equal(d, "outgoing");
});
