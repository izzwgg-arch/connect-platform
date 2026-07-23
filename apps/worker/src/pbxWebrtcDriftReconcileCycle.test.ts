// Pure unit tests for the WebRTC drift-reconcile alert decision. No DB, no
// PBX — mirrors the pure-function test style already used for the other
// worker reconcile cycles (e.g. `wakeCanaryEnrollCycle.test.ts`,
// `voicemailSpoolReconcileCycle`'s `evaluateVoicemailSpoolReconcileHealth`).
import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePbxWebrtcDriftAlert } from "./pbxWebrtcDriftReconcileCycle";

test("no alert when nothing drifted and every PBX instance was reachable", () => {
  const { alert, reasons } = evaluatePbxWebrtcDriftAlert({ total_live_confirmed_webrtc: 0, instance_errors: 0 });
  assert.equal(alert, false);
  assert.deepEqual(reasons, []);
});

test("alerts when the bulk VitalPBX API missed at least one live WebRTC device (the ext 107 / T8 shape)", () => {
  const { alert, reasons } = evaluatePbxWebrtcDriftAlert({ total_live_confirmed_webrtc: 1, instance_errors: 0 });
  assert.equal(alert, true);
  assert.ok(reasons.includes("bulk_vitalpbx_api_missed_a_live_webrtc_device"));
});

test("alerts when a PBX instance was unreachable this cycle", () => {
  const { alert, reasons } = evaluatePbxWebrtcDriftAlert({ total_live_confirmed_webrtc: 0, instance_errors: 1 });
  assert.equal(alert, true);
  assert.ok(reasons.includes("pbx_instance_unreachable_or_credentials_invalid"));
});

test("reports both reasons together when both conditions are true", () => {
  const { alert, reasons } = evaluatePbxWebrtcDriftAlert({ total_live_confirmed_webrtc: 2, instance_errors: 1 });
  assert.equal(alert, true);
  assert.equal(reasons.length, 2);
});
