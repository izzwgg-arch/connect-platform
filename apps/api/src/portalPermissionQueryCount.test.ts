import test, { mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Proves the 2026-08-06 slowness fix at the level that actually mattered: how
 * many database round-trips one permission decision costs.
 *
 * BEFORE: resolvePortalPermissionsWithCrmUserAccess issued FIVE queries every
 * single call — the role snapshot, the user's custom-role assignments TWICE
 * (the same query, because getEffectiveCustomRolePermissions ignores tenantId),
 * CRM tenant settings, and CRM user access. Nothing was cached, and
 * hasEffectivePortalPermission() runs the whole thing per permission asked —
 * several times per route, across 26 requests per dashboard load.
 *
 * AFTER: four on a cold resolve (the duplicate is gone), zero while warm.
 */

let queries: string[] = [];

const fakeDb = {
  platformRolePermissionSnapshot: {
    findUnique: async () => {
      queries.push("platformRolePermissionSnapshot");
      return { id: "default", roles: { version: 2, roles: {} } };
    },
  },
  userCustomRole: {
    findMany: async () => {
      queries.push("userCustomRole");
      return [];
    },
  },
  crmTenantSettings: {
    findUnique: async () => {
      queries.push("crmTenantSettings");
      return { enabled: false };
    },
  },
  crmUserAccess: {
    findUnique: async () => {
      queries.push("crmUserAccess");
      return null;
    },
  },
};

mock.module("@connect/db", { namedExports: { db: fakeDb } });

// Lazy — this suite is transpiled to CJS, where top-level await is unavailable,
// and the modules must not load before mock.module("@connect/db") is in place.
type Mod = {
  resolve: (role: string, sub: string, tenantId: string) => Promise<unknown>;
  reset: () => void;
  invalidate: () => void;
};
let mod: Mod | null = null;

async function load(): Promise<Mod> {
  if (!mod) {
    const perms = await import("./crm/portalCrmPermissions");
    const cache = await import("./permissionCache");
    mod = {
      resolve: (role, sub, tenantId) =>
        perms.resolvePortalPermissionsWithCrmUserAccess(role, sub, tenantId),
      reset: cache.__resetPortalPermissionCaches,
      invalidate: cache.invalidateAllPortalPermissions,
    };
  }
  return mod;
}

const USER = { role: "USER", sub: "user-1", tenantId: "tenant-1" };

async function resolve(u = USER) {
  const m = await load();
  return m.resolve(u.role, u.sub, u.tenantId);
}

/** Fresh cache + counter before every case, so ordering cannot mask a regression. */
async function fresh() {
  const m = await load();
  m.reset();
  queries = [];
  return m;
}

test("a cold resolve no longer fetches custom roles twice", async () => {
  await fresh();
  await resolve();
  const customRoleFetches = queries.filter((q) => q === "userCustomRole").length;
  assert.equal(customRoleFetches, 1, `custom roles fetched ${customRoleFetches}x, expected 1`);
  assert.equal(queries.length, 4, `cold resolve cost ${queries.length} queries: ${queries.join(", ")}`);
});

test("repeated permission checks cost ZERO queries while warm", async () => {
  await fresh();
  await resolve();
  const afterCold = queries.length;

  // A voicemail route asks about four permissions; the page then fires 25 more
  // requests. Every one of these used to be another five queries.
  for (let i = 0; i < 30; i++) await resolve();

  assert.equal(queries.length, afterCold, `warm resolves issued ${queries.length - afterCold} extra queries`);
});

test("a different user is still resolved independently (no shared answer)", async () => {
  await fresh();
  await resolve();
  queries = [];
  const other = await resolve({ role: "USER", sub: "user-2", tenantId: "tenant-1" });
  assert.ok(queries.length > 0, "second user must hit the database, not reuse user-1's answer");
  assert.ok(Array.isArray(other));
});

test("invalidation forces the next resolve back to the database", async () => {
  const m = await fresh();
  await resolve();
  queries = [];
  await resolve();
  assert.equal(queries.length, 0, "still warm");

  m.invalidate();
  await resolve();
  assert.ok(queries.length > 0, "invalidation must reopen the database path");
});

test("the permission answer itself is unchanged by caching", async () => {
  await fresh();
  const cold = await resolve();
  const warm = await resolve();
  assert.deepEqual(warm, cold, "cached answer must equal the freshly-resolved one");
  assert.ok(Array.isArray(cold) && cold.length > 0, "resolver still returns a real permission set");
});
