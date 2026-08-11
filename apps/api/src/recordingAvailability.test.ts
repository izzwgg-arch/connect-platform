import { test } from "node:test";
import assert from "node:assert/strict";
import { isRecordingOfferable, shouldMarkRecordingMissing } from "./recordingAvailability";

// ── isRecordingOfferable ─────────────────────────────────────────────────────

test("a call with no stored path is not offerable", () => {
  assert.equal(isRecordingOfferable({ recordingPath: null }), false);
  assert.equal(isRecordingOfferable({ recordingPath: "" }), false);
  assert.equal(isRecordingOfferable({ recordingPath: "   " }), false);
  assert.equal(isRecordingOfferable(null), false);
  assert.equal(isRecordingOfferable(undefined), false);
});

test("a stored path with no confirmed absence is offerable", () => {
  assert.equal(isRecordingOfferable({ recordingPath: "/var/spool/asterisk/monitor/x/a.wav" }), true);
  assert.equal(
    isRecordingOfferable({ recordingPath: "/var/spool/asterisk/monitor/x/a.wav", recordingMissingAt: null }),
    true,
  );
});

test("THE FIX: a path the PBX has confirmed absent is NOT offerable", () => {
  // This is the dead play button. Trust Bookkeeping carried 183 of these across
  // August 2026 and one user clicked the same one four times in eight minutes.
  assert.equal(
    isRecordingOfferable({
      recordingPath: "/var/spool/asterisk/monitor/fb6a694802f40408/2026/08/04/135325-LOCAL-NONE-101-107-1785866005.163757.wav",
      recordingMissingAt: new Date("2026-08-11T18:00:00Z"),
    }),
    false,
  );
});

test("a string timestamp counts as confirmed absence (JSON round-trip)", () => {
  // Rows reach some call sites through JSON, where a Date becomes a string. If
  // that stopped counting, dead buttons would silently come back.
  assert.equal(
    isRecordingOfferable({ recordingPath: "/x/a.wav", recordingMissingAt: "2026-08-11T18:00:00.000Z" }),
    false,
  );
});

// ── shouldMarkRecordingMissing ───────────────────────────────────────────────

test("a 404 with no recovery is proof the call was never recorded", () => {
  assert.equal(shouldMarkRecordingMissing({ pbxStatus: 404, recovered: false }), true);
});

test("a 404 that recovery rescued is NOT missing — the audio exists on another leg", () => {
  // Queue/IVR calls record on a different channel leg, so the stored path 404s
  // while the real file is there. 26 of Trust Bookkeeping's August calls were
  // this case; marking them missing would have hidden real recordings.
  assert.equal(shouldMarkRecordingMissing({ pbxStatus: 404, recovered: true }), false);
});

test("⛔ a PBX that is merely unhappy NEVER hides a recording", () => {
  // The whole risk of this feature. "Cannot tell" must never become "does not
  // exist" — that would erase customers' recordings during a PBX blip.
  for (const pbxStatus of [500, 502, 503, 504, 401, 403, 429, 0, 200, 206]) {
    assert.equal(
      shouldMarkRecordingMissing({ pbxStatus, recovered: false }),
      false,
      `status ${pbxStatus} must not mark a recording missing`,
    );
  }
});
