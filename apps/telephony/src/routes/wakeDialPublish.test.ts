import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWakeDialPublishRequest,
  transformDialValue,
  isValidTenantHash,
  discoverDialKeyFamily,
  WAKE_DIAL_CONTEXT,
  DIAL_DISCOVERY_CLI,
} from "./wakeDialPublish";

// Real `database showkey dial` output shape captured from the live PBX
// 2026-08-05 (values abridged; padding + trailing "N results found." intact).
const SHOWKEY_SAMPLE = [
  "/106048d48cb4ddf6/extensions/101/dial             : PJSIP/T8_101&PJSIP/T8_101_1",
  "/95bd6bbfdf7183fe/extensions/101/dial             : PJSIP/T101_101&PJSIP/T101_101_1",
  "/9b501d62d63478a9/extensions/101/dial             : PJSIP/T102_101&Local/T102_101_1@connect-mobile-wake-dial/n",
  "/d463ec01a34f6dad/extensions/108/dial             : PJSIP/T11_108_1          ",
  "/da5327df4a24f3a8/extensions/101/dial             : PJSIP/T5_101&Local/T5_101_1@connect-mobile-wake-dial/n",
  "/f3df739ac62197cd/extensions/103/dial             : PJSIP/T2_103&PJSIP/T2_103_1",
  "/fcab1cd3482527c3/extensions/101/dial             : PJSIP/T25_101&PJSIP/T25_101_1&Local/8455129339@T25_cos-all",
  "120 results found.",
].join("\n");

// ── Request parsing ─────────────────────────────────────────────────────────

test("accepts a well-formed enable request and derives the mobile endpoint", () => {
  const parsed = parseWakeDialPublishRequest({ pbxTenantId: "5", extension: "101", enable: "1" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.mobileEndpoint, "T5_101_1");
    assert.equal(parsed.enable, "1");
  }
});

test("accepts enable='0' (disable) identically", () => {
  const parsed = parseWakeDialPublishRequest({ pbxTenantId: "102", extension: "101", enable: "0" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.mobileEndpoint, "T102_101_1");
});

test("rejects non-numeric tenant id, extension, and bad enable values", () => {
  assert.deepEqual(parseWakeDialPublishRequest({ pbxTenantId: "5x", extension: "101", enable: "1" }), {
    ok: false,
    error: "invalid_pbx_tenant_id",
  });
  assert.deepEqual(parseWakeDialPublishRequest({ pbxTenantId: "5", extension: "../101", enable: "1" }), {
    ok: false,
    error: "invalid_extension",
  });
  assert.deepEqual(parseWakeDialPublishRequest({ pbxTenantId: "5", extension: "101", enable: "yes" }), {
    ok: false,
    error: "invalid_enable_value",
  });
  assert.deepEqual(parseWakeDialPublishRequest(undefined), { ok: false, error: "invalid_pbx_tenant_id" });
});

// ── Tenant hash validation ──────────────────────────────────────────────────

test("accepts real observed tenant hashes, rejects junk", () => {
  assert.equal(isValidTenantHash("da5327df4a24f3a8"), true);
  assert.equal(isValidTenantHash("9b501d62d63478a9"), true);
  assert.equal(isValidTenantHash(""), false);
  assert.equal(isValidTenantHash("DA5327DF4A24F3A8"), false); // uppercase — not observed, refuse
  assert.equal(isValidTenantHash("connect/system"), false);
  assert.equal(isValidTenantHash("../../etc"), false);
  assert.equal(isValidTenantHash(42), false);
});

// ── Dial transform: enable ──────────────────────────────────────────────────

test("enable rewrites only the mobile leg, preserving the desk leg (Simon's exact shape)", () => {
  const r = transformDialValue("PJSIP/T5_101&PJSIP/T5_101_1", "T5_101_1", "1");
  assert.deepEqual(r, {
    ok: true,
    changed: true,
    value: `PJSIP/T5_101&Local/T5_101_1@${WAKE_DIAL_CONTEXT}/n`,
  });
});

test("enable preserves a trailing cell-forward leg (T25_101's 3-leg shape)", () => {
  const r = transformDialValue(
    "PJSIP/T25_101&PJSIP/T25_101_1&Local/8455129339@T25_cos-all",
    "T25_101_1",
    "1",
  );
  assert.deepEqual(r, {
    ok: true,
    changed: true,
    value: `PJSIP/T25_101&Local/T25_101_1@${WAKE_DIAL_CONTEXT}/n&Local/8455129339@T25_cos-all`,
  });
});

test("enable handles a mobile-only extension (T11_108's single-leg shape)", () => {
  const r = transformDialValue("PJSIP/T11_108_1", "T11_108_1", "1");
  assert.deepEqual(r, {
    ok: true,
    changed: true,
    value: `Local/T11_108_1@${WAKE_DIAL_CONTEXT}/n`,
  });
});

test("enable is idempotent: already-enrolled value returns changed=false, byte-identical", () => {
  const enrolled = `PJSIP/T5_101&Local/T5_101_1@${WAKE_DIAL_CONTEXT}/n`;
  const r = transformDialValue(enrolled, "T5_101_1", "1");
  assert.deepEqual(r, { ok: true, changed: false, value: enrolled });
});

test("enable does NOT touch a base-endpoint leg that merely shares the prefix", () => {
  // T5_101 vs T5_101_1 — exact token match only. Also T5_101_11 must survive.
  const r = transformDialValue("PJSIP/T5_101&PJSIP/T5_101_11", "T5_101_1", "1");
  assert.deepEqual(r, { ok: false, error: "no_mobile_leg" });
});

// ── Dial transform: disable (rollback) ──────────────────────────────────────

test("disable restores the original PJSIP leg exactly", () => {
  const r = transformDialValue(
    `PJSIP/T5_101&Local/T5_101_1@${WAKE_DIAL_CONTEXT}/n`,
    "T5_101_1",
    "0",
  );
  assert.deepEqual(r, { ok: true, changed: true, value: "PJSIP/T5_101&PJSIP/T5_101_1" });
});

test("disable is idempotent on a never-enrolled value", () => {
  const r = transformDialValue("PJSIP/T5_101&PJSIP/T5_101_1", "T5_101_1", "0");
  assert.deepEqual(r, { ok: true, changed: false, value: "PJSIP/T5_101&PJSIP/T5_101_1" });
});

// ── Fail-closed behaviour ───────────────────────────────────────────────────

test("refuses an empty dial value", () => {
  assert.deepEqual(transformDialValue("", "T5_101_1", "1"), { ok: false, error: "empty_dial_value" });
  assert.deepEqual(transformDialValue("   ", "T5_101_1", "1"), { ok: false, error: "empty_dial_value" });
});

test("refuses a dial string with no mobile leg (desk-only extension)", () => {
  assert.deepEqual(transformDialValue("PJSIP/T8_103", "T8_103_1", "1"), {
    ok: false,
    error: "no_mobile_leg",
  });
});

test("refuses a dial string containing an unexpected leg charset without modifying anything", () => {
  const r = transformDialValue("PJSIP/T5_101_1&Local/x@y/n,30,tT", "T5_101_1", "1");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "unexpected_dial_value");
});

