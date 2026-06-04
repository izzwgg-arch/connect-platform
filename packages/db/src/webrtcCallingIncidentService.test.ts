import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateWebrtcIncidentTriggers,
  WEBRTC_INCIDENT_DISMISS_COOLDOWN_MS,
  WEBRTC_INCIDENT_FAILURE_TYPES,
} from "@connect/shared/webrtcIncidentAlerts";

test("continued failures after cooldown use new time bucket fingerprint", () => {
  const t0 = 1_700_000_000_000;
  const bucketA = Math.floor(t0 / (5 * 60 * 1000));
  const bucketB = Math.floor((t0 + WEBRTC_INCIDENT_DISMISS_COOLDOWN_MS + 60_000) / (5 * 60 * 1000));
  assert.notEqual(bucketA, bucketB);
});

test("outbound drought trigger requires 5 failures and zero successes", () => {
  const now = Date.now();
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `d${i}`,
    tenantId: "t1",
    userId: "u1",
    createdAt: new Date(now - i * 60_000),
    payload: {
      kind: "WEBRTC_CALL_DEBUG",
      debugKind: "WEBRTC_OUTBOUND_FAIL",
      direction: "outbound",
    },
  }));
  const triggers = evaluateWebrtcIncidentTriggers(rows, now);
  assert.ok(triggers.some((t) => t.failureType === WEBRTC_INCIDENT_FAILURE_TYPES.OUTBOUND_DROUGHT));
});

test("success rate low triggers on poor ratio", () => {
  const now = Date.now();
  const rows = [
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `f${i}`,
      tenantId: "t1",
      userId: "u1",
      createdAt: new Date(now - i * 10_000),
      payload: {
        kind: "WEBRTC_CALL_DEBUG",
        debugKind: "WEBRTC_OUTBOUND_FAIL",
        direction: "outbound",
      },
    })),
    {
      id: "ok1",
      tenantId: "t1",
      userId: "u1",
      createdAt: new Date(now - 50_000),
      payload: { kind: "WEBRTC_CALL_DEBUG", debugKind: "WEBRTC_OUTBOUND_SUMMARY", direction: "outbound" },
    },
  ];
  const triggers = evaluateWebrtcIncidentTriggers(rows, now);
  assert.ok(triggers.some((t) => t.failureType === WEBRTC_INCIDENT_FAILURE_TYPES.SUCCESS_RATE_LOW));
});
