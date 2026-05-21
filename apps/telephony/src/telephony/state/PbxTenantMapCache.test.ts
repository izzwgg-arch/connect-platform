// Tests for PbxTenantMapCache — focused on stats, forceRefreshWithCooldown, and cache-miss
// behaviour. No real HTTP calls; fetch is replaced with a controllable mock.
//
// Run: pnpm --filter @connect/telephony test

import test from "node:test";
import assert from "node:assert/strict";

// ─── Env bootstrap ────────────────────────────────────────────────────────────
//
// env.ts validates required env on import; PbxTenantMapCache imports the logger
// which imports env, so set required vars before require().
process.env.JWT_SECRET = "x".repeat(32);
process.env.AMI_USERNAME = "test";
process.env.AMI_PASSWORD = "test";
process.env.ARI_BASE_URL = "http://test.invalid";
process.env.ARI_USERNAME = "test";
process.env.ARI_PASSWORD = "test";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";
process.env.CDR_INGEST_URL = "http://test.invalid/internal/cdr-ingest";

// Late require so the env above is in place when loadEnv() runs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PbxTenantMapCache } = require("./PbxTenantMapCache") as typeof import("./PbxTenantMapCache");

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSampleBody(tenantCount = 2) {
  return {
    version: 2,
    pbxInstanceId: "inst1",
    fetchedAt: new Date().toISOString(),
    entries: Array.from({ length: tenantCount }, (_, i) => ({
      vitalTenantId: String(i + 1),
      tenantCode: `T${i + 1}`,
      tenantSlug: `tenant_${i + 1}`,
      connectTenantId: `cuid_${i + 1}`,
    })),
    didEntries: [
      {
        e164: "+18005550001",
        vitalTenantId: "1",
        tenantCode: "T1",
        connectTenantId: "cuid_1",
        tenantName: "Tenant One",
      },
    ],
    extensionEntries: [
      { extNumber: "101", connectTenantId: "cuid_1", tenantName: "Tenant One" },
    ],
  };
}

function installFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { calls, restore: () => { (globalThis as any).fetch = original; } };
}

// ── getStats: initial state ───────────────────────────────────────────────────

test("PbxTenantMapCache.getStats: initial state before any refresh", () => {
  const cache = new PbxTenantMapCache("http://api.test/internal/telephony/pbx-tenant-map", "secret", 60_000);
  const stats = cache.getStats();
  assert.equal(stats.lastRefreshedAt, null);
  assert.equal(stats.refreshCount, 0);
  assert.equal(stats.entryCount, 0);
  assert.equal(stats.didCount, 0);
  assert.equal(stats.extensionMapSize, 0);
  assert.equal(stats.lastError, null);
  assert.equal(stats.pollMs, 60_000);
});

// ── successful refresh updates stats ─────────────────────────────────────────

test("PbxTenantMapCache: successful refresh updates stats correctly", async () => {
  const { calls, restore } = installFetch(makeSampleBody(3));
  const cache = new PbxTenantMapCache("http://api.test/internal/telephony/pbx-tenant-map", "secret", 60_000);
  cache.start();
  await new Promise((r) => setTimeout(r, 50));
  cache.stop();
  restore();

  const stats = cache.getStats();
  assert.equal(stats.refreshCount, 1);
  assert.equal(stats.entryCount, 3);
  assert.equal(stats.didCount, 1);
  assert.equal(stats.extensionMapSize, 1);
  assert.equal(stats.lastError, null);
  assert.ok(stats.lastRefreshedAt !== null, "lastRefreshedAt should be set");
  assert.equal(calls.length, 1);
});

// ── PBX failure keeps existing cached data ────────────────────────────────────

