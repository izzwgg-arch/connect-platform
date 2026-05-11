// Focused tests for the per-extension MOH override helpers (Phase 1).
//
// These tests cover only the pure helper layer — no DB hit, no Fastify, no
// AstDB. The publish wiring is intentionally absent in Phase 1, so there is
// nothing to integration-test here.

import test from "node:test";
import assert from "node:assert/strict";
import {
  MOH_EXTENSION_MAX_LENGTH,
  type MohExtensionOverridePrismaClient,
  type MohExtensionOverrideRow,
  buildExtensionOverrideSnapshot,
  extensionActiveMohClassKey,
  extensionMohClassFamily,
  extensionMohClassKey,
  isValidExtension,
  normalizeExtension,
  readEnabledExtensionOverridesForTenant,
} from "./mohExtensionOverride";

// ── normalizeExtension / isValidExtension ─────────────────────────────────

test("normalizeExtension: trims surrounding whitespace and accepts digits/letters/_-", () => {
  assert.equal(normalizeExtension("  101  "), "101");
  assert.equal(normalizeExtension("T3_101"), "T3_101");
  assert.equal(normalizeExtension("ext-7"), "ext-7");
  assert.equal(normalizeExtension("a_b-1"), "a_b-1");
});

test("normalizeExtension: rejects empty/whitespace and non-string", () => {
  assert.equal(normalizeExtension(""), null);
  assert.equal(normalizeExtension("   "), null);
  assert.equal(normalizeExtension(undefined), null);
  assert.equal(normalizeExtension(null), null);
  assert.equal(normalizeExtension(101 as unknown as string), null);
});

test("normalizeExtension: rejects path separators and dots and embedded whitespace", () => {
  assert.equal(normalizeExtension("a/b"), null);
  assert.equal(normalizeExtension("a.b"), null);
  assert.equal(normalizeExtension("a b"), null);
  assert.equal(normalizeExtension("a\tb"), null);
  assert.equal(normalizeExtension(".."), null);
  assert.equal(normalizeExtension("../etc"), null);
});

test("normalizeExtension: enforces max length", () => {
  const at = "a".repeat(MOH_EXTENSION_MAX_LENGTH);
  const over = "a".repeat(MOH_EXTENSION_MAX_LENGTH + 1);
  assert.equal(normalizeExtension(at), at);
  assert.equal(normalizeExtension(over), null);
});

test("isValidExtension mirrors normalizeExtension as a predicate", () => {
  assert.equal(isValidExtension("101"), true);
  assert.equal(isValidExtension(""), false);
  assert.equal(isValidExtension("a/b"), false);
});

// ── AstDB key generation ──────────────────────────────────────────────────

test("extensionMohClassFamily: builds connect/t_<slug>/extensions/<ext>", () => {
  assert.equal(
    extensionMohClassFamily("secro_selution", "101"),
    "connect/t_secro_selution/extensions/101",
  );
  assert.equal(
    extensionMohClassFamily("landau-home", "ext-7"),
    "connect/t_landau-home/extensions/ext-7",
  );
});

test("extensionMohClassKey + extensionActiveMohClassKey: full key paths", () => {
  assert.equal(
    extensionMohClassKey("secro_selution", "101"),
    "connect/t_secro_selution/extensions/101/moh_class",
  );
  assert.equal(
    extensionActiveMohClassKey("secro_selution", "101"),
    "connect/t_secro_selution/extensions/101/active_moh_class",
  );
});

test("key builders refuse invalid slug or extension (defense-in-depth)", () => {
  assert.throws(() => extensionMohClassKey("", "101"), /invalid tenant slug/);
  assert.throws(() => extensionMohClassKey("a/b", "101"), /invalid tenant slug/);
  assert.throws(() => extensionMohClassKey("slug", ""), /invalid extension/);
  assert.throws(() => extensionMohClassKey("slug", "a/b"), /invalid extension/);
  assert.throws(() => extensionActiveMohClassKey("slug", ".."), /invalid extension/);
});

// ── buildExtensionOverrideSnapshot ────────────────────────────────────────

