import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAriBridgedSnapshotRedisKey,
  isSnapshotAcceptablyFresh,
  parseAriBridgedSnapshotJson,
  snapshotAgeMs,
} from "./ariBridgedSnapshot";

test("buildAriBridgedSnapshotRedisKey sanitizes host", () => {
  assert.match(buildAriBridgedSnapshotRedisKey("209.145.60.79"), /209\.145\.60\.79$/);
  assert.match(buildAriBridgedSnapshotRedisKey("weird:host/name"), /weird_host_name$/);
});

test("parseAriBridgedSnapshotJson accepts v1 payload", () => {
  const now = new Date().toISOString();
  const raw = JSON.stringify({
    v: 1,
    producedAt: now,
    pollIntervalMs: 5000,
    source: "telephony",
    pbxHost: "209.145.60.79",
    rawBridgeCount: 1,
    rawChannelCount: 2,
    qualifyingBridges: 1,
    activeCalls: 1,
    bridges: [
      {
        bridgeId: "b1",
        channelCount: 2,
        caller: "a",
        callee: "b",
        channelNames: ["PJSIP/x"],
        channelIds: ["ch1"],
        sourceKind: "bridge",
      },
    ],
    registeredEndpoints: 1,
    unregisteredEndpoints: 2,
    totalEndpoints: 3,
  });
  const s = parseAriBridgedSnapshotJson(raw);
  assert.ok(s);
  assert.equal(s!.v, 1);
  assert.equal(s!.bridges.length, 1);
});

test("isSnapshotAcceptablyFresh respects stale window", () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  const snap = parseAriBridgedSnapshotJson(
    JSON.stringify({
      v: 1,
      producedAt: old,
      pollIntervalMs: 5000,
      source: "telephony",
      pbxHost: "h",
      rawBridgeCount: 0,
      rawChannelCount: 0,
      qualifyingBridges: 0,
      activeCalls: 0,
      bridges: [],
      registeredEndpoints: null,
      unregisteredEndpoints: null,
      totalEndpoints: null,
    }),
  );
  assert.ok(snap);
  assert.equal(isSnapshotAcceptablyFresh(snap!, 30_000), false);
  assert.equal(isSnapshotAcceptablyFresh(snap!, 120_000), true);
});

test("snapshotAgeMs is non-negative for past timestamps", () => {
  const t = new Date(Date.now() - 1000).toISOString();
  assert.ok(snapshotAgeMs(t) >= 1000);
});
