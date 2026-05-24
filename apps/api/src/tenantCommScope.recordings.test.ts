import test, { mock } from "node:test";
import assert from "node:assert/strict";

let allowTenantRecordings = false;

mock.module("./platformRolePermissions", {
  namedExports: {
    hasEffectivePortalPermission: async (_user: any, perm: string) => {
      if (perm === "can_view_tenant_call_recordings") return allowTenantRecordings;
      return false;
    },
  },
});

const ownedExts = new Map<string, string[]>();
mock.module("@connect/db", {
  namedExports: {
    db: {
      extension: {
        findMany: async ({ where }: any) => {
          const key = `${where.tenantId}:${where.ownerUserId}`;
          const list = ownedExts.get(key) || [];
          return list.map((ext) => ({ extNumber: ext }));
        },
      },
      tenantPbxLink: { findFirst: async () => null },
      pbxTenantDirectory: { findFirst: async () => null },
    },
  },
});

let scope: any;
async function load() {
  scope = await import("./tenantCommScope");
}

function setOwned(tenantId: string, userId: string, exts: string[]) {
  ownedExts.set(`${tenantId}:${userId}`, exts);
}

const user = { sub: "u1", tenantId: "t1", role: "END_USER" };

// ── Tests ─────────────────────────────────────────────────────────────────────

test("recordings: normal user cannot stream another extension's recording in same tenant", async () => {
  await load();
  allowTenantRecordings = false;
  setOwned("t1", "u1", ["101"]);
  const rec = { tenantId: "t1", extension: "102" };
  const res = await scope.recordingAccessDecision(rec, user);
  assert.equal(res.allowed, false);
  assert.equal(res.mode, "contained-owned");
});

test("recordings: tenant-wide permission allows same-tenant recording", async () => {
  await load();
  allowTenantRecordings = true;
  setOwned("t1", "u1", ["101"]);
  const rec = { tenantId: "t1", extension: "102" };
  const res = await scope.recordingAccessDecision(rec, user);
  assert.equal(res.allowed, true);
  assert.equal(res.mode, "tenant");
});

test("recordings: tenant-wide permission does not allow cross-tenant recording", async () => {
  await load();
  allowTenantRecordings = true;
  setOwned("t1", "u1", ["101"]);
  const rec = { tenantId: "t2", extension: "102" };
  const res = await scope.recordingAccessDecision(rec, user);
  assert.equal(res.allowed, false);
  assert.equal(res.mode, "contained-owned"); // tenant mismatch blocked before tenant mode applies
});
