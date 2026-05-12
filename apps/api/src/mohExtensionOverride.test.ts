// Focused tests for the per-extension MOH override helpers (Phase 1).
//
// These tests cover only the pure helper layer — no DB hit, no Fastify, no
// AstDB. The publish wiring is intentionally absent in Phase 1, so there is
// nothing to integration-test here.

import test from "node:test";
import assert from "node:assert/strict";
import {
  MOH_EXTENSION_MAX_LENGTH,
  type MohExtensionOverrideApiRow,
  type MohExtensionOverridePrismaClient,
  type MohExtensionOverrideRow,
  assertExtensionExistsForTenant,
  buildExtensionOverrideKeys,
  buildExtensionOverrideSnapshot,
  canManageExtensionOverrideFor,
  computeExtensionKeysClearForRollback,
  deleteExtensionOverrideForTenant,
  extractExtensionSnapshotFromKeys,
  extensionActiveMohClassKey,
  extensionMohClassFamily,
  extensionMohClassKey,
  isValidExtension,
  listExtensionOverridesForTenant,
  normalizeExtension,
  readEnabledExtensionOverridesForTenant,
  upsertExtensionOverride,
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 helpers (API layer) — pure-function tests with a fake Prisma client.
// No Fastify spin-up; the route layer in `server.ts` is exercised by code
// review against the helper contracts validated below.
// ─────────────────────────────────────────────────────────────────────────────

// In-memory Prisma fake covering the surface used by Phase 2 helpers. Keyed
// by `${tenantId}::${extension}` so cross-tenant isolation is structurally
// enforced — same as the real DB unique index.
function makeFakePrisma(initialRows: MohExtensionOverrideApiRow[] = []) {
  const rows = new Map<string, MohExtensionOverrideApiRow>();
  for (const r of initialRows) rows.set(`${r.tenantId}::${r.extension}`, { ...r });
  const extensions: Array<{ id: string; tenantId: string; extNumber: string; status: string }> = [];

  return {
    rows,
    extensions,
    mohExtensionOverride: {
      async findMany(args: { where: { tenantId: string; enabled?: true }; orderBy: { extension: "asc" } }) {
        const out: MohExtensionOverrideApiRow[] = [];
        for (const r of rows.values()) {
          if (r.tenantId !== args.where.tenantId) continue;
          if (args.where.enabled === true && !r.enabled) continue;
          out.push({ ...r });
        }
        out.sort((a, b) => (a.extension < b.extension ? -1 : a.extension > b.extension ? 1 : 0));
        return out;
      },
      async findUnique(args: { where: { tenantId_extension: { tenantId: string; extension: string } } }) {
        const k = `${args.where.tenantId_extension.tenantId}::${args.where.tenantId_extension.extension}`;
        const r = rows.get(k);
        return r ? { ...r } : null;
      },
      async upsert(args: any) {
        const { tenantId, extension } = args.where.tenantId_extension as { tenantId: string; extension: string };
        const k = `${tenantId}::${extension}`;
        const existing = rows.get(k);
        const now = new Date();
        if (!existing) {
          const created: MohExtensionOverrideApiRow = {
            id: `cuid_${rows.size + 1}`,
            tenantId,
            extension,
            vitalPbxMohClassName: args.create.vitalPbxMohClassName,
            mohProfileId: args.create.mohProfileId,
            enabled: args.create.enabled,
            createdAt: now,
            updatedAt: now,
            createdBy: args.create.createdBy,
            updatedBy: args.create.updatedBy,
          };
          rows.set(k, created);
          return { ...created };
        }
        const updated: MohExtensionOverrideApiRow = {
          ...existing,
          vitalPbxMohClassName: args.update.vitalPbxMohClassName,
          mohProfileId: args.update.mohProfileId,
          enabled: args.update.enabled,
          updatedAt: now,
          updatedBy: args.update.updatedBy,
        };
        rows.set(k, updated);
        return { ...updated };
      },
      async deleteMany(args: { where: { tenantId: string; extension: string } }) {
        const k = `${args.where.tenantId}::${args.where.extension}`;
        const had = rows.delete(k);
        return { count: had ? 1 : 0 };
      },
    },
    extension: {
      async findFirst(args: { where: { tenantId: string; extNumber: string } }) {
        const hit = extensions.find(
          (e) => e.tenantId === args.where.tenantId && e.extNumber === args.where.extNumber,
        );
        return hit ? { ...hit } : null;
      },
    },
  };
}

// ── listExtensionOverridesForTenant ───────────────────────────────────────

test("listExtensionOverridesForTenant: returns ALL rows (enabled and disabled), sorted ASC", async () => {
  const fake = makeFakePrisma([
    {
      id: "x1", tenantId: "A", extension: "104", vitalPbxMohClassName: "moh4",
      mohProfileId: null, enabled: true, createdAt: new Date(), updatedAt: new Date(),
      createdBy: null, updatedBy: null,
    },
    {
      id: "x2", tenantId: "A", extension: "101", vitalPbxMohClassName: "moh1",
      mohProfileId: null, enabled: false, createdAt: new Date(), updatedAt: new Date(),
      createdBy: null, updatedBy: null,
    },
    {
      id: "x3", tenantId: "B", extension: "101", vitalPbxMohClassName: "moh9",
      mohProfileId: null, enabled: true, createdAt: new Date(), updatedAt: new Date(),
      createdBy: null, updatedBy: null,
    },
  ]);
  const out = await listExtensionOverridesForTenant(fake as any, "A");
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.extension), ["101", "104"]);
  assert.deepEqual(out.map((r) => r.enabled), [false, true]);
});

