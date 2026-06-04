import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractJsSipFailureFields,
  inferSipRejectionSource,
  isWebrtcSdpRejection,
  snapshotPeerConnection,
  webrtcAlertThreshold,
  webrtcAlertWindowMinutes,
} from "./webrtcBlackbox";

test("extractJsSipFailureFields reads message.status_code (portal/JsSIP shape)", () => {
  const fields = extractJsSipFailureFields({
    cause: "Incompatible SDP",
    originator: "remote",
    message: { status_code: 488, reason_phrase: "Not Acceptable Here", method: "INVITE" },
  });
  assert.equal(fields.sipStatusCode, 488);
  assert.equal(fields.sipReasonPhrase, "Not Acceptable Here");
  assert.equal(fields.sipMethod, "INVITE");
  assert.equal(fields.failedOriginator, "remote");
});

test("extractJsSipFailureFields falls back to response.status_code (legacy mobile shape)", () => {
  const fields = extractJsSipFailureFields({
    cause: "Incompatible SDP",
    response: { status_code: 488, reason_phrase: "Not Acceptable Here" },
  });
  assert.equal(fields.sipStatusCode, 488);
  assert.equal(fields.sipReasonPhrase, "Not Acceptable Here");
});

test("inferSipRejectionSource marks remote 488 as asterisk_or_upstream", () => {
  const fields = extractJsSipFailureFields({
    cause: "Incompatible SDP",
    originator: "remote",
    message: { status_code: 488 },
  });
  assert.equal(inferSipRejectionSource(fields), "asterisk_or_upstream");
});

test("inferSipRejectionSource uses cause when sip code missing (incident mobile capture bug)", () => {
  const fields = extractJsSipFailureFields({ cause: "Incompatible SDP" });
  assert.equal(inferSipRejectionSource(fields), "asterisk_or_upstream");
});

test("inferSipRejectionSource marks local originator as local_client", () => {
  const fields = extractJsSipFailureFields({
    cause: "User Denied Media Access",
    originator: "local",
  });
  assert.equal(inferSipRejectionSource(fields), "local_client");
});

test("isWebrtcSdpRejection detects 488/606 and cause text", () => {
  assert.ok(isWebrtcSdpRejection({ sipCode: 488 }));
  assert.ok(isWebrtcSdpRejection({ cause: "Incompatible SDP" }));
  assert.equal(isWebrtcSdpRejection({ sipCode: 486 }), false);
});

test("webrtc alert windows and thresholds are stable", () => {
  assert.equal(webrtcAlertWindowMinutes("webrtc_outbound_488_spike"), 15);
  assert.equal(webrtcAlertThreshold("webrtc_outbound_488_spike"), 2);
  assert.equal(webrtcAlertThreshold("inbound_claimed_no_sip_connect"), 1);
});
