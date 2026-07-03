import assert from "node:assert/strict";
import test from "node:test";
import { parseDndPublishRequest } from "./dndPublish";

test("accepts a well-formed request and builds the T<tid>_<ext> key", () => {
  const parsed = parseDndPublishRequest({
    pbxTenantId: "2",
    extension: "110",
    dnd: "1",
    ts: "1780000000",
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.key, "T2_110");
    assert.equal(parsed.dnd, "1");
    assert.equal(parsed.ts, "1780000000");
  }
});

test("accepts dnd='0' (clearing DND) identically", () => {
  const parsed = parseDndPublishRequest({
    pbxTenantId: "2",
    extension: "110",
    dnd: "0",
    ts: "1780000000",
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.dnd, "0");
});

test("rejects non-numeric pbxTenantId", () => {
  for (const bad of ["2a", "", "T2", "2/../connect", "-2", "2.5"]) {
    const parsed = parseDndPublishRequest({ pbxTenantId: bad, extension: "110", dnd: "1", ts: "100" });
    assert.equal(parsed.ok, false, `expected rejection for pbxTenantId=${JSON.stringify(bad)}`);
    if (!parsed.ok) assert.equal(parsed.error, "invalid_pbx_tenant_id");
  }
});

test("rejects non-numeric extension, including path-like injection attempts", () => {
  for (const bad of ["110a", "", "110/../wake_canary", "110_1", "-110"]) {
    const parsed = parseDndPublishRequest({ pbxTenantId: "2", extension: bad, dnd: "1", ts: "100" });
    assert.equal(parsed.ok, false, `expected rejection for extension=${JSON.stringify(bad)}`);
    if (!parsed.ok) assert.equal(parsed.error, "invalid_extension");
  }
});

test("rejects any dnd value other than exactly '0' or '1'", () => {
  for (const bad of ["true", "yes", "2", "", "01", "1.0", 1, true, null]) {
    const parsed = parseDndPublishRequest({ pbxTenantId: "2", extension: "110", dnd: bad as any, ts: "100" });
    assert.equal(parsed.ok, false, `expected rejection for dnd=${JSON.stringify(bad)}`);
    if (!parsed.ok) assert.equal(parsed.error, "invalid_dnd_value");
  }
});

test("rejects a non-digit or missing timestamp", () => {
  for (const bad of ["abc", "", "-100", "100.5", "1e9", null, 1780000000]) {
    const parsed = parseDndPublishRequest({ pbxTenantId: "2", extension: "110", dnd: "1", ts: bad as any });
    assert.equal(parsed.ok, false, `expected rejection for ts=${JSON.stringify(bad)}`);
    if (!parsed.ok) assert.equal(parsed.error, "invalid_timestamp");
  }
});

test("there is no family/key passthrough field — an arbitrary family can never be selected", () => {
  const parsed = parseDndPublishRequest({
    pbxTenantId: "2",
    extension: "110",
    dnd: "1",
    ts: "100",
    // Attempted injection: even if a caller adds extra fields, the parser
    // never reads or forwards them — only pbxTenantId/extension/dnd/ts.
    family: "connect/system",
    key: "wake_grace_secs",
    value: "1",
  } as any);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.key, "T2_110");
    assert.deepEqual(Object.keys(parsed).sort(), ["dnd", "extension", "key", "ok", "pbxTenantId", "ts"]);
  }
});

test("rejects missing body entirely", () => {
  const parsed = parseDndPublishRequest(undefined);
  assert.equal(parsed.ok, false);
});