test("listExtensionOverridesForTenant: empty/invalid tenantId returns []", async () => {
  const fake = makeFakePrisma();
  assert.deepEqual(await listExtensionOverridesForTenant(fake as any, ""), []);
  assert.deepEqual(await listExtensionOverridesForTenant(fake as any, undefined as unknown as string), []);
});

// ── upsertExtensionOverride ───────────────────────────────────────────────

test("upsertExtensionOverride: creates new on first call, updates on second; returns `created` flag", async () => {
  const fake = makeFakePrisma();
  const r1 = await upsertExtensionOverride(fake as any, {
    tenantId: "A", extension: "101", vitalPbxMohClassName: "moh1", actorUserId: "u1",
  });
  assert.equal(r1.created, true);
  assert.equal(r1.override.extension, "101");
  assert.equal(r1.override.vitalPbxMohClassName, "moh1");
  assert.equal(r1.override.enabled, true);
  assert.equal(r1.override.createdBy, "u1");

  const r2 = await upsertExtensionOverride(fake as any, {
    tenantId: "A", extension: "101", vitalPbxMohClassName: "moh2", enabled: false, actorUserId: "u2",
  });
  assert.equal(r2.created, false);
  assert.equal(r2.override.id, r1.override.id);
  assert.equal(r2.override.vitalPbxMohClassName, "moh2");
  assert.equal(r2.override.enabled, false);
  assert.equal(r2.override.updatedBy, "u2");
});

test("upsertExtensionOverride: rejects invalid tenant / extension / class shape", async () => {
  const fake = makeFakePrisma();
  await assert.rejects(
    () => upsertExtensionOverride(fake as any, { tenantId: "", extension: "101", vitalPbxMohClassName: "moh1" }),
    /invalid_tenant/,
  );
  await assert.rejects(
    () => upsertExtensionOverride(fake as any, { tenantId: "A", extension: "a/b", vitalPbxMohClassName: "moh1" }),
    /invalid_extension/,
  );
  await assert.rejects(
    () => upsertExtensionOverride(fake as any, { tenantId: "A", extension: "101", vitalPbxMohClassName: "" }),
    /invalid_moh_runtime_class/,
  );
});

// ── Cross-tenant isolation ────────────────────────────────────────────────

test("cross-tenant isolation: same extension on tenant A and tenant B does NOT collide", async () => {
  const fake = makeFakePrisma();
  await upsertExtensionOverride(fake as any, {
    tenantId: "A", extension: "101", vitalPbxMohClassName: "mohA",
  });
  await upsertExtensionOverride(fake as any, {
    tenantId: "B", extension: "101", vitalPbxMohClassName: "mohB",
  });
  const aRows = await listExtensionOverridesForTenant(fake as any, "A");
  const bRows = await listExtensionOverridesForTenant(fake as any, "B");
  assert.equal(aRows.length, 1);
  assert.equal(bRows.length, 1);
  assert.equal(aRows[0].vitalPbxMohClassName, "mohA");
  assert.equal(bRows[0].vitalPbxMohClassName, "mohB");
  assert.notEqual(aRows[0].id, bRows[0].id);
});

// ── deleteExtensionOverrideForTenant ──────────────────────────────────────

