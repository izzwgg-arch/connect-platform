import test from "node:test";
import assert from "node:assert/strict";
import { parseDndStatusBody, planDndPublishTargets, buildDndPublishPayload } from "./mobileDndStatusCore";

test("parseDndStatusBody accepts { dnd: true } and { dnd: false }", () => {
  assert.deepEqual(parseDndStatusBody({ dnd: true }), { ok: true, dnd: true });
  assert.deepEqual(parseDndStatusBody({ dnd: false }), { ok: true, dnd: false });
});

test("parseDndStatusBody rejects non-boolean/missing dnd", () => {
  for (const bad of [{ dnd: "true" }, { dnd: 1 }, { dnd: null }, {}, undefined, null]) {
    const parsed = parseDndStatusBody(bad as any);
    assert.equal(parsed.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test("planDndPublishTargets: numeric extensions with a linked numeric pbxTenantId are all publishable", () => {
  const { publishable, skipped } = planDndPublishTargets(["110", "111"], "2");
  assert.deepEqual(publishable, ["110", "111"]);
  assert.deepEqual(skipped, []);
});

test("planDndPublishTargets: no PBX tenant link skips every extension (documented success-with-skip behavior)", () => {
  const { publishable, skipped } = planDndPublishTargets(["110"], null);
  assert.deepEqual(publishable, []);
  assert.deepEqual(skipped, [{ extNumber: "110", reason: "no_pbx_tenant_link" }]);
});

test("planDndPublishTargets: non-numeric pbxTenantId is treated the same as no link", () => {
  const { publishable, skipped } = planDndPublishTargets(["110"], "abc");
  assert.deepEqual(publishable, []);
  assert.deepEqual(skipped, [{ extNumber: "110", reason: "no_pbx_tenant_link" }]);
});

test("planDndPublishTargets: a non-numeric extension is individually skipped without blocking siblings", () => {
  const { publishable, skipped } = planDndPublishTargets(["110", "abc"], "2");
  assert.deepEqual(publishable, ["110"]);
  assert.deepEqual(skipped, [{ extNumber: "abc", reason: "non_numeric_extension" }]);
});

test("planDndPublishTargets: empty extension list publishes nothing, skips nothing (not an error)", () => {
  const { publishable, skipped } = planDndPublishTargets([], "2");
  assert.deepEqual(publishable, []);
  assert.deepEqual(skipped, []);
});

test("buildDndPublishPayload: dnd=true → '1', epoch seconds truncated from ms", () => {
  const payload = buildDndPublishPayload("2", "110", true, 1_780_000_000_123);
  assert.deepEqual(payload, { pbxTenantId: "2", extension: "110", dnd: "1", ts: "1780000000" });
});

test("buildDndPublishPayload: dnd=false → '0'", () => {
  const payload = buildDndPublishPayload("2", "110", false, 1_780_000_000_999);
  assert.equal(payload.dnd, "0");
  assert.equal(payload.ts, "1780000000");
});
