import { strict as assert } from "node:assert";
import { test } from "node:test";

import { readMemberRows, toggleMembers } from "./arsMemberToggle";

/** A real loaded edit form, as parsed from the panel (Matamim, ars 214, plus
 *  a second member so multi-route selections are covered). */
const form = (): Array<[string, string]> => [
  ["ars_id", "214"],
  ["class", "ars"],
  ["method", "put"],
  ["mode", "edit"],
  ["csfr_token", "tok"],
  ["description", "Matamim h8gmrh"],
  ["members[{{row-count-placeholder}}][enabled]", "1"],
  ["members[{{row-count-placeholder}}][outbound_route_id]", ""],
  ["members[0][enabled]", "yes"],
  ["members[0][outbound_route_id]", "125"],
  ["members[0][time_group_id]", ""],
  ["members[1][outbound_route_id]", "126"], // no enabled pair = already off
  ["members[1][time_group_id]", "5"],
];

const has = (p: Array<[string, string]>, k: string) => p.some(([x]) => x === k);
const val = (p: Array<[string, string]>, k: string) => p.find(([x]) => x === k)?.[1];

// ─── Reading ─────────────────────────────────────────────────────────────────

test("members are read with their form index, ignoring the template row", () => {
  assert.deepEqual(readMemberRows(form()), [
    { index: 0, outboundRouteId: "125", enabled: true },
    { index: 1, outboundRouteId: "126", enabled: false },
  ]);
});

test("enabled is judged by PRESENCE, not by the value", () => {
  // The add form renders "1", the edit form renders "yes" — both mean ticked.
  for (const v of ["1", "yes", "on", ""]) {
    const rows = readMemberRows([
      ["members[0][outbound_route_id]", "125"],
      ["members[0][enabled]", v],
    ]);
    assert.equal(rows[0].enabled, true, JSON.stringify(v));
  }
  const absent = readMemberRows([["members[0][outbound_route_id]", "125"]]);
  assert.equal(absent[0].enabled, false);
});

// ─── ⛔ The checkbox trap ────────────────────────────────────────────────────

test("DISABLING REMOVES the pair — it never sends enabled=0", () => {
  const { pairs } = toggleMembers(form(), { outboundRouteIds: new Set(["125"]), enabled: false });
  assert.equal(has(pairs, "members[0][enabled]"), false, "the pair must be gone, not set to 0");
  for (const [k, v] of pairs) {
    if (k === "members[0][enabled]") assert.fail(`enabled was sent as ${JSON.stringify(v)} — the panel would tick it`);
  }
  assert.equal(readMemberRows(pairs)[0].enabled, false);
});

test("enabling adds the pair back", () => {
  const { pairs } = toggleMembers(form(), { outboundRouteIds: new Set(["126"]), enabled: true });
  assert.equal(val(pairs, "members[1][enabled]"), "1");
  assert.equal(readMemberRows(pairs)[1].enabled, true);
});

// ─── ⛔ Full replace: nothing may be lost ────────────────────────────────────

test("every member survives the edit", () => {
  const { pairs } = toggleMembers(form(), { outboundRouteIds: new Set(["125"]), enabled: false });
  assert.deepEqual(readMemberRows(pairs).map((r) => r.outboundRouteId), ["125", "126"]);
  assert.equal(val(pairs, "members[1][time_group_id]"), "5", "time group preserved");
  assert.equal(val(pairs, "description"), "Matamim h8gmrh", "description preserved");
  assert.equal(val(pairs, "ars_id"), "214");
  assert.equal(val(pairs, "csfr_token"), "tok");
});

test("the template row is never posted as a real member", () => {
  const { pairs } = toggleMembers(form(), { outboundRouteIds: new Set(["125"]), enabled: false });
  assert.equal(pairs.some(([k]) => k.includes("row-count-placeholder")), false);
});

test("it always posts as an edit, never as an add", () => {
  const { pairs } = toggleMembers(form(), { outboundRouteIds: new Set(["125"]), enabled: false });
  assert.equal(val(pairs, "mode"), "edit");
  assert.equal(val(pairs, "method"), "put");
});

// ─── Only what was asked for ─────────────────────────────────────────────────

test("members not named are untouched", () => {
  const { pairs, changed } = toggleMembers(form(), { outboundRouteIds: new Set(["125"]), enabled: false });
  assert.deepEqual(changed.map((c) => c.outboundRouteId), ["125"]);
  assert.equal(readMemberRows(pairs)[1].enabled, false, "126 was already off and stays off");
});

test("a member already in the wanted state is not reported as changed", () => {
  // 126 is already off; asking to disable it changes nothing.
  const { changed } = toggleMembers(form(), { outboundRouteIds: new Set(["126"]), enabled: false });
  assert.deepEqual(changed, []);
});

test("changed is what the restore replays — exactly what we switched off", () => {
  const { pairs, changed } = toggleMembers(form(), {
    outboundRouteIds: new Set(["125", "126"]),
    enabled: false,
  });
  // 126 was the customer's own choice, so only 125 is ours to put back.
  assert.deepEqual(changed.map((c) => c.outboundRouteId), ["125"]);
  const back = toggleMembers(pairs, {
    outboundRouteIds: new Set(changed.map((c) => c.outboundRouteId)),
    enabled: true,
  });
  assert.deepEqual(readMemberRows(back.pairs), readMemberRows(form()), "round trip returns the starting state");
});

test("toggling nothing leaves the form byte-identical apart from mode/method", () => {
  const { pairs, changed } = toggleMembers(form(), { outboundRouteIds: new Set(["999"]), enabled: false });
  assert.deepEqual(changed, []);
  assert.deepEqual(readMemberRows(pairs), readMemberRows(form()));
});