test("deleteExtensionOverrideForTenant: deletes only the matching (tenantId, extension) pair", async () => {
  const fake = makeFakePrisma();
  await upsertExtensionOverride(fake as any, { tenantId: "A", extension: "101", vitalPbxMohClassName: "mohA" });
  await upsertExtensionOverride(fake as any, { tenantId: "B", extension: "101", vitalPbxMohClassName: "mohB" });

  const r = await deleteExtensionOverrideForTenant(fake as any, "A", "101");
  assert.equal(r.deleted, 1);
  assert.equal((await listExtensionOverridesForTenant(fake as any, "A")).length, 0);
  assert.equal((await listExtensionOverridesForTenant(fake as any, "B")).length, 1, "tenant B's row must survive");
});

test("deleteExtensionOverrideForTenant: idempotent miss returns deleted=0", async () => {
  const fake = makeFakePrisma();
  const r = await deleteExtensionOverrideForTenant(fake as any, "A", "999");
  assert.equal(r.deleted, 0);
});

test("deleteExtensionOverrideForTenant: rejects invalid tenant / extension shape", async () => {
  const fake = makeFakePrisma();
  await assert.rejects(
    () => deleteExtensionOverrideForTenant(fake as any, "", "101"),
    /invalid_tenant/,
  );
  await assert.rejects(
    () => deleteExtensionOverrideForTenant(fake as any, "A", "a/b"),
    /invalid_extension/,
  );
});

// ── assertExtensionExistsForTenant ────────────────────────────────────────

test("assertExtensionExistsForTenant: rejects when no Extension row matches", async () => {
  const fake = makeFakePrisma();
  fake.extensions.push({ id: "e1", tenantId: "A", extNumber: "101", status: "ACTIVE" });
  await assert.rejects(
    () => assertExtensionExistsForTenant(fake as any, "A", "999"),
    /extension_not_found/,
  );
  // Same extNumber but different tenant must not satisfy.
  await assert.rejects(
    () => assertExtensionExistsForTenant(fake as any, "B", "101"),
    /extension_not_found/,
  );
});

test("assertExtensionExistsForTenant: rejects DELETED extension as 'not found'", async () => {
  const fake = makeFakePrisma();
  fake.extensions.push({ id: "e1", tenantId: "A", extNumber: "101", status: "DELETED" });
  await assert.rejects(
    () => assertExtensionExistsForTenant(fake as any, "A", "101"),
    /extension_not_found/,
  );
});

test("assertExtensionExistsForTenant: ACTIVE and SUSPENDED both pass", async () => {
  const fake = makeFakePrisma();
  fake.extensions.push({ id: "e1", tenantId: "A", extNumber: "101", status: "ACTIVE" });
  fake.extensions.push({ id: "e2", tenantId: "A", extNumber: "102", status: "SUSPENDED" });
  await assertExtensionExistsForTenant(fake as any, "A", "101");
  await assertExtensionExistsForTenant(fake as any, "A", "102");
});

// ── canManageExtensionOverrideFor ─────────────────────────────────────────

test("canManageExtensionOverrideFor: SUPER_ADMIN can manage any tenant", () => {
  assert.equal(canManageExtensionOverrideFor({ role: "SUPER_ADMIN", tenantId: "A" }, "B"), true);
  assert.equal(canManageExtensionOverrideFor({ role: "super_admin", tenantId: null }, "B"), true);
});

test("canManageExtensionOverrideFor: ADMIN limited to own tenant", () => {
  assert.equal(canManageExtensionOverrideFor({ role: "ADMIN", tenantId: "A" }, "A"), true);
  assert.equal(canManageExtensionOverrideFor({ role: "ADMIN", tenantId: "A" }, "B"), false);
  assert.equal(canManageExtensionOverrideFor({ role: "ADMIN", tenantId: null }, "A"), false);
});

test("canManageExtensionOverrideFor: lower roles always denied", () => {
  for (const role of ["USER", "READ_ONLY", "MANAGER", "BILLING", "MESSAGING", "TENANT_ADMIN", "", null, undefined]) {
    assert.equal(
      canManageExtensionOverrideFor({ role: role as any, tenantId: "A" }, "A"),
      false,
      `role=${String(role)} must be denied (mirrors canManageMoh = SUPER_ADMIN | ADMIN)`,
    );
  }
});

// ── disabled-row leak guard ───────────────────────────────────────────────

