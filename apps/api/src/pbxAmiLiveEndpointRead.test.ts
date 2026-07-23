import test from "node:test";
import assert from "node:assert/strict";
import { parsePjsipShowEndpointTranscript, buildWebrtcCandidateEndpointName } from "@connect/integrations";

// Fixture text shaped like a real Asterisk AMI `PJSIPShowEndpoint` transcript
// (see `_latency_logs/ami_webrtc_endpoint_dump.js` for the hand-run probe this
// mirrors). Multiple `\r\n\r\n`-delimited blocks joined with newlines, as
// `queryPjsipEndpointLive` does before handing text to the parser.
function webrtcEndpointFixture(name: string): string {
  return [
    `Response: Success\r\nEventList: start\r\nMessage: Detail will follow`,
    [
      `Event: EndpointDetail`,
      `ObjectType: endpoint`,
      `ObjectName: ${name}`,
      `Transport: transport-wss`,
      `Aor: ${name}`,
      `Auths: ${name}`,
      `OutboundAuths: ${name}`,
      `Context: from-internal`,
      `Webrtc: yes`,
      `MediaEncryption: dtls`,
      `DeviceState: Not in use`,
    ].join(`\r\n`),
    [`Event: AorDetail`, `ObjectType: aor`, `ObjectName: ${name}`, `Contacts: ${name}/sip:${name}@10.0.0.5`].join(`\r\n`),
    [`Event: AuthDetail`, `ObjectType: auth`, `ObjectName: ${name}`, `Username: ${name}`].join(`\r\n`),
    [`Event: EndpointDetailComplete`, `EventList: Complete`, `ListItems: 3`].join(`\r\n`),
  ].join("\n");
}

function deskPhoneFixture(name: string): string {
  return [
    `Response: Success\r\nEventList: start\r\nMessage: Detail will follow`,
    [
      `Event: EndpointDetail`,
      `ObjectType: endpoint`,
      `ObjectName: ${name}`,
      `Transport: transport-udp`,
      `Aor: ${name}`,
      `Auths: ${name}`,
      `MediaEncryption: no`,
    ].join(`\r\n`),
    [`Event: EndpointDetailComplete`, `EventList: Complete`, `ListItems: 1`].join(`\r\n`),
  ].join("\n");
}

function notFoundFixture(): string {
  return `Response: Error\r\nMessage: Endpoint not found`;
}

test("T8_101_1 (known-good) parses as WebRTC-capable: wss transport + dtls + aor + auth", () => {
  const detail = parsePjsipShowEndpointTranscript("T8_101_1", webrtcEndpointFixture("T8_101_1"));
  assert.equal(detail.exists, true);
  assert.equal(detail.isWebrtcCapable, true);
  assert.equal(detail.transport, "transport-wss");
  assert.equal(detail.mediaEncryption, "dtls");
  assert.equal(detail.webrtcFlag, true);
  assert.equal(detail.aor, "T8_101_1");
  assert.equal(detail.auth, "T8_101_1");
});

// Regression: this is the confirmed root cause for ext 107 (Gesheft / tenant
// T8) — T8_107_1 is a real, live wss+DTLS device, identical in shape to the
// known-good T8_101_1. A live AMI read must confirm it exists and is
// WebRTC-capable so the sync layer can treat it as present even when
// VitalPBX's REST API omitted it from a bulk response.
test("T8_107_1 (admin-GUI-created device Connect's API sync missed) parses identically to T8_101_1", () => {
  const good = parsePjsipShowEndpointTranscript("T8_101_1", webrtcEndpointFixture("T8_101_1"));
  const drifted = parsePjsipShowEndpointTranscript("T8_107_1", webrtcEndpointFixture("T8_107_1"));
  assert.equal(drifted.exists, true);
  assert.equal(drifted.isWebrtcCapable, true);
  assert.equal(drifted.transport, good.transport);
  assert.equal(drifted.mediaEncryption, good.mediaEncryption);
});

test("a plain desk-phone endpoint (udp, no dtls) is not WebRTC-capable", () => {
  const detail = parsePjsipShowEndpointTranscript("T8_108", deskPhoneFixture("T8_108"));
  assert.equal(detail.exists, true);
  assert.equal(detail.isWebrtcCapable, false);
});

test("a nonexistent endpoint parses as not-exists, not WebRTC-capable", () => {
  const detail = parsePjsipShowEndpointTranscript("T8_999_1", notFoundFixture());
  assert.equal(detail.exists, false);
  assert.equal(detail.isWebrtcCapable, false);
});

test("buildWebrtcCandidateEndpointName builds the deterministic T<code>_<ext>_1 name", () => {
  assert.equal(buildWebrtcCandidateEndpointName("T8", "107"), "T8_107_1");
  assert.equal(buildWebrtcCandidateEndpointName("T8_", "107"), "T8_107_1");
  assert.equal(buildWebrtcCandidateEndpointName("  T25  ", " 101 "), "T25_101_1");
});
