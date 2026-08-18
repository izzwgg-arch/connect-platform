import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  EmergencyRouteInputError,
  PH,
  arsHasEmergencyLast,
  buildArsAppendPairs,
  buildEmergencyRoutePairs,
  emergencyRouteLabel,
  parseArsMembers,
  resolveEmergencyCallerId,
} from "./emergencyRouteBuilder";

const get = (pairs: Array<[string, string]>, key: string) => pairs.filter(([k]) => k === key).map(([, v]) => v);
const patternsOf = (pairs: Array<[string, string]>) =>
  pairs.filter(([k]) => /^trkpattern\[\d+\]\[pattern\]$/.test(k)).map(([, v]) => v);

const ROUTE = { csrf: "tok", label: "Gesheft — emergency only", cidName: "Gesheft", cidNumber: "8455577768", trunkId: "42" };

// ─── Drift guard against the onboarding code we are copying ──────────────────

test("PH matches the placeholder onboarding actually posts", () => {
  const src = readFileSync(resolve(__dirname, "../../onboarding/pbxTenantBuild.ts"), "utf8");
  const m = /const PH = "([^"]+)"/.exec(src);
  assert.ok(m, "could not find PH in pbxTenantBuild.ts");
  assert.equal(PH, m[1]);
});

// ─── The route matches emergencies and nothing else ──────────────────────────

test("the route carries exactly the emergency patterns", () => {
  assert.deepEqual(patternsOf(buildEmergencyRoutePairs(ROUTE)), ["911", "8457831212", "18457831212"]);
});

test("the route has no catch-all and no 7-digit prepend rule", () => {
  const pairs = buildEmergencyRoutePairs(ROUTE);
  for (const p of patternsOf(pairs)) {
    assert.equal(/^(nxx|1nxx|\+1nxx|011)/.test(p), false, `ordinary-call pattern leaked in: ${p}`);
  }
  assert.deepEqual(get(pairs, "trkpattern[0][prepend]"), [""]);
});

test("it posts as an outbound route on the customer's own trunk", () => {
  const pairs = buildEmergencyRoutePairs(ROUTE);
  assert.deepEqual(get(pairs, "class"), ["trunk_group"]);
  assert.deepEqual(get(pairs, "mode"), ["add"]);
  assert.deepEqual(get(pairs, "trklist[]"), ["42"]);
  assert.deepEqual(get(pairs, "description"), ["Gesheft — emergency only"]);
});

// ─── Caller ID: per customer, never blank ────────────────────────────────────

test("the caller ID is the customer's own outbound number", () => {
  const pairs = buildEmergencyRoutePairs(ROUTE);
  assert.deepEqual(get(pairs, "cid_number"), ["8455577768"]);
  assert.deepEqual(get(pairs, "cid_name"), ["Gesheft"]);
  assert.deepEqual(get(pairs, "overwrite_cid"), ["if_not_provided"]);
});

test("caller ID is taken from the customer's existing outbound route first", () => {
  const r = resolveEmergencyCallerId({
    companyName: "Gesheft",
    existingRouteCidNumber: "(845) 557-7768",
    existingRouteCidName: "Gesheft Kosher",
    tenantDid: "6469846023",
  });
  assert.deepEqual(r, { cidNumber: "8455577768", cidName: "Gesheft Kosher", source: "outbound_route" });
});

test("it falls back to the tenant's own DID, never to a Loopcom number", () => {
  const r = resolveEmergencyCallerId({ companyName: "Gesheft", existingRouteCidNumber: "", tenantDid: "1-646-984-6023" });
  assert.deepEqual(r, { cidNumber: "6469846023", cidName: "Gesheft", source: "tenant_did" });
});

test("a customer with no usable caller ID is REFUSED, not given a blank one", () => {
  assert.throws(
    () => resolveEmergencyCallerId({ companyName: "Nowhere Ltd", existingRouteCidNumber: null, tenantDid: null }),
    (e: EmergencyRouteInputError) => e.name === "EmergencyRouteInputError" && /911 dispatch/.test(e.message),
  );
  for (const bad of ["", "   ", "0", "123", "abc", "84555777689999"]) {
    assert.throws(() => buildEmergencyRoutePairs({ ...ROUTE, cidNumber: bad }), EmergencyRouteInputError, bad);
  }
});

test("a route with no trunk or no name is refused", () => {
  assert.throws(() => buildEmergencyRoutePairs({ ...ROUTE, trunkId: "" }), EmergencyRouteInputError);
  assert.throws(() => buildEmergencyRoutePairs({ ...ROUTE, label: "  " }), EmergencyRouteInputError);
});

test("each customer gets their own labelled route", () => {
  assert.equal(emergencyRouteLabel("Gesheft"), "Gesheft — emergency only");
  assert.notEqual(emergencyRouteLabel("Gesheft"), emergencyRouteLabel("Displaydex"));
});

// ─── Route selection: emergency goes LAST ────────────────────────────────────