test("buildExtensionOverrideSnapshot: filters disabled rows and sorts by extension", () => {
  const rows: MohExtensionOverrideRow[] = [
    { extension: "104", vitalPbxMohClassName: "moh4", enabled: true },
    { extension: "101", vitalPbxMohClassName: "moh1", enabled: true },
    { extension: "102", vitalPbxMohClassName: "moh2", enabled: false },
    { extension: "103", vitalPbxMohClassName: "moh3", enabled: true },
  ];
  assert.deepEqual(buildExtensionOverrideSnapshot(rows), [
    { extension: "101", vitalPbxMohClassName: "moh1" },
    { extension: "103", vitalPbxMohClassName: "moh3" },
    { extension: "104", vitalPbxMohClassName: "moh4" },
  ]);
});

test("buildExtensionOverrideSnapshot: drops rows with invalid extension or empty class", () => {
  const rows: MohExtensionOverrideRow[] = [
    { extension: "101", vitalPbxMohClassName: "moh1", enabled: true },
    { extension: "a/b", vitalPbxMohClassName: "moh2", enabled: true }, // invalid ext
    { extension: "102", vitalPbxMohClassName: "", enabled: true }, // empty class
    { extension: "103", vitalPbxMohClassName: "moh3", enabled: true },
  ];
  assert.deepEqual(buildExtensionOverrideSnapshot(rows), [
    { extension: "101", vitalPbxMohClassName: "moh1" },
    { extension: "103", vitalPbxMohClassName: "moh3" },
  ]);
});

test("buildExtensionOverrideSnapshot: empty input -> empty array", () => {
  assert.deepEqual(buildExtensionOverrideSnapshot([]), []);
});

// ── readEnabledExtensionOverridesForTenant ────────────────────────────────

test("readEnabledExtensionOverridesForTenant: scopes by tenantId and enabled=true with deterministic order", async () => {
  const captured: { args?: unknown } = {};
  const fakePrisma: MohExtensionOverridePrismaClient = {
    mohExtensionOverride: {
      async findMany(args) {
        captured.args = args;
        return [
          { extension: "101", vitalPbxMohClassName: "moh1", enabled: true },
          { extension: "103", vitalPbxMohClassName: "moh3", enabled: true },
        ];
      },
    },
  };
  const out = await readEnabledExtensionOverridesForTenant(fakePrisma, "tnt_abc");
  assert.deepEqual(out, [
    { extension: "101", vitalPbxMohClassName: "moh1", enabled: true },
    { extension: "103", vitalPbxMohClassName: "moh3", enabled: true },
  ]);
  assert.deepEqual(captured.args, {
    where: { tenantId: "tnt_abc", enabled: true },
    orderBy: { extension: "asc" },
    select: { extension: true, vitalPbxMohClassName: true, enabled: true },
  });
});

test("readEnabledExtensionOverridesForTenant: empty/invalid tenantId returns [] without DB call", async () => {
  let called = false;
  const fakePrisma: MohExtensionOverridePrismaClient = {
    mohExtensionOverride: {
      async findMany() {
        called = true;
        return [];
      },
    },
  };
  assert.deepEqual(await readEnabledExtensionOverridesForTenant(fakePrisma, ""), []);
  assert.deepEqual(
    await readEnabledExtensionOverridesForTenant(fakePrisma, undefined as unknown as string),
    [],
  );
  assert.equal(called, false);
});

// ── tenant + extension uniqueness assumption probe ────────────────────────
// The DB-level unique key is (tenantId, extension). This test is a
// design-doc-as-code: if a future caller tries to express two rows for the
// same (tenant, extension) pair, the snapshot builder must collapse safely.
// We document the expectation here; the actual de-dupe responsibility lives
// in the API write layer (Phase 2). The snapshot builder, by virtue of the
// underlying unique constraint, will never see duplicates from a correct DB,
// so we just assert the shape passes through unchanged when given unique input.

test("uniqueness assumption: snapshot is byte-stable across reordered identical input", () => {
  const a: MohExtensionOverrideRow[] = [
    { extension: "101", vitalPbxMohClassName: "moh1", enabled: true },
    { extension: "102", vitalPbxMohClassName: "moh2", enabled: true },
  ];
  const b: MohExtensionOverrideRow[] = [
    { extension: "102", vitalPbxMohClassName: "moh2", enabled: true },
    { extension: "101", vitalPbxMohClassName: "moh1", enabled: true },
  ];
  assert.deepEqual(buildExtensionOverrideSnapshot(a), buildExtensionOverrideSnapshot(b));
});
