import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BlackboxTimeline,
  checkOfferCompatibility,
  classifyInboundDiagnosis,
  classifyOutboundDiagnosis,
  compactBlackboxLogLine,
  finalizeBlackboxPayload,
  hashStableId,
  redactSdpForDebug,
  redactSecretsDeep,
  summarizeJsSipFailureEvent,
  summarizeOfferSdp,
  truncateBlackboxPayload,
  WEBRTC_BLACKBOX_MAX_JSON_BYTES,
} from "./webrtcBlackbox";

const HEALTHY_OFFER = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 0 8",
  "a=rtcp-mux",
  "a=ice-ufrag:SECRETUFRAG",
  "a=ice-pwd:SECRETPASSWORD012345678901234567890",
  "a=candidate:1 1 udp 2122260223 192.168.1.50 54321 typ host",
  "a=candidate:2 1 udp 1694498815 203.0.113.1 54322 typ srflx",
  "a=fingerprint:sha-256 AA:BB",
  "a=setup:actpass",
  "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:0 PCMU/8000",
  "",
].join("\r\n");

test("summarizeOfferSdp captures extended black-box fields", () => {
  const s = summarizeOfferSdp(HEALTHY_OFFER);
  assert.ok(s.audioMLine?.startsWith("m=audio"));
  assert.deepEqual(s.profiles, ["UDP/TLS/RTP/SAVPF"]);
  assert.ok(s.payloadTypes.includes("111"));
  assert.equal(s.candidateCount, 2);
  assert.deepEqual(s.candidateTypes, ["host", "srflx"]);
  assert.equal(s.extmapCount, 1);
  assert.ok(s.fmtpLines.some((l) => l.includes("minptime")));
});

test("redactSdpForDebug strips ICE creds and masks IPs", () => {
  const out = redactSdpForDebug(HEALTHY_OFFER);
  assert.ok(!out.includes("SECRETUFRAG"));
  assert.ok(!out.includes("192.168.1.50"));
  assert.ok(out.includes("opus/48000/2"));
  assert.ok(out.includes("a=ice-ufrag:[REDACTED]"));
});

test("redactSecretsDeep removes JWT and password keys", () => {
  const out = redactSecretsDeep({
    authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def",
    sipPassword: "secret123",
    nested: { icePwd: "x" },
  }) as Record<string, unknown>;
  assert.equal(out.authorization, "[REDACTED]");
  assert.equal(out.sipPassword, "[REDACTED]");
  assert.deepEqual(out.nested, { icePwd: "[REDACTED]" });
});

test("summarizeJsSipFailureEvent maps Incompatible SDP to upstream", () => {
  const s = summarizeJsSipFailureEvent({
    cause: "Incompatible SDP",
    originator: "remote",
    message: { status_code: 488, reason_phrase: "Not Acceptable Here", method: "INVITE" },
  });
  assert.equal(s.sipStatusCode, 488);
  assert.equal(s.sipRejectionSource, "asterisk_or_upstream");
});

test("classifyOutboundDiagnosis maps 488 to SDP rejected", () => {
  assert.equal(
    classifyOutboundDiagnosis({ sipCode: 488, sipCause: "Incompatible SDP" }),
    "OUTBOUND_MEDIA_SDP_REJECTED",
  );
});

test("classifyInboundDiagnosis maps session_not_found_timeout", () => {
  assert.equal(
    classifyInboundDiagnosis({ failureReason: "session_not_found_timeout" }),
    "INBOUND_SESSION_NOT_FOUND_TIMEOUT",
  );
});

test("truncateBlackboxPayload marks truncated when oversized", () => {
  const bigSdp = "x".repeat(WEBRTC_BLACKBOX_MAX_JSON_BYTES);
  const { payload, truncated } = truncateBlackboxPayload({
    schemaVersion: 2,
    offerSdpRedacted: bigSdp,
    debugKind: "WEBRTC_SDP_REJECT",
  });
  assert.equal(truncated, true);
  assert.ok(payload.truncated === true || payload.truncateReason != null);
});

test("finalizeBlackboxPayload applies redaction and truncation", () => {
  const p = finalizeBlackboxPayload({
    schemaVersion: 2,
    sipPassword: "nope",
    offerSdpRedacted: redactSdpForDebug(HEALTHY_OFFER),
  });
  assert.equal((p as Record<string, unknown>).sipPassword, "[REDACTED]");
});

test("compactBlackboxLogLine is grep-friendly JSON", () => {
  const line = compactBlackboxLogLine({
    schemaVersion: 2,
    debugKind: "WEBRTC_SDP_REJECT",
    callAttemptId: "wbb_abc",
    sipFailure: { sipStatusCode: 488 },
    diagnosisCategory: "OUTBOUND_MEDIA_SDP_REJECTED",
  });
  const parsed = JSON.parse(line);
  assert.equal(parsed.tag, "WEBRTC_CALL_DEBUG");
  assert.equal(parsed.sipStatusCode, 488);
});

test("BlackboxTimeline records ordered stages with ms timestamps", () => {
  const tl = new BlackboxTimeline("wbb_test", "corr_test");
  tl.mark("dial_start");
  tl.mark("ua_call_invoked");
  const stages = tl.toJSON();
  assert.equal(stages.length, 3);
  assert.equal(stages[0].stage, "blackbox_started");
  assert.ok(stages[1].tsMs >= stages[0].tsMs);
});

test("hashStableId is stable", () => {
  assert.equal(hashStableId("device-abc"), hashStableId("device-abc"));
  assert.notEqual(hashStableId("a"), hashStableId("b"));
});
