import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGlobalOutageFingerprint,
  evaluateGlobalWebrtcOutage,
  GLOBAL_INBOUND_CLUSTER_MIN,
  GLOBAL_MULTI_TENANT_MIN,
  GLOBAL_SDP_CLUSTER_MIN,
  GLOBAL_SUCCESS_RATE_MIN_ATTEMPTS,
  GLOBAL_WEBRTC_OUTAGE_TYPE,
} from "./webrtcGlobalOutageAlerts";

const now = Date.now();

function row(
  tenantId: string,
  payload: Record<string, unknown>,
  agoMs = 0,
  id?: string,
): { id: string; tenantId: string; userId: string; createdAt: Date; payload: Record<string, unknown> } {
  return {
    id: id ?? `e_${tenantId}_${agoMs}`,
    tenantId,
    userId: `u_${tenantId}`,
    createdAt: new Date(now - agoMs),
    payload,
  };
}

function outboundFail(tenantId: string, agoMs = 0) {
  return row(tenantId, { kind: "WEBRTC_CALL_DEBUG", debugKind: "WEBRTC_OUTBOUND_FAIL", direction: "outbound" }, agoMs);
}

function sdpFail(tenantId: string, agoMs = 0) {
  return row(
    tenantId,
    {
      kind: "WEBRTC_CALL_DEBUG",
      debugKind: "WEBRTC_SDP_REJECT",
      direction: "outbound",
      sipFailure: { sipStatusCode: 488, failedCause: "Incompatible SDP" },
    },
    agoMs,
  );
}

function inboundFail(tenantId: string, agoMs = 0) {
  return row(
    tenantId,
    {
      kind: "WEBRTC_CALL_DEBUG",
      debugKind: "WEBRTC_INBOUND_ANSWER_FAIL",
      direction: "inbound",
      diagnosisCategory: "INBOUND_SESSION_NOT_FOUND_TIMEOUT",
    },
    agoMs,
  );
}

test("buildGlobalOutageFingerprint is stable per 15-minute bucket", () => {
  const a = buildGlobalOutageFingerprint(1_700_000_000_000);
  const b = buildGlobalOutageFingerprint(1_700_000_000_000 + 60_000);
  assert.equal(a, b);
});

test("3-tenant trigger fires GLOBAL_WEBRTC_OUTAGE", () => {
  const rows = [
    outboundFail("T2", 60_000),
    outboundFail("T25", 50_000),
    outboundFail("T7", 40_000),
  ];
  const snap = evaluateGlobalWebrtcOutage({ diagRows: rows, nowMs: now });
  assert.ok(snap);
  assert.equal(snap!.failureType, GLOBAL_WEBRTC_OUTAGE_TYPE);
  assert.ok(snap!.reasons.includes("multi_tenant_failures"));
  assert.equal(snap!.severity, "critical");
  assert.equal(snap!.affectedTenantIds.length, 3);
});

test("below 3 tenants does not trigger multi-tenant alone", () => {
  const rows = [outboundFail("T2", 60_000), outboundFail("T2", 50_000)];
  const snap = evaluateGlobalWebrtcOutage({ diagRows: rows, nowMs: now });
  assert.equal(snap, null);
});

test("SDP cluster trigger at 10 failures", () => {
  const rows = Array.from({ length: GLOBAL_SDP_CLUSTER_MIN }, (_, i) =>
    sdpFail(`T${i % 3}`, i * 1000),
  );
  const snap = evaluateGlobalWebrtcOutage({ diagRows: rows, nowMs: now });
  assert.ok(snap);
  assert.ok(snap!.reasons.includes("sdp_cluster"));
  assert.equal(snap!.sdpFailureCount, GLOBAL_SDP_CLUSTER_MIN);
});

test("inbound cluster trigger at 10 failures", () => {
  const rows = Array.from({ length: GLOBAL_INBOUND_CLUSTER_MIN }, (_, i) =>
    inboundFail(`T${i % 4}`, i * 1000),
  );
  const snap = evaluateGlobalWebrtcOutage({ diagRows: rows, nowMs: now });
  assert.ok(snap);
  assert.ok(snap!.reasons.includes("inbound_cluster"));
});

test("success-rate trigger requires minimum sample count", () => {
  const fails = Array.from({ length: 9 }, (_, i) => outboundFail("T2", i * 1000));
  const snap = evaluateGlobalWebrtcOutage({ diagRows: fails, nowMs: now });
  assert.equal(snap, null);
});

test("success-rate collapse trigger", () => {
  const fails = Array.from({ length: GLOBAL_SUCCESS_RATE_MIN_ATTEMPTS - 1 }, (_, i) =>
    outboundFail("T2", i * 1000),
  );
  const ok = row("T2", { kind: "WEBRTC_CALL_DEBUG", debugKind: "WEBRTC_OUTBOUND_SUMMARY", direction: "outbound" }, 500);
  const snap = evaluateGlobalWebrtcOutage({ diagRows: [...fails, ok], nowMs: now });
  assert.ok(snap);
  assert.ok(snap!.reasons.includes("success_rate_collapse"));
});

test("mixed-direction outage across tenants", () => {
  const rows = [
    outboundFail("T2", 100_000),
    outboundFail("T25", 90_000),
    inboundFail("T7", 80_000),
    inboundFail("T2", 70_000),
  ];
  const snap = evaluateGlobalWebrtcOutage({ diagRows: rows, nowMs: now });
  assert.ok(snap);
  assert.ok(snap!.reasons.includes("mixed_direction_outage"));
});

test("open incident tenant ids contribute to multi-tenant detection", () => {
  const rows = [outboundFail("T2", 60_000)];
  const snap = evaluateGlobalWebrtcOutage({
    diagRows: rows,
    openIncidentTenantIds: ["T2", "T25", "T7"],
    activeOpenIncidentCount: 5,
    nowMs: now,
  });
  assert.ok(snap);
  assert.ok(snap!.reasons.includes("multi_tenant_failures"));
  assert.equal(snap!.activeIncidentCount, 5);
});

test("aggregation includes sample diagnostic ids", () => {
  const rows = Array.from({ length: GLOBAL_SDP_CLUSTER_MIN }, (_, i) =>
    sdpFail("T2", i * 1000, `diag_${i}`),
  );
  const snap = evaluateGlobalWebrtcOutage({ diagRows: rows, nowMs: now });
  assert.ok(snap!.sampleDiagEventIds.length >= 5);
});

test("dedupe fingerprint changes across 15-minute buckets", () => {
  const bucketMs = 15 * 60 * 1000;
  const t0 = 1_700_000_000_000;
  const a = buildGlobalOutageFingerprint(t0);
  const b = buildGlobalOutageFingerprint(t0 + bucketMs);
  assert.notEqual(a, b);
});
