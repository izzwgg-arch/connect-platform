// Tests for pbxTenantDirectorySync — focused on create vs update counts.
// These tests use a minimal in-memory mock of PrismaClient.upsert and findUnique.
// No server, no VitalPBX, no migrations required.

import test from "node:test";
import assert from "node:assert/strict";
import { deriveTenantCode, syncPbxTenantDirectoryFromRows } from "./pbxTenantDirectorySync";

// ── deriveTenantCode ──────────────────────────────────────────────────────────

test("deriveTenantCode: returns slug as-is when it already looks like T<n>", () => {
  assert.equal(deriveTenantCode("8", "T8"), "T8");
  assert.equal(deriveTenantCode("3", "T3"), "T3");
});

test("deriveTenantCode: derives T<n> from vitalTenantId when slug is a plain name", () => {
  assert.equal(deriveTenantCode("21", "landau_home"), "T21");
  assert.equal(deriveTenantCode("3", "secro_selution"), "T3");
});

test("deriveTenantCode: falls back to uppercase slug when vitalTenantId is empty", () => {
  assert.equal(deriveTenantCode("", "gesheft"), "GESHEFT");
});

// ── syncPbxTenantDirectoryFromRows ───────────────────────────────────────────

function makeMockDb(existingIds: Set<string>) {
  const upsertCalls: unknown[] = [];
  const db = {
    pbxTenantDirectory: {
      findUnique: async ({ where }: any) => {
        const key = `${where.pbxInstanceId_vitalTenantId.pbxInstanceId}:${where.pbxInstanceId_vitalTenantId.vitalTenantId}`;
        return existingIds.has(key) ? { id: key } : null;
      },
      upsert: async (args: unknown) => {
        upsertCalls.push(args);
        return {};
      },
    },
    _upsertCalls: upsertCalls,
  };
  return db as any;
}

test("syncPbxTenantDirectoryFromRows: all new tenants → created = upserted, updated = 0", async () => {
  const db = makeMockDb(new Set());
  const tenants = [
    { tenant_id: "1", name: "alpha", description: "Alpha Corp" },
    { tenant_id: "2", name: "beta" },
  ];
  const result = await syncPbxTenantDirectoryFromRows(db, "inst1", tenants);
  assert.equal(result.upserted, 2);
  assert.equal(result.created, 2);
  assert.equal(result.updated, 0);
});

test("syncPbxTenantDirectoryFromRows: all existing tenants → updated = upserted, created = 0", async () => {
  const db = makeMockDb(new Set(["inst1:1", "inst1:2"]));
  const tenants = [
    { tenant_id: "1", name: "alpha" },
    { tenant_id: "2", name: "beta" },
  ];
  const result = await syncPbxTenantDirectoryFromRows(db, "inst1", tenants);
  assert.equal(result.upserted, 2);
  assert.equal(result.created, 0);
  assert.equal(result.updated, 2);
});

test("syncPbxTenantDirectoryFromRows: mix of new and existing", async () => {
  const db = makeMockDb(new Set(["inst1:1"]));
  const tenants = [
    { tenant_id: "1", name: "alpha" },
    { tenant_id: "3", name: "gamma" },
  ];
  const result = await syncPbxTenantDirectoryFromRows(db, "inst1", tenants);
  assert.equal(result.upserted, 2);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
});

test("syncPbxTenantDirectoryFromRows: skips rows with missing id or name", async () => {
  const db = makeMockDb(new Set());
  const tenants = [
    { tenant_id: "", name: "noid" },
    { tenant_id: "5", name: "" },
    { tenant_id: "6", name: "valid" },
  ];
  const result = await syncPbxTenantDirectoryFromRows(db, "inst1", tenants);
  assert.equal(result.upserted, 1);
  assert.equal(result.created, 1);
});