test("disabled override is visible to the API list but NOT to the publish read", async () => {
  const fake = makeFakePrisma();
  await upsertExtensionOverride(fake as any, { tenantId: "A", extension: "101", vitalPbxMohClassName: "moh1" });
  await upsertExtensionOverride(fake as any, { tenantId: "A", extension: "102", vitalPbxMohClassName: "moh2", enabled: false });

  const apiRows = await listExtensionOverridesForTenant(fake as any, "A");
  assert.equal(apiRows.length, 2);

  const publishRows = await readEnabledExtensionOverridesForTenant(fake as any, "A");
  assert.equal(publishRows.length, 1);
  assert.equal(publishRows[0].extension, "101");
});

// ── buildExtensionOverrideKeys ────────────────────────────────────────────

test("buildExtensionOverrideKeys: emits {moh_class, active_moh_class} per enabled row, sorted by family", () => {
  const rows: MohExtensionOverrideRow[] = [
    { extension: "104", vitalPbxMohClassName: "moh4", enabled: true },
    { extension: "101", vitalPbxMohClassName: "moh1", enabled: true },
  ];
  const keys = buildExtensionOverrideKeys("secro_selution", rows);
  assert.deepEqual(keys, [
    { family: "connect/t_secro_selution/extensions/101", key: "active_moh_class", value: "moh1" },
    { family: "connect/t_secro_selution/extensions/101", key: "moh_class",        value: "moh1" },
    { family: "connect/t_secro_selution/extensions/104", key: "active_moh_class", value: "moh4" },
    { family: "connect/t_secro_selution/extensions/104", key: "moh_class",        value: "moh4" },
  ]);
});

test("buildExtensionOverrideKeys: drops disabled rows, invalid extensions, and empty class", () => {
  const rows: MohExtensionOverrideRow[] = [
    { extension: "101", vitalPbxMohClassName: "moh1", enabled: true },
    { extension: "102", vitalPbxMohClassName: "moh2", enabled: false }, // disabled
    { extension: "a/b", vitalPbxMohClassName: "moh3", enabled: true },  // invalid
    { extension: "104", vitalPbxMohClassName: "  ",   enabled: true },  // empty class
    { extension: "105", vitalPbxMohClassName: "moh5", enabled: true },
  ];
  const keys = buildExtensionOverrideKeys("slug", rows);
  // 2 rows × 2 keys = 4 entries
  assert.equal(keys.length, 4);
  const exts = new Set(keys.map((k) => k.family.split("/").pop()));
  assert.deepEqual([...exts].sort(), ["101", "105"]);
});

test("buildExtensionOverrideKeys: empty input -> [] (no slug validation runs against empty list)", () => {
  assert.deepEqual(buildExtensionOverrideKeys("slug", []), []);
});

test("buildExtensionOverrideKeys: rejects invalid slug as defense-in-depth", () => {
  assert.throws(
    () => buildExtensionOverrideKeys("a/b", [{ extension: "101", vitalPbxMohClassName: "m", enabled: true }]),
    /invalid tenant slug/,
  );
});

// ── extractExtensionSnapshotFromKeys ──────────────────────────────────────

test("extractExtensionSnapshotFromKeys: reads only moh_class entries under per-extension family", () => {
  const keys = [
    { family: "connect/t_slug",                          key: "active_moh_class", value: "default" },
    { family: "connect/t_slug",                          key: "moh_class",        value: "default" },
    { family: "connect/t_slug/extensions/101",           key: "moh_class",        value: "moh1" },
    { family: "connect/t_slug/extensions/101",           key: "active_moh_class", value: "moh1" },
    { family: "connect/t_slug/extensions/102",           key: "moh_class",        value: "moh2" },
    { family: "connect/t_slug/extensions/102",           key: "active_moh_class", value: "moh2" },
  ];
  assert.deepEqual(extractExtensionSnapshotFromKeys(keys), [
    { extension: "101", vitalPbxMohClassName: "moh1" },
    { extension: "102", vitalPbxMohClassName: "moh2" },
  ]);
});

test("extractExtensionSnapshotFromKeys: empty-string values (tombstones) are excluded", () => {
  const keys = [
    { family: "connect/t_slug/extensions/101", key: "moh_class",        value: "" },
    { family: "connect/t_slug/extensions/101", key: "active_moh_class", value: "" },
    { family: "connect/t_slug/extensions/102", key: "moh_class",        value: "moh2" },
  ];
  assert.deepEqual(extractExtensionSnapshotFromKeys(keys), [
    { extension: "102", vitalPbxMohClassName: "moh2" },
  ]);
});

