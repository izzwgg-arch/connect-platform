import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWakeCanaryPublishRequest,
  buildWakeCanaryKeyWrites,
  WAKE_CANARY_FAMILY,
  WAKE_CANARY_OWNER_FAMILY,
  WAKE_CANARY_SOURCE_FAMILY,
  WAKE_CANARY_UPDATED_FAMILY,
  WAKE_CANARY_OWNER_VALUE,
  WAKE_CANARY_SOURCE_VALUE,
} from "./wakeCanaryPublish";

test("accepts a well-formed enable request and builds the T<tid>_<ext> key", () => {
  const parsed = parseWakeCanaryPublishRequest({
    pbxTenantId: "2",
    extension: "110",
    enable: "1",
    ts: "1780000000",
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.key, "T2_110");
    assert.equal(parsed.enable, "1");
    assert.equal(parsed.ts, "1780000000");
  }
});

test("accepts enable='0' (disable) identically", () => {
  const parsed = parseWakeCanaryPublishRequest({
    pbxTenantId: "2",
    extension: "110",
    enable: "0",
    ts: "1780000000",
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.enable, "0");
});

test("rejects non-numeric pbxTenantId, including path-like injection attempts", () => {
  for (const bad of ["2a", "", "T2", "2/../connect", "-2", "2.5"]) {
    const parsed = parseWakeCanaryPublishRequest({ pbxTenantId: bad, extension: "110", enable: "1", ts: "100" });
    assert.equal(parsed.ok, false, `expected rejection for pbxTenantId=${JSON.stringify(bad)}`);
    if (!parsed.ok) assert.equal(parsed.error, "invalid_pbx_tenant_id");
  }
});

test("rejects non-numeric extension, including path-like injection attempts", () => {
  for (const bad of ["110a", "", "110/../wake_canary", "110_1", "-110"]) {
    const parsed = parseWakeCanaryPublishRequest({ pbxTenantId: "2", extension: bad, enable: "1", ts: "100" });
    assert.equal(parsed.ok, false, `expected rejection for extension=${JSON.stringify(bad)}`);
    if (!parsed.ok) assert.equal(parsed.error, "invalid_extension");
  }
});

test("rejects any enable value other than exactly '0' or '1'", () => {
  for (const bad of ["true", "yes", "2", "", "01", "1.0", 1, true, null]) {
    const parsed = parseWakeCanaryPublishRequest({ pbxTenantId: "2", extension: "110", enable: bad as any, ts: "100" });
    assert.equal(parsed.ok, false, `expected rejection for enable=${JSON.stringify(bad)}`);
    if (!parsed.ok) assert.equal(parsed.error, "invalid_enable_value");
  }
});

test("rejects a non-digit or missing timestamp", () => {
  for (const bad of ["abc", "", "-100", "100.5", "1e9", null, 1780000000]) {
    const parsed = parseWakeCanaryPublishRequest({ pbxTenantId: "2", extension: "110", enable: "1", ts: bad as any });
    assert.equal(parsed.ok, false, `expected rejection for ts=${JSON.stringify(bad)}`);
    if (!parsed.ok) assert.equal(parsed.error, "invalid_timestamp");
  }
});

test("there is no family/key passthrough field — an arbitrary family can never be selected", () => {
  const parsed = parseWakeCanaryPublishRequest({
    pbxTenantId: "2",
    extension: "110",
    enable: "1",
    ts: "100",
    // Attempted injection: even if a caller adds extra fields, the parser never
    // reads or forwards them — only pbxTenantId/extension/enable/ts.
    family: "connect/system",
    key: "wake_grace_secs",
    value: "1",
  } as any);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.key, "T2_110");
    assert.deepEqual(Object.keys(parsed).sort(), ["enable", "extension", "key", "ok", "pbxTenantId", "ts"]);
  }
});

test("rejects missing body entirely", () => {
  const parsed = parseWakeCanaryPublishRequest(undefined);
  assert.equal(parsed.ok, false);
});

test("enable writes exactly the four owned families with correct values, value key first", () => {
  const parsed = parseWakeCanaryPublishRequest({ pbxTenantId: "2", extension: "110", enable: "1", ts: "1780000000" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const writes = buildWakeCanaryKeyWrites(parsed);
  assert.equal(writes.length, 4);
  assert.ok(writes.every((w) => w.op === "put"));
  assert.ok(writes.every((w) => w.key === "T2_110"));
  assert.deepEqual(writes.map((w) => w.family), [
    WAKE_CANARY_FAMILY,
    WAKE_CANARY_OWNER_FAMILY,
    WAKE_CANARY_SOURCE_FAMILY,
    WAKE_CANARY_UPDATED_FAMILY,
  ]);
  const byFamily = Object.fromEntries(writes.map((w) => [w.family, w.op === "put" ? w.value : null]));
  assert.equal(byFamily[WAKE_CANARY_FAMILY], "1");
  assert.equal(byFamily[WAKE_CANARY_OWNER_FAMILY], WAKE_CANARY_OWNER_VALUE);
  assert.equal(byFamily[WAKE_CANARY_SOURCE_FAMILY], WAKE_CANARY_SOURCE_VALUE);
  assert.equal(byFamily[WAKE_CANARY_UPDATED_FAMILY], "1780000000");
});

test("disable deletes exactly the four owned families, control key first", () => {
  const parsed = parseWakeCanaryPublishRequest({ pbxTenantId: "2", extension: "110", enable: "0", ts: "1780000000" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const writes = buildWakeCanaryKeyWrites(parsed);
  assert.equal(writes.length, 4);
  assert.ok(writes.every((w) => w.op === "del"));
  assert.equal(writes[0].family, WAKE_CANARY_FAMILY);
  assert.ok(writes.every((w) => w.key === "T2_110"));
});

test("every produced family is under the connect/wake_canary namespace (never touches another key space)", () => {
  const parsed = parseWakeCanaryPublishRequest({ pbxTenantId: "9", extension: "4321", enable: "1", ts: "1" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  for (const w of buildWakeCanaryKeyWrites(parsed)) {
    assert.ok(w.family.startsWith("connect/wake_canary"), `family ${w.family} escaped the wake_canary namespace`);
  }
});