test("collapses a both-forms value down to a single enrolled leg", () => {
  const r = transformDialValue(
    `PJSIP/T5_101_1&Local/T5_101_1@${WAKE_DIAL_CONTEXT}/n`,
    "T5_101_1",
    "1",
  );
  assert.deepEqual(r, {
    ok: true,
    changed: true,
    value: `Local/T5_101_1@${WAKE_DIAL_CONTEXT}/n`,
  });
});

test("constants match the live PBX artifacts", () => {
  assert.equal(WAKE_DIAL_CONTEXT, "connect-mobile-wake-dial");
  assert.equal(DIAL_DISCOVERY_CLI, "database showkey dial");
});

// ── Tenant-family discovery from showkey output ─────────────────────────────

test("discovery finds the right family among many tenants sharing ext 101", () => {
  const r = discoverDialKeyFamily(SHOWKEY_SAMPLE, "101", "T25_101_1");
  assert.deepEqual(r, {
    ok: true,
    tenantHash: "fcab1cd3482527c3",
    family: "fcab1cd3482527c3/extensions/101",
  });
});

test("discovery matches an already-enrolled extension by its Local form", () => {
  const r = discoverDialKeyFamily(SHOWKEY_SAMPLE, "101", "T5_101_1");
  assert.deepEqual(r, {
    ok: true,
    tenantHash: "da5327df4a24f3a8",
    family: "da5327df4a24f3a8/extensions/101",
  });
});

test("discovery handles a mobile-only single-leg key with trailing CLI padding", () => {
  const r = discoverDialKeyFamily(SHOWKEY_SAMPLE, "108", "T11_108_1");
  assert.deepEqual(r, {
    ok: true,
    tenantHash: "d463ec01a34f6dad",
    family: "d463ec01a34f6dad/extensions/108",
  });
});

test("discovery fails closed when no line carries the mobile token", () => {
  // T34_101 exists as an extension in real data but has no _1 leg anywhere.
  const r = discoverDialKeyFamily(SHOWKEY_SAMPLE, "101", "T34_101_1");
  assert.deepEqual(r, { ok: false, error: "extension_not_enrollable" });
});

test("discovery fails closed on duplicate matches", () => {
  const dup = SHOWKEY_SAMPLE + "\n/aaaabbbbccccdddd/extensions/103/dial : PJSIP/T2_103_1";
  const r = discoverDialKeyFamily(dup, "103", "T2_103_1");
  assert.deepEqual(r, { ok: false, error: "ambiguous_extension" });
});

test("discovery ignores the trailing results-count line and empty output", () => {
  assert.deepEqual(discoverDialKeyFamily("0 results found.", "101", "T5_101_1"), {
    ok: false,
    error: "extension_not_enrollable",
  });
  assert.deepEqual(discoverDialKeyFamily("", "101", "T5_101_1"), {
    ok: false,
    error: "extension_not_enrollable",
  });
});
