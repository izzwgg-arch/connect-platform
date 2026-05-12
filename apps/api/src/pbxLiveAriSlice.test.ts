import test from "node:test";
import assert from "node:assert/strict";
import { fetchAriSliceForPbxLiveFromRedisOrAri } from "./pbxLiveAriSlice";

function norm(raw: Record<string, unknown>, tenantId?: string | null) {
  return {
    channelId: String(raw.id ?? ""),
    tenantId: tenantId ?? null,
    direction: "internal" as const,
    caller: "",
    callee: "",
    extension: null,
    startedAt: null,
    durationSeconds: 0,
    state: "Up",
    queue: null,
  };
}

function minimalSnapshot(producedAt: string) {
  return {
    v: 1 as const,
    producedAt,
    pollIntervalMs: 5000,
    source: "telephony" as const,
    pbxHost: "h",
    rawBridgeCount: 0,
    rawChannelCount: 0,
    qualifyingBridges: 0,
    activeCalls: 0,
    bridges: [] as [],
    registeredEndpoints: 1 as number | null,
    unregisteredEndpoints: 0 as number | null,
    totalEndpoints: 1 as number | null,
  };
}

test("fetchAriSlice prefers fresh telephony Redis snapshot over direct ARI", async () => {
  process.env.PBX_ARI_USER = "u";
  process.env.PBX_ARI_PASS = "p";
  const now = new Date().toISOString();
  const redis = {
    async get() {
      return JSON.stringify(minimalSnapshot(now));
    },
  };
  let bridgedCalls = 0;
  const client = {
    async getAriBridgedActiveCalls() {
      bridgedCalls++;
      return null;
    },
    async getAriEndpointCounts() {
      return null;
    },
  };
  const out = await fetchAriSliceForPbxLiveFromRedisOrAri({
    client: client as any,
    tenantLabel: "tid",
    redis: redis as any,
    snapshotPbxHost: "h",
    snapshotStaleMs: 60_000,
    forceDirectAri: false,
    normalizeRow: norm,
    log: { info: () => {}, warn: () => {} },
  });
  assert.equal(out.activeCallsSource, "telephony_redis");
  assert.equal(bridgedCalls, 0);
  delete process.env.PBX_ARI_USER;
  delete process.env.PBX_ARI_PASS;
});

test("fetchAriSlice uses direct ARI when forceDirectAri even if snapshot exists", async () => {
  process.env.PBX_ARI_USER = "u";
  process.env.PBX_ARI_PASS = "p";
  const now = new Date().toISOString();
  const redis = { async get() { return JSON.stringify(minimalSnapshot(now)); } };
  const client = {
    async getAriBridgedActiveCalls() {
      return {
        activeCalls: 0,
        bridges: [],
        debug: { totalChannels: 0, totalBridges: 0, qualifyingBridges: 0, orphanLegCalls: 0, excluded: [] },
        verification: {
          rawBridgeCount: 0,
          rawChannelCount: 0,
          qualifyingBridgeCount: 0,
          bridgeBackedCallCount: 0,
          orphanLegCallCount: 0,
          finalActiveCalls: 0,
          qualifyingBridges: [],
          excludedBridges: [],
          orphanLegs: [],
        },
      };
    },
    async getAriEndpointCounts() {
      return { registered: 0, unregistered: 0, total: 0 };
    },
  };
  const out = await fetchAriSliceForPbxLiveFromRedisOrAri({
    client: client as any,
    tenantLabel: "tid",
    redis: redis as any,
    snapshotPbxHost: "h",
    snapshotStaleMs: 60_000,
    forceDirectAri: true,
    normalizeRow: norm,
    log: { info: () => {}, warn: () => {} },
  });
  assert.equal(out.activeCallsSource, "ari");
  delete process.env.PBX_ARI_USER;
  delete process.env.PBX_ARI_PASS;
});