test("PbxTenantMapCache: PBX fetch failure keeps existing cached data and sets lastError", async () => {
  const { restore: r1 } = installFetch(makeSampleBody(2));
  const cache = new PbxTenantMapCache("http://api.test/internal/telephony/pbx-tenant-map", "s", 60_000);
  cache.start();
  await new Promise((r) => setTimeout(r, 50));
  cache.stop();
  r1();

  assert.equal(cache.getStats().entryCount, 2);
  assert.equal(cache.getStats().lastError, null);

  // Second refresh fails (HTTP 500)
  const { restore: r2 } = installFetch({ error: "server error" }, 500);
  cache.start();
  await new Promise((r) => setTimeout(r, 50));
  cache.stop();
  r2();

  // Data must not be wiped — still 2 entries from the first successful load
  assert.equal(cache.getStats().entryCount, 2, "Cached entries must survive a failed refresh");
  assert.ok(cache.getStats().lastError !== null, "lastError must be set after failure");
});

// ── forceRefreshWithCooldown: respects cooldown ───────────────────────────────

test("PbxTenantMapCache.forceRefreshWithCooldown: second call within cooldown is skipped", async () => {
  const { calls, restore } = installFetch(makeSampleBody(1));
  const cache = new PbxTenantMapCache("http://api.test/internal/telephony/pbx-tenant-map", "s", 60_000);

  cache.forceRefreshWithCooldown(30_000);
  cache.forceRefreshWithCooldown(30_000); // skipped (within cooldown)
  cache.forceRefreshWithCooldown(30_000); // also skipped

  await new Promise((r) => setTimeout(r, 50));
  cache.stop();
  restore();

  assert.equal(calls.length, 1, "Only one fetch should be made within the cooldown window");
});

// ── forceRefreshWithCooldown: cooldown=0 fires every call ────────────────────

test("PbxTenantMapCache.forceRefreshWithCooldown: fires again after cooldown expires", async () => {
  const { calls, restore } = installFetch(makeSampleBody(1));
  const cache = new PbxTenantMapCache("http://api.test/internal/telephony/pbx-tenant-map", "s", 60_000);

  cache.forceRefreshWithCooldown(0); // cooldown = 0ms → always fires
  await new Promise((r) => setTimeout(r, 100));
  cache.forceRefreshWithCooldown(0); // cooldown elapsed → fires again
  await new Promise((r) => setTimeout(r, 100));

  cache.stop();
  restore();

  assert.ok(calls.length >= 2, "Two fetches should fire when cooldown is 0");
});

// ── new tenant discovered ─────────────────────────────────────────────────────

test("PbxTenantMapCache: new tenant in response is discoverable after refresh", async () => {
  // First refresh: 1 tenant
  const { restore: r1 } = installFetch(makeSampleBody(1));
  const cache = new PbxTenantMapCache("http://api.test/internal/telephony/pbx-tenant-map", "s", 60_000);
  cache.start();
  await new Promise((r) => setTimeout(r, 100));
  r1();

  assert.equal(cache.getEntries().length, 1);

  // Second refresh: 2 tenants (new tenant added to PBX)
  const { restore: r2 } = installFetch(makeSampleBody(2));
  cache.forceRefreshWithCooldown(0); // cooldown=0 ensures it fires immediately
  await new Promise((r) => setTimeout(r, 100));
  cache.stop();
  r2();

  assert.equal(cache.getEntries().length, 2, "New tenant should appear after next refresh");
});

// ── slug resolution ───────────────────────────────────────────────────────────

test("PbxTenantMapCache.resolveBySlug: resolves exact slug after load", async () => {
  const { restore } = installFetch(makeSampleBody(2));
  const cache = new PbxTenantMapCache("http://api.test/internal/telephony/pbx-tenant-map", "s", 60_000);
  cache.start();
  await new Promise((r) => setTimeout(r, 50));
  cache.stop();
  restore();

  const resolved = cache.resolveBySlug("tenant_1");
  assert.equal(resolved, "cuid_1");
});

// ── mapUrl not configured ─────────────────────────────────────────────────────

test("PbxTenantMapCache: no-op when mapUrl is undefined", async () => {
  const cache = new PbxTenantMapCache(undefined, undefined, 60_000);
  cache.start();
  cache.forceRefreshWithCooldown();
  const stats = cache.getStats();
  assert.equal(stats.refreshCount, 0);
  assert.equal(stats.lastError, null);
  cache.stop();
});
