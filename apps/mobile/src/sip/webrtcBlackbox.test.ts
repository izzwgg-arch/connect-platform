import { test } from "node:test";
import assert from "node:assert/strict";
import {
  redactSdpForDebug,
  summarizeOfferSdp,
  finalizeBlackboxPayload,
} from "@connect/shared/webrtcBlackbox";
import { MobileWebrtcBlackboxRecorder } from "./webrtcBlackboxRecorder";

test("MobileWebrtcBlackboxRecorder builds outbound failure payload", () => {
  const rec = new MobileWebrtcBlackboxRecorder();
  rec.setIdentity({ authUsername: "T25_101_1", extensionNumber: "101" });
  rec.mark("ua_call_invoked");
  const payload = rec.buildOutboundFailurePayload({
    targetRaw: "8457823064",
    targetNormalized: "8457823064",
    failedEvent: { cause: "Incompatible SDP", message: { status_code: 488 } },
    channelNotCreated: true,
  });
  assert.equal(payload.platform, "MOBILE");
  assert.equal(payload.diagnosisCategory, "OUTBOUND_MEDIA_SDP_REJECTED");
  assert.ok(Array.isArray(payload.timeline));
});

test("redactSdpForDebug strips secrets from mobile path", () => {
  const sdp = "a=ice-ufrag:SECRET\na=rtpmap:111 opus/48000/2\n";
  const out = redactSdpForDebug(sdp);
  assert.ok(!out.includes("SECRET"));
  assert.ok(out.includes("opus"));
});

test("finalizeBlackboxPayload redacts password keys", () => {
  const out = finalizeBlackboxPayload({ sipPassword: "x", schemaVersion: 2 });
  assert.equal((out as Record<string, unknown>).sipPassword, "[REDACTED]");
});
