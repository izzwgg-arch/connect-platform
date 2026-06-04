import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWebrtcIncidentFingerprint,
  evaluateWebrtcIncidentTriggers,
  isWebrtcFailurePayload,
  WEBRTC_INCIDENT_FAILURE_TYPES,
} from "./webrtcIncidentAlerts";

function row(
  tenantId: string,
  payload: Record<string, unknown>,
  offsetMs = 0,
  id?: string,
): { id: string; tenantId: string; userId: string; createdAt: Date; payload: Record<string, unknown> } {
  return {
    id: id ?? `ev_${offsetMs}`,
    tenantId,
    userId: "user1",
    createdAt: new Date(Date.now() - offsetMs),
    payload,
  };
}

test("buildWebrtcIncidentFingerprint includes tenant and time bucket", () => {
  const fp = buildWebrtcIncidentFingerprint("t1", "outbound_fail_cluster", 1_700_000_000_000);
  assert.match(fp, /^webrtc:t1:outbound_fail_cluster:\d+$/);
});

test("evaluateWebrtcIncidentTriggers fires outbound cluster at 3 failures in 5 min", () => {
  const failures = [0, 30_000, 60_000].map((ms, i) =>
    row(
      "t1",
      {
        kind: "WEBRTC_CALL_DEBUG",
        debugKind: "WEBRTC_OUTBOUND_FAIL",
        direction: "outbound",
        sipFailure: { sipStatusCode: 486, failedCause: "Busy" },
      },
      ms,
      `f${i}`,
    ),
  );
  const triggers = evaluateWebrtcIncidentTriggers(failures);
  const cluster = triggers.find((t) => t.failureType === WEBRTC_INCIDENT_FAILURE_TYPES.OUTBOUND_FAIL_CLUSTER);
  assert.ok(cluster);
  assert.equal(cluster!.severity, "critical");
  assert.equal(cluster!.count, 3);
});

test("evaluateWebrtcIncidentTriggers does not alert below outbound threshold", () => {
  const failures = [0, 30_000].map((ms, i) =>
    row("t1", { kind: "WEBRTC_CALL_DEBUG", debugKind: "WEBRTC_OUTBOUND_FAIL", direction: "outbound" }, ms, `f${i}`),
  );
  const triggers = evaluateWebrtcIncidentTriggers(failures);
  assert.equal(
    triggers.find((t) => t.failureType === WEBRTC_INCIDENT_FAILURE_TYPES.OUTBOUND_FAIL_CLUSTER),
    undefined,
  );
});

test("evaluateWebrtcIncidentTriggers detects 488 cluster", () => {
  const failures = [0, 45_000].map((ms, i) =>
    row(
      "t1",
      {
        kind: "WEBRTC_CALL_DEBUG",
        debugKind: "WEBRTC_SDP_REJECT",
        direction: "outbound",
        sipFailure: { sipStatusCode: 488, failedCause: "Incompatible SDP" },
      },
      ms,
      `s${i}`,
    ),
  );
  const triggers = evaluateWebrtcIncidentTriggers(failures);
  assert.ok(triggers.some((t) => t.failureType === WEBRTC_INCIDENT_FAILURE_TYPES.SDP_488_CLUSTER));
});

test("evaluateWebrtcIncidentTriggers detects inbound answer fail cluster", () => {
  const failures = [0, 20_000].map((ms, i) =>
    row(
      "t1",
      {
        kind: "WEBRTC_CALL_DEBUG",
        debugKind: "WEBRTC_INBOUND_ANSWER_FAIL",
        direction: "inbound",
        diagnosisCategory: "INBOUND_SESSION_NOT_FOUND_TIMEOUT",
      },
      ms,
      `i${i}`,
    ),
  );
  const triggers = evaluateWebrtcIncidentTriggers(failures);
  assert.ok(triggers.some((t) => t.failureType === WEBRTC_INCIDENT_FAILURE_TYPES.INBOUND_ANSWER_FAIL_CLUSTER));
});

test("isWebrtcFailurePayload detects legacy Incompatible SDP endReason", () => {
  assert.ok(isWebrtcFailurePayload({ endReason: "Incompatible SDP", qualityGrade: "failed" }));
});