test("extractExtensionSnapshotFromKeys: ignores non-matching families and malformed entries", () => {
  const keys = [
    { family: "connect/t_slug/inboundroutes/8005551212", key: "moh_class", value: "x" }, // wrong family
    { family: "random/garbage",                          key: "moh_class", value: "y" },
    { family: "connect/t_slug/extensions/101",           key: "moh_class", value: "ok" },
  ];
  assert.deepEqual(extractExtensionSnapshotFromKeys(keys as any), [
    { extension: "101", vitalPbxMohClassName: "ok" },
  ]);
});

// ── computeExtensionKeysClearForRollback ──────────────────────────────────

test("computeExtensionKeysClearForRollback: clears keys ADDED by target publish and missing from prev", () => {
  const targetKeys = [
    // tenant defaults — must NOT be cleared (not under per-extension family)
    { family: "connect/t_slug", key: "moh_class",        value: "default" },
    { family: "connect/t_slug", key: "active_moh_class", value: "default" },
    // per-extension keys that target publish wrote
    { family: "connect/t_slug/extensions/101", key: "moh_class",        value: "moh1" },
    { family: "connect/t_slug/extensions/101", key: "active_moh_class", value: "moh1" },
    { family: "connect/t_slug/extensions/102", key: "moh_class",        value: "moh2" },
    { family: "connect/t_slug/extensions/102", key: "active_moh_class", value: "moh2" },
  ];
  const prevKeys = [
    { family: "connect/t_slug", key: "moh_class",        value: "old" },
    { family: "connect/t_slug", key: "active_moh_class", value: "old" },
    // 101 already existed before, so target did not "add" it — no clear
    { family: "connect/t_slug/extensions/101", key: "moh_class",        value: "older1" },
    { family: "connect/t_slug/extensions/101", key: "active_moh_class", value: "older1" },
  ];
  const out = computeExtensionKeysClearForRollback(targetKeys, prevKeys);
  assert.deepEqual(out, [
    { family: "connect/t_slug/extensions/102", key: "active_moh_class", value: "" },
    { family: "connect/t_slug/extensions/102", key: "moh_class",        value: "" },
  ]);
});

test("computeExtensionKeysClearForRollback: when target adds nothing under per-extension family -> []", () => {
  const targetKeys = [
    { family: "connect/t_slug", key: "moh_class",        value: "x" },
    { family: "connect/t_slug", key: "active_moh_class", value: "x" },
  ];
  const prevKeys = [
    { family: "connect/t_slug", key: "moh_class",        value: "y" },
    { family: "connect/t_slug", key: "active_moh_class", value: "y" },
  ];
  assert.deepEqual(computeExtensionKeysClearForRollback(targetKeys, prevKeys), []);
});

test("computeExtensionKeysClearForRollback: dedupes identical (family,key) entries from target", () => {
  const targetKeys = [
    { family: "connect/t_slug/extensions/101", key: "moh_class", value: "a" },
    { family: "connect/t_slug/extensions/101", key: "moh_class", value: "a" },
  ];
  const out = computeExtensionKeysClearForRollback(targetKeys, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].value, "");
});

test("computeExtensionKeysClearForRollback: ignores non-extension families even if absent from prev", () => {
  const targetKeys = [
    { family: "connect/t_slug",                          key: "moh_class", value: "x" },
    { family: "connect/t_slug/inboundroutes/8005551212", key: "moh_class", value: "x" },
    { family: "connect/pbx_tenant_map/42",               key: "moh_class", value: "x" },
  ];
  assert.deepEqual(computeExtensionKeysClearForRollback(targetKeys, []), []);
});

// ── round-trip: build → extract recovers the original snapshot shape ──────

test("round-trip: buildExtensionOverrideKeys → extractExtensionSnapshotFromKeys recovers snapshot", () => {
  const rows: MohExtensionOverrideRow[] = [
    { extension: "101", vitalPbxMohClassName: "moh1", enabled: true },
    { extension: "104", vitalPbxMohClassName: "moh4", enabled: true },
    { extension: "102", vitalPbxMohClassName: "",     enabled: true }, // dropped
  ];
  const keys = buildExtensionOverrideKeys("slug", rows);
  const recovered = extractExtensionSnapshotFromKeys(keys);
  assert.deepEqual(recovered, buildExtensionOverrideSnapshot(rows));
});
