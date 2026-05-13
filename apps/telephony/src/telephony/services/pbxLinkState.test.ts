import test from "node:test";
import assert from "node:assert/strict";
import { computePbxLinkState } from "./pbxLinkState";

const T0 = 1_700_000_000_000;

test("computePbxLinkState: AMI down → reconnecting", () => {
  assert.equal(
    computePbxLinkState({
      amiConnected: false,
      ariHealthy: false,
      lastAmiTrafficAt: null,
      connectedSince: null,
      nowMs: T0,
    }),
    "reconnecting",
  );
});

test("computePbxLinkState: AMI up, ARI down → degraded", () => {
  assert.equal(
    computePbxLinkState({
      amiConnected: true,
      ariHealthy: false,
      lastAmiTrafficAt: new Date(T0).toISOString(),
      connectedSince: new Date(T0 - 120_000).toISOString(),
      nowMs: T0,
    }),
    "degraded",
  );
});

test("computePbxLinkState: grace window after connect → healthy even without traffic", () => {
  assert.equal(
    computePbxLinkState({
      amiConnected: true,
      ariHealthy: true,
      lastAmiTrafficAt: null,
      connectedSince: new Date(T0 - 30_000).toISOString(),
      nowMs: T0,
    }),
    "healthy",
  );
});

test("computePbxLinkState: stale when no AMI traffic beyond threshold", () => {
  assert.equal(
    computePbxLinkState({
      amiConnected: true,
      ariHealthy: true,
      lastAmiTrafficAt: new Date(T0 - 4 * 60_000).toISOString(),
      connectedSince: new Date(T0 - 10 * 60_000).toISOString(),
      nowMs: T0,
    }),
    "stale",
  );
});
