import test from "node:test";
import assert from "node:assert/strict";
import {
  __portalPermissionCacheStats,
  __resetPortalPermissionCaches,
  invalidateAllPortalPermissions,
  invalidatePortalPermissionsForUser,
  portalPermissionCacheKey,
  withCachedPortalPermissions,
  withCachedRoleSnapshot,
} from "./permissionCache";

/**
 * Guards the permission cache added 2026-08-06 to stop every portal request
 * re-reading the whole permission system from Postgres (5 queries per
 * hasEffectivePortalPermission() call, and routes call it several times each).
 *
 * These cases exist because this is an AUTHORIZATION cache: a wrong key, a
 * cached failure, or a missed invalidation is a security bug, not a perf bug.
 */

const ENV_KEY = "PORTAL_PERMISSION_CACHE_TTL_MS";
const originalTtl = process.env[ENV_KEY];

function setTtl(v: string | undefined) {
  if (v === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = v;
}

test.afterEach(() => {
  setTtl(originalTtl);
  __resetPortalPermissionCaches();
});

test("second lookup is served from cache (the whole point)", async () => {
  __resetPortalPermissionCaches();
  let calls = 0;
  const load = async () => {
    calls++;
    return ["can_view_dashboard"];
  };
  const key = portalPermissionCacheKey("USER", "u1", "t1");

  assert.deepEqual(await withCachedPortalPermissions(key, load), ["can_view_dashboard"]);
  assert.deepEqual(await withCachedPortalPermissions(key, load), ["can_view_dashboard"]);
  assert.equal(calls, 1, "loader must run only once");
});

test("key separates role, user and tenant — no cross-user bleed", async () => {
  __resetPortalPermissionCaches();
  const seen: string[] = [];
  const loadFor = (label: string) => async () => {
    seen.push(label);
    return [label];
  };

  await withCachedPortalPermissions(portalPermissionCacheKey("USER", "u1", "t1"), loadFor("a"));
  await withCachedPortalPermissions(portalPermissionCacheKey("USER", "u2", "t1"), loadFor("b"));
  await withCachedPortalPermissions(portalPermissionCacheKey("USER", "u1", "t2"), loadFor("c"));
  await withCachedPortalPermissions(portalPermissionCacheKey("SUPER_ADMIN", "u1", "t1"), loadFor("d"));

  assert.deepEqual(seen, ["a", "b", "c", "d"], "each distinct identity resolves on its own");

  // And a different user must never receive another user's answer.
  const other = await withCachedPortalPermissions(
    portalPermissionCacheKey("USER", "u2", "t1"),
    async () => ["SHOULD_NOT_RUN"],
  );
  assert.deepEqual(other, ["b"]);
});

test("a failed resolve (null) is never cached — a blip must not pin fallback perms", async () => {
  __resetPortalPermissionCaches();
  let calls = 0;
  const key = portalPermissionCacheKey("USER", "u9", "t9");

  const first = await withCachedPortalPermissions(key, async () => {
    calls++;
    return null;
  });
  assert.equal(first, null);

  const second = await withCachedPortalPermissions(key, async () => {
    calls++;
    return ["can_view_dashboard"];
  });
  assert.deepEqual(second, ["can_view_dashboard"], "recovers immediately after a failure");
  assert.equal(calls, 2);
});

test("invalidateAllPortalPermissions drops resolved sets and the role snapshot", async () => {
  __resetPortalPermissionCaches();
  let resolveCalls = 0;
  let snapshotCalls = 0;
  const key = portalPermissionCacheKey("USER", "u1", "t1");
  const load = async () => {
    resolveCalls++;
    return ["x"];
  };
  const loadSnapshot = async () => {
    snapshotCalls++;
    return { version: 2, roles: {} };
  };

  await withCachedPortalPermissions(key, load);
  await withCachedRoleSnapshot(loadSnapshot);
  invalidateAllPortalPermissions();
  await withCachedPortalPermissions(key, load);
  await withCachedRoleSnapshot(loadSnapshot);

  assert.equal(resolveCalls, 2, "resolved set re-read after invalidation");
  assert.equal(snapshotCalls, 2, "snapshot re-read after invalidation");
});

test("per-user invalidation drops only that user, across their tenants and roles", async () => {
  __resetPortalPermissionCaches();
  const load = (label: string) => async () => [label];

  await withCachedPortalPermissions(portalPermissionCacheKey("USER", "u1", "t1"), load("u1t1"));
  await withCachedPortalPermissions(portalPermissionCacheKey("TENANT_ADMIN", "u1", "t2"), load("u1t2"));
  await withCachedPortalPermissions(portalPermissionCacheKey("USER", "u2", "t1"), load("u2t1"));

  invalidatePortalPermissionsForUser("u1");

  let reran = false;
  await withCachedPortalPermissions(portalPermissionCacheKey("USER", "u1", "t1"), async () => {
    reran = true;
    return ["fresh"];
  });
  assert.ok(reran, "u1 was evicted");

  const untouched = await withCachedPortalPermissions(
    portalPermissionCacheKey("USER", "u2", "t1"),
    async () => ["SHOULD_NOT_RUN"],
  );
  assert.deepEqual(untouched, ["u2t1"], "u2 still cached");
});

test("TTL=0 disables caching entirely (the escape hatch)", async () => {
  __resetPortalPermissionCaches();
  setTtl("0");
  let calls = 0;
  const key = portalPermissionCacheKey("USER", "u1", "t1");
  const load = async () => {
    calls++;
    return ["x"];
  };

  await withCachedPortalPermissions(key, load);
  await withCachedPortalPermissions(key, load);
  await withCachedRoleSnapshot(load);
  await withCachedRoleSnapshot(load);

  assert.equal(calls, 4, "every lookup goes to the loader");
  assert.equal(__portalPermissionCacheStats().resolved, 0, "nothing retained");
});

test("entries expire once the TTL elapses", async () => {
  __resetPortalPermissionCaches();
  setTtl("20");
  let calls = 0;
  const key = portalPermissionCacheKey("USER", "u1", "t1");
  const load = async () => {
    calls++;
    return ["x"];
  };

  await withCachedPortalPermissions(key, load);
  await withCachedPortalPermissions(key, load);
  assert.equal(calls, 1, "still warm");

  await new Promise((r) => setTimeout(r, 40));
  await withCachedPortalPermissions(key, load);
  assert.equal(calls, 2, "re-read after expiry");
});

test("a bad TTL env value falls back to the default rather than disabling the cache", async () => {
  __resetPortalPermissionCaches();
  for (const bad of ["abc", "-5", "NaN"]) {
    setTtl(bad);
    assert.equal(__portalPermissionCacheStats().ttlMs, 15_000, `"${bad}" -> default`);
  }
});

test("cache stays bounded under many distinct users", async () => {
  __resetPortalPermissionCaches();
  setTtl("60000");
  for (let i = 0; i < 5_200; i++) {
    await withCachedPortalPermissions(
      portalPermissionCacheKey("USER", `user-${i}`, "t1"),
      async () => [`p${i}`],
    );
  }
  assert.ok(
    __portalPermissionCacheStats().resolved <= 5_000,
    `expected <= 5000 entries, got ${__portalPermissionCacheStats().resolved}`,
  );
});
