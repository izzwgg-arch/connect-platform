import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateWebrtcIncidentTriggers,
  WEBRTC_INCIDENT_FAILURE_TYPES,
} from "@connect/shared/webrtcIncidentAlerts";

test("admin alert: 3 outbound failures in 5 minutes crosses threshold", () => {
  const now = Date.now();
  const rows = [0, 60_000, 120_000].map((ago, i) => ({
    id: `o${i}`,
    tenantId: "tenant_a",
    userId: "u1",
    createdAt: new Date(now - ago),
    payload: {
      kind: "WEBRTC_CALL_DEBUG",
      debugKind: "WEBRTC_OUTBOUND_FAIL",
      direction: "outbound",
    },
  }));
  const triggers = evaluateWebrtcIncidentTriggers(rows, now);
  assert.ok(
    triggers.some((t) => t.failureType === WEBRTC_INCIDENT_FAILURE_TYPES.OUTBOUND_FAIL_CLUSTER),
  );
});

test("admin alert: 2 failures stay below outbound cluster threshold", () => {
  const now = Date.now();
  const rows = [0, 60_000].map((ago, i) => ({
    id: `o${i}`,
    tenantId: "tenant_a",
    userId: "u1",
    createdAt: new Date(now - ago),
    payload: { kind: "WEBRTC_CALL_DEBUG", debugKind: "WEBRTC_OUTBOUND_FAIL", direction: "outbound" },
  }));
  const triggers = evaluateWebrtcIncidentTriggers(rows, now);
  assert.equal(
    triggers.find((t) => t.failureType === WEBRTC_INCIDENT_FAILURE_TYPES.OUTBOUND_FAIL_CLUSTER),
    undefined,
  );
});

test("admin alert: 488 cluster detected", () => {
  const now = Date.now();
  const rows = [0, 30_000].map((ago, i) => ({
    id: `s${i}`,
    tenantId: "tenant_a",
    userId: "u1",
    createdAt: new Date(now - ago),
    payload: {
      kind: "WEBRTC_CALL_DEBUG",
      debugKind: "WEBRTC_SDP_REJECT",
      direction: "outbound",
      sipFailure: { sipStatusCode: 488, failedCause: "Incompatible SDP" },
    },
  }));
  const triggers = evaluateWebrtcIncidentTriggers(rows, now);
  assert.ok(triggers.some((t) => t.failureType === WEBRTC_INCIDENT_FAILURE_TYPES.SDP_488_CLUSTER));
});

test("admin alert: inbound answer failure cluster at 2 events", () => {
  const now = Date.now();
  const rows = [0, 45_000].map((ago, i) => ({
    id: `i${i}`,
    tenantId: "tenant_a",
    userId: "u1",
    createdAt: new Date(now - ago),
    payload: {
      kind: "WEBRTC_CALL_DEBUG",
      debugKind: "WEBRTC_INBOUND_ANSWER_FAIL",
      direction: "inbound",
      diagnosisCategory: "INBOUND_SESSION_NOT_FOUND_TIMEOUT",
    },
  }));
  const triggers = evaluateWebrtcIncidentTriggers(rows, now);
  assert.ok(
    triggers.some((t) => t.failureType === WEBRTC_INCIDENT_FAILURE_TYPES.INBOUND_ANSWER_FAIL_CLUSTER),
  );
});
