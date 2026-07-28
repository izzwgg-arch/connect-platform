import assert from "node:assert/strict";
import { test } from "node:test";
import { preferOpusInSdp } from "./preferOpusSdp";

const SDP_ULAW_FIRST = [
  "v=0",
  "o=- 8422528703089886857 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 0 8 111 126",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:0 PCMU/8000",
  "a=rtpmap:8 PCMA/8000",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:126 telephone-event/8000",
].join("\r\n");

test("moves opus to the front of m=audio", () => {
  const out = preferOpusInSdp(SDP_ULAW_FIRST);
  assert.match(out, /m=audio 9 UDP\/TLS\/RTP\/SAVPF 111 0 8 126/);
  // rtpmap lines untouched
  assert.match(out, /a=rtpmap:111 opus\/48000\/2/);
  assert.match(out, /a=rtpmap:0 PCMU\/8000/);
});

test("no-op when opus is already first", () => {
  const sdp = SDP_ULAW_FIRST.replace(
    "m=audio 9 UDP/TLS/RTP/SAVPF 0 8 111 126",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 0 8 126",
  );
  assert.equal(preferOpusInSdp(sdp), sdp);
});

test("no-op when sdp has no opus", () => {
  const sdp = SDP_ULAW_FIRST
    .replace("a=rtpmap:111 opus/48000/2\r\n", "")
    .replace("a=fmtp:111 minptime=10;useinbandfec=1\r\n", "")
    .replace("m=audio 9 UDP/TLS/RTP/SAVPF 0 8 111 126", "m=audio 9 UDP/TLS/RTP/SAVPF 0 8 126");
  assert.equal(preferOpusInSdp(sdp), sdp);
});

test("does not touch m=video lines", () => {
  const sdp = SDP_ULAW_FIRST + "\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97\r\na=rtpmap:96 VP8/90000";
  const out = preferOpusInSdp(sdp);
  assert.match(out, /m=video 9 UDP\/TLS\/RTP\/SAVPF 96 97/);
});

test("handles empty/garbage input", () => {
  assert.equal(preferOpusInSdp(""), "");
  assert.equal(preferOpusInSdp("not an sdp"), "not an sdp");
});

test("opus-only offer strips narrowband codecs, keeps opus + dtmf", () => {
  const { preferOpusOnlyOffer } = require("./preferOpusSdp");
  const out = preferOpusOnlyOffer(SDP_ULAW_FIRST.replace(
    "m=audio 9 UDP/TLS/RTP/SAVPF 0 8 111 126",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 102 0 8 13 110 126",
  ) + "\r\na=rtpmap:63 red/48000/2\r\na=rtpmap:110 telephone-event/48000");
  assert.match(out, /m=audio 9 UDP\/TLS\/RTP\/SAVPF 111 63 110 126/);
});

test("opus-only offer is a no-op when sdp has no opus", () => {
  const { preferOpusOnlyOffer } = require("./preferOpusSdp");
  const noOpus = SDP_ULAW_FIRST
    .replace("a=rtpmap:111 opus/48000/2\r\n", "")
    .replace("a=fmtp:111 minptime=10;useinbandfec=1\r\n", "")
    .replace("m=audio 9 UDP/TLS/RTP/SAVPF 0 8 111 126", "m=audio 9 UDP/TLS/RTP/SAVPF 0 8 126");
  assert.equal(preferOpusOnlyOffer(noOpus), noOpus);
});
