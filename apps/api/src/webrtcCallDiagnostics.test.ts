import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWebrtcCallDebugPayload,
  parseWebrtcCallDebugBody,
  buildCompactWebrtcDebugLog,
  webrtcAlertQuerySpec,
} from "./voice/webrtcCallDiagnostics";

test("parseWebrtcCallDebugBody accepts full outbound blackbox payload", () => {
  const parsed = parseWebrtcCallDebugBody({
    schemaVersion: 2,
    payloadVersion: 2,
    debugKind: "WEBRTC_SDP_REJECT",
    platform: "WEB",
    direction: "outbound",
    correlationId: "corr_abc",
    callAttemptId: "web_abc",
    identity: { tenantId: "t1", authUsername: "T2_103_1" },
    timeline: [{ stage: "ua_call_invoked", tsMs: Date.now() }],
    peerConnection: {
      snapshot: { iceConnectionState: "checking" },
      offerSummary: { audioMLine: "m=audio 9 UDP/TLS/RTP/SAVPF 111", candidateCount: 2 },
    },
    sipFailure: { sipStatusCode: 488, failedCause: "Incompatible SDP" },
    pbxHint: { endpointName: "T2_103_1", channelNotCreated: true },
    diagnosisCategory: "OUTBOUND_MEDIA_SDP_REJECTED",
  });
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.platform, "WEB");
});

test("normalizeWebrtcCallDebugPayload adds kind and schema defaults", () => {
  const payload = normalizeWebrtcCallDebugPayload(
    parseWebrtcCallDebugBody({
      sipStatusCode: 488,
      failedCause: "Incompatible SDP",
      platform: "MOBILE",
      direction: "outbound",
    }),
  );
  assert.equal(payload.kind, "WEBRTC_CALL_DEBUG");
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.debugKind, "WEBRTC_SDP_REJECT");
});

test("buildCompactWebrtcDebugLog includes WEBRTC_CALL_DEBUG tag fields", () => {
  const line = buildCompactWebrtcDebugLog({
    schemaVersion: 2,
    debugKind: "WEBRTC_INBOUND_ANSWER_FAIL",
    callAttemptId: "mob_x",
    diagnosisCategory: "INBOUND_SESSION_NOT_FOUND_TIMEOUT",
  });
  const parsed = JSON.parse(line);
  assert.equal(parsed.tag, "WEBRTC_CALL_DEBUG");
  assert.equal(parsed.debugKind, "WEBRTC_INBOUND_ANSWER_FAIL");
});

test("webrtcAlertQuerySpec includes outbound fail cluster", () => {
  const spec = webrtcAlertQuerySpec("webrtc_outbound_fail_cluster");
  assert.equal(spec.windowMinutes, 5);
  assert.equal(spec.threshold, 3);
});

test("parseWebrtcCallDebugBody rejects oversized strings cleanly", () => {
  assert.throws(() =>
    parseWebrtcCallDebugBody({
      offerSdpRedacted: "x".repeat(25_000),
    }),
  );
});