const members = () => [
  { outboundRouteId: "10", timeGroupId: "", enabled: "1" },
  { outboundRouteId: "11", timeGroupId: "5", enabled: "0" },
];

test("the emergency route is appended at the BOTTOM of the selection", () => {
  const pairs = buildArsAppendPairs({ csrf: "t", arsId: "7", description: "Gesheft", existingMembers: members(), emergencyRouteId: "99" });
  assert.deepEqual(get(pairs, "members[0][outbound_route_id]"), ["10"]);
  assert.deepEqual(get(pairs, "members[1][outbound_route_id]"), ["11"]);
  assert.deepEqual(get(pairs, "members[2][outbound_route_id]"), ["99"]);
  assert.deepEqual(get(pairs, "members[3][outbound_route_id]"), []);
});

test("existing members keep their order, time group and enabled state", () => {
  const pairs = buildArsAppendPairs({ csrf: "t", arsId: "7", description: "Gesheft", existingMembers: members(), emergencyRouteId: "99" });
  assert.deepEqual(get(pairs, "members[1][time_group_id]"), ["5"]);
  assert.deepEqual(get(pairs, "members[1][enabled]"), ["0"], "a member the customer disabled must stay disabled");
  assert.deepEqual(get(pairs, "members[2][enabled]"), ["1"], "the emergency member is enabled");
});

test("it edits the existing selection rather than creating a second one", () => {
  const pairs = buildArsAppendPairs({ csrf: "t", arsId: "7", description: "Gesheft", existingMembers: members(), emergencyRouteId: "99" });
  assert.deepEqual(get(pairs, "class"), ["ars"]);
  assert.deepEqual(get(pairs, "mode"), ["edit"]);
  assert.deepEqual(get(pairs, "id"), ["7"]);
});

test("running it twice does not add the route twice", () => {
  const withEmergency = [...members(), { outboundRouteId: "99", timeGroupId: "", enabled: "1" }];
  const pairs = buildArsAppendPairs({ csrf: "t", arsId: "7", description: "Gesheft", existingMembers: withEmergency, emergencyRouteId: "99" });
  assert.deepEqual(get(pairs, "members[2][outbound_route_id]"), ["99"]);
  assert.deepEqual(get(pairs, "members[3][outbound_route_id]"), []);
});

test("a customer with no routes yet still gets the emergency member", () => {
  const pairs = buildArsAppendPairs({ csrf: "t", arsId: "7", description: "New Co", existingMembers: [], emergencyRouteId: "99" });
  assert.deepEqual(get(pairs, "members[0][outbound_route_id]"), ["99"]);
});

test("appending is refused without a route id or a selection to edit", () => {
  const base = { csrf: "t", arsId: "7", description: "x", existingMembers: [] };
  assert.throws(() => buildArsAppendPairs({ ...base, emergencyRouteId: "" }), EmergencyRouteInputError);
  assert.throws(() => buildArsAppendPairs({ ...base, arsId: "", emergencyRouteId: "99" }), EmergencyRouteInputError);
});

test("arsHasEmergencyLast reports the bottom position only", () => {
  assert.equal(arsHasEmergencyLast([...members(), { outboundRouteId: "99", timeGroupId: "", enabled: "1" }], "99"), true);
  assert.equal(arsHasEmergencyLast([{ outboundRouteId: "99", timeGroupId: "", enabled: "1" }, ...members()], "99"), false);
  assert.equal(arsHasEmergencyLast([], "99"), false);
});

// ─── Reading the form back ───────────────────────────────────────────────────

test("members are parsed in order and the template row is ignored", () => {
  const parsed = parseArsMembers([
    ["description", "Gesheft"],
    [`members[${PH}][outbound_route_id]`, ""],
    [`members[${PH}][enabled]`, "1"],
    ["members[1][outbound_route_id]", "11"],
    ["members[1][time_group_id]", "5"],
    ["members[1][enabled]", "0"],
    ["members[0][outbound_route_id]", "10"],
    ["members[0][time_group_id]", ""],
    ["members[0][enabled]", "1"],
  ]);
  assert.deepEqual(parsed, [
    { outboundRouteId: "10", timeGroupId: "", enabled: "1" },
    { outboundRouteId: "11", timeGroupId: "5", enabled: "0" },
  ]);
});

test("a round trip through parse and append keeps the customer's rows intact", () => {
  const form: Array<[string, string]> = [
    ["members[0][outbound_route_id]", "10"], ["members[0][time_group_id]", ""], ["members[0][enabled]", "1"],
    ["members[1][outbound_route_id]", "11"], ["members[1][time_group_id]", "5"], ["members[1][enabled]", "0"],
  ];
  const pairs = buildArsAppendPairs({
    csrf: "t", arsId: "7", description: "Gesheft",
    existingMembers: parseArsMembers(form), emergencyRouteId: "99",
  });
  assert.equal(arsHasEmergencyLast(parseArsMembers(pairs), "99"), true);
  assert.deepEqual(parseArsMembers(pairs).map((m) => m.outboundRouteId), ["10", "11", "99"]);
});
