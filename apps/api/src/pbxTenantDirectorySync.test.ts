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

function makeMockDb(existingIds: Set<string>, existingRows: Record<string, any> = {}) {
  const upsertCalls: unknown[] = [];
  const deleteManyCalls: unknown[] = [];
  const db = {
    pbxTenantDirectory: {
      findUnique: async ({ where }: any) => {
        const key = `${where.pbxInstanceId_vitalTenantId.pbxInstanceId}:${where.pbxInstanceId_vitalTenantId.vitalTenantId}`;
        return existingIds.has(key) ? (existingRows[key] ?? { id: key, tenantSlug: "", tenantCode: "", displayName: null }) : null;
      },
      upsert: async (args: unknown) => {
        upsertCalls.push(args);
        return {};
      },
      deleteMany: async (args: any) => {
        deleteManyCalls.push(args);
        const incoming = new Set(args.where.vitalTenantId.notIn.map((id: string) => `${args.where.pbxInstanceId}:${id}`));
        let count = 0;
        for (const key of Array.from(existingIds)) {
          if (key.startsWith(`${args.where.pbxInstanceId}:`) && !incoming.has(key)) {
            existingIds.delete(key);
            count++;
          }
        }
        return { count };
      },
    },
    _upsertCalls: upsertCalls,
    _deleteManyCalls: deleteManyCalls,
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
  assert.equal(result.deleted, 0);
});

test("syncPbxTenantDirectoryFromRows: existing unchanged tenants are not counted as updated", async () => {
  const db = makeMockDb(new Set(["inst1:1", "inst1:2"]), {
    "inst1:1": { id: "inst1:1", tenantSlug: "alpha", tenantCode: "T1", displayName: null },
    "inst1:2": { id: "inst1:2", tenantSlug: "beta", tenantCode: "T2", displayName: null },
  });
  const tenants = [
    { tenant_id: "1", name: "alpha" },
    { tenant_id: "2", name: "beta" },
  ];
  const result = await syncPbxTenantDirectoryFromRows(db, "inst1", tenants);
  assert.equal(result.upserted, 2);
  assert.equal(result.created, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.deleted, 0);
});

test("syncPbxTenantDirectoryFromRows: existing changed tenant display fields are counted as updated", async () => {
  const db = makeMockDb(new Set(["inst1:1"]), {
    "inst1:1": { id: "inst1:1", tenantSlug: "alpha_old", tenantCode: "T1", displayName: "Old Alpha" },
  });
  const tenants = [
    { tenant_id: "1", name: "alpha_new", description: "New Alpha" },
  ];
  const result = await syncPbxTenantDirectoryFromRows(db, "inst1", tenants);
  assert.equal(result.upserted, 1);
  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);
  assert.equal(result.deleted, 0);
});

test("syncPbxTenantDirectoryFromRows: mix of new and changed existing", async () => {
  const db = makeMockDb(new Set(["inst1:1"]), {
    "inst1:1": { id: "inst1:1", tenantSlug: "alpha_old", tenantCode: "T1", displayName: null },
  });
  const tenants = [
    { tenant_id: "1", name: "alpha" },
    { tenant_id: "3", name: "gamma" },
  ];
  const result = await syncPbxTenantDirectoryFromRows(db, "inst1", tenants);
  assert.equal(result.upserted, 2);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.deleted, 0);
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
  assert.equal(result.deleted, 0);
});

test("syncPbxTenantDirectoryFromRows: deletes local directory rows missing from VitalPBX response", async () => {
  const db = makeMockDb(new Set(["inst1:1", "inst1:2", "inst1:3"]), {
    "inst1:1": { id: "inst1:1", tenantSlug: "alpha", tenantCode: "T1", displayName: null },
    "inst1:3": { id: "inst1:3", tenantSlug: "gamma", tenantCode: "T3", displayName: null },
  });
  const tenants = [
    { tenant_id: "1", name: "alpha" },
    { tenant_id: "3", name: "gamma" },
  ];
  const result = await syncPbxTenantDirectoryFromRows(db, "inst1", tenants);
  assert.equal(result.upserted, 2);
  assert.equal(result.created, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.deleted, 1);
});

test("syncPbxTenantDirectoryFromRows: does not delete when no valid PBX tenant ids were parsed", async () => {
  const db = makeMockDb(new Set(["inst1:1", "inst1:2"]));
  const tenants = [
    { tenant_id: "", name: "missing_id" },
    { tenant_id: "2", name: "" },
  ];
  const result = await syncPbxTenantDirectoryFromRows(db, "inst1", tenants);
  assert.equal(result.upserted, 0);
  assert.equal(result.deleted, 0);
  assert.equal((db as any)._deleteManyCalls.length, 0);
});
