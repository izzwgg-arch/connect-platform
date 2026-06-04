import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeOfferSdp,
  isWebrtcSdpRejection,
  sdpRejectionLabel,
  checkOfferCompatibility,
  redactSdpForDebug,
  SDP_REJECT_SIP_CODES,
} from "./webrtcSdpDiagnostics";

// A representative browser WebRTC audio offer (opus + telephone-event + PCMU/PCMA),
// DTLS-SRTP, rtcp-mux, BUNDLE — the shape Asterisk webrtc=yes endpoints accept.
const HEALTHY_OFFER = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 0 8 110",
  "c=IN IP4 0.0.0.0",
  "a=rtcp-mux",
  "a=ice-ufrag:abcd",
  "a=ice-pwd:0123456789abcdef0123",
  "a=fingerprint:sha-256 AA:BB:CC",
  "a=setup:actpass",
  "a=mid:0",
  "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
  "a=sendrecv",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:0 PCMU/8000",
  "a=rtpmap:8 PCMA/8000",
  "a=rtpmap:110 telephone-event/48000",
  "",
].join("\r\n");

test("summarizeOfferSdp parses a healthy WebRTC audio offer", () => {
  const s = summarizeOfferSdp(HEALTHY_OFFER);
  assert.equal(s.audioMLineCount, 1);
  assert.deepEqual(s.profiles, ["UDP/TLS/RTP/SAVPF"]);
  assert.ok(s.hasOpus, "should detect opus");
  assert.ok(s.hasPcmu, "should detect PCMU/ulaw");
  assert.ok(s.hasPcma, "should detect PCMA/alaw");
  assert.ok(s.hasRtcpMux);
  assert.ok(s.hasBundle);
  assert.ok(s.hasDtlsFingerprint);
  assert.equal(s.dtlsSetup, "actpass");
  assert.ok(s.hasIceUfrag && s.hasIcePwd);
  assert.equal(s.extmapCount, 1);
  assert.deepEqual(s.audioCodecs, ["opus/48000/2", "PCMU/8000", "PCMA/8000", "telephone-event/48000"]);
});

test("summarizeOfferSdp never throws on junk input", () => {
  for (const junk of ["", "not an sdp", "m=audio", undefined as unknown as string]) {
    const s = summarizeOfferSdp(junk);
    assert.equal(typeof s.mLineCount, "number");
  }
});

test("checkOfferCompatibility flags a healthy offer as clean", () => {
  assert.deepEqual(checkOfferCompatibility(summarizeOfferSdp(HEALTHY_OFFER)), []);
});

test("checkOfferCompatibility flags a plain-RTP (non-DTLS) offer", () => {
  const plain = [
    "v=0",
    "m=audio 12345 RTP/AVP 0 8",
    "a=rtpmap:0 PCMU/8000",
    "a=rtpmap:8 PCMA/8000",
    "",
  ].join("\r\n");
  const issues = checkOfferCompatibility(summarizeOfferSdp(plain));
  assert.ok(issues.some((i) => i.includes("non-secure media profile")), issues.join(" | "));
  assert.ok(issues.some((i) => i.includes("missing a=fingerprint")), issues.join(" | "));
});

test("checkOfferCompatibility flags an offer with no acceptable codec", () => {
  const noCodec = [
    "v=0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 99",
    "a=fingerprint:sha-256 AA",
    "a=ice-ufrag:x",
    "a=ice-pwd:y",
    "a=rtcp-mux",
    "a=rtpmap:99 G722/8000",
    "",
  ].join("\r\n");
  const issues = checkOfferCompatibility(summarizeOfferSdp(noCodec));
  assert.ok(issues.some((i) => i.includes("no codec")), issues.join(" | "));
});

test("isWebrtcSdpRejection detects 488/606 and cause text", () => {
  assert.ok(isWebrtcSdpRejection({ sipCode: 488 }));
  assert.ok(isWebrtcSdpRejection({ sipCode: 606 }));
  assert.ok(isWebrtcSdpRejection({ cause: "Incompatible SDP" }));
  assert.ok(isWebrtcSdpRejection({ cause: "Not Acceptable Here" }));
  assert.equal(isWebrtcSdpRejection({ sipCode: 486, cause: "Busy Here" }), false);
  assert.equal(isWebrtcSdpRejection({ sipCode: null, cause: null }), false);
});

test("SDP_REJECT_SIP_CODES is the JsSIP INCOMPATIBLE_SDP set", () => {
  assert.deepEqual([...SDP_REJECT_SIP_CODES], [488, 606]);
});

test("sdpRejectionLabel is stable for telemetry", () => {
  assert.equal(sdpRejectionLabel(488), "WEBRTC_SDP_REJECT_488");
  assert.equal(sdpRejectionLabel(null), "WEBRTC_SDP_REJECT");
});

test("redactSdpForDebug strips ICE creds + candidate IPs but keeps diagnosis fields", () => {
  const sdp = [
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 0 8",
    "c=IN IP4 192.168.1.50",
    "a=ice-ufrag:SUPERSECRETUFRAG",
    "a=ice-pwd:SUPERSECRETPASSWORD0123456789",
    "a=candidate:1 1 udp 2122260223 192.168.1.50 54321 typ host",
    "a=fingerprint:sha-256 AA:BB:CC:DD",
    "a=setup:actpass",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;useinbandfec=1",
  ].join("\r\n");
  const out = redactSdpForDebug(sdp);
  assert.ok(!out.includes("SUPERSECRETUFRAG"), "ufrag must be redacted");
  assert.ok(!out.includes("SUPERSECRETPASSWORD0123456789"), "pwd must be redacted");
  assert.ok(!out.includes("192.168.1.50"), "candidate/connection IP must be masked");
  assert.ok(out.includes("a=ice-ufrag:[REDACTED]"));
  assert.ok(out.includes("a=ice-pwd:[REDACTED]"));
  // Diagnosis-critical fields preserved:
  assert.ok(out.includes("opus/48000/2"), "codec kept");
  assert.ok(out.includes("a=fmtp:111 minptime=10;useinbandfec=1"), "fmtp kept");
  assert.ok(out.includes("UDP/TLS/RTP/SAVPF"), "profile kept");
  assert.ok(out.includes("a=fingerprint:sha-256 AA:BB:CC:DD"), "DTLS fingerprint kept (public)");
  assert.ok(out.includes("typ host"), "candidate type kept");
});
