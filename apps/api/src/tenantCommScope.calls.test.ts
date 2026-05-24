import test, { mock } from "node:test";
import assert from "node:assert/strict";

let allowTenantCalls = false;

mock.module("./platformRolePermissions", {
  namedExports: {
    hasEffectivePortalPermission: async (_user: any, perm: string) => {
      if (perm === "can_view_tenant_call_history") return allowTenantCalls;
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
    },
  },
});

let scope: any;
async function load() { scope = await import("./tenantCommScope"); }
function setOwned(tenantId: string, userId: string, exts: string[]) { ownedExts.set(`${tenantId}:${userId}`, exts); }

const user = { sub: "u1", tenantId: "t1", role: "END_USER" };

// Simulated CDR rows
const rows = [
  { tenantId: "t1", fromNumber: "101", toNumber: "999" },
  { tenantId: "t1", fromNumber: "102", toNumber: "888" },
  { tenantId: "t2", fromNumber: "103", toNumber: "777" },
];

function filterByWhere(where: any) {
  return rows.filter((r) => (
    r.tenantId === where.tenantId
    && (!where.OR
      || where.OR.some((cl: any) => (
        (cl.fromNumber?.in && cl.fromNumber.in.includes(r.fromNumber))
        || (cl.toNumber?.in && cl.toNumber.in.includes(r.toNumber))
      )))
  ));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("calls: normal user remains extension-scoped", async () => {
  await load();
  allowTenantCalls = false;
  setOwned("t1", "u1", ["101"]);
  const extScoped = await scope.isExtensionScopedCallViewerForUserLite(user);
  assert.equal(extScoped, true);
  const clause = scope.buildCdrExtensionVisibilityClauseLite(await scope.getUserExtensionNumbersLite(user));
  const where = { tenantId: user.tenantId, ...(clause || {}) };
  const visible = filterByWhere(where);
  assert.deepEqual(visible.map((r) => r.fromNumber).sort(), ["101"]);
});

test("calls: tenant-wide permission becomes tenant-scoped only (no ext filter)", async () => {
  await load();
  allowTenantCalls = true;
  setOwned("t1", "u1", ["101"]);
  const extScoped = await scope.isExtensionScopedCallViewerForUserLite(user);
  assert.equal(extScoped, false);
  const where = { tenantId: user.tenantId };
  const visible = filterByWhere(where);
  // Includes all same-tenant rows, but not cross-tenant
  assert.deepEqual(visible.map((r) => r.tenantId), ["t1", "t1"]);
});

test("calls: tenant-wide cannot see cross-tenant calls", async () => {
  await load();
  allowTenantCalls = true;
  setOwned("t1", "u1", ["101"]);
  const where = { tenantId: user.tenantId };
  const visible = filterByWhere(where);
  assert.ok(!visible.some((r) => r.tenantId === "t2"));
});
