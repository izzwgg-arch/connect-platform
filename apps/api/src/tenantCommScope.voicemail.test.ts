import test, { mock } from "node:test";
import assert from "node:assert/strict";

let allowTenantVm = false;

mock.module("./platformRolePermissions", {
  namedExports: {
    hasEffectivePortalPermission: async (_user: any, perm: string) => {
      if (perm === "can_view_tenant_voicemails") return allowTenantVm;
      return false;
    },
  },
});

const ownedExts = new Map<string, string[]>();
mock.module("@connect/db", {
  namedExports: {
    db: {
      tenantPbxLink: { findFirst: async () => null },
      pbxTenantDirectory: { findFirst: async () => null },
      extension: {
        findMany: async ({ where }: any) => {
          const key = `${where.tenantId}:${where.ownerUserId}`;
          const list = ownedExts.get(key) || [];
          return list.map((ext) => ({ extNumber: ext }));
        },
      },
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

test("voicemail: normal user cannot access another user's mailbox in same tenant", async () => {
  await load();
  allowTenantVm = false;
  setOwned("t1", "u1", ["101"]);
  const vm = { tenantId: "t1", extension: "102" };
  const res = await scope.voicemailAccessDecisionForRow(vm, user);
  assert.equal(res.allowed, false);
  assert.equal(res.mode, "contained-owned");
});

test("voicemail: tenant-wide permission allows same-tenant mailbox", async () => {
  await load();
  allowTenantVm = true;
  setOwned("t1", "u1", ["101"]);
  const vm = { tenantId: "t1", extension: "102" };
  const res = await scope.voicemailAccessDecisionForRow(vm, user);
  assert.equal(res.allowed, true);
  assert.equal(res.mode, "tenant");
});

test("voicemail: tenant-wide permission does not allow cross-tenant mailbox", async () => {
  await load();
  allowTenantVm = true;
  setOwned("t1", "u1", ["101"]);
  const vm = { tenantId: "t2", extension: "102" };
  const res = await scope.voicemailAccessDecisionForRow(vm, user);
  assert.equal(res.allowed, false);
  assert.equal(res.mode, "tenant");
});

test("voicemail: update/delete use same scope (row-level decision)", async () => {
  await load();
  allowTenantVm = false;
  setOwned("t1", "u1", ["101"]);
  const vm = { tenantId: "t1", extension: "101" };
  const res = await scope.voicemailAccessDecisionForRow(vm, user);
  assert.equal(res.allowed, true);
  assert.equal(res.mode, "contained-owned");
});
