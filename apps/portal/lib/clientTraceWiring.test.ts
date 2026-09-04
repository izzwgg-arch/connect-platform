/**
 * ⛔ SOURCE GUARDS — the client trace is only worth anything if the softphone
 * actually CALLS it at the sites that matter. A unit test of lib/clientTrace.ts
 * passes straight through a hook that never traces a failed setSinkId, and that
 * silent failure was the whole 2026-09-03 headset investigation.
 *
 * Replayable against the pre-change tree with PORTAL_GUARD_ROOT to prove each
 * assertion is non-vacuous. Reads are CRLF-normalised (core.autocrlf=true).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.env.PORTAL_GUARD_ROOT || path.join(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

const hook = code(read("hooks/useSipPhone.ts"));
const mini = code(read("components/DesktopMiniDialer.tsx"));
const floating = code(read("components/FloatingDialer.tsx"));

function block(src: string, startMarker: string, endMarker: string): string {
  const s = src.indexOf(startMarker);
  assert.ok(s >= 0, `marker not found: ${startMarker}`);
  const e = src.indexOf(endMarker, s + startMarker.length);
  assert.ok(e > s, `end marker not found after ${startMarker}: ${endMarker}`);
  return src.slice(s, e);
}

test("⛔ a failed setSinkId is a TIMELINE EVENT, not a console line", () => {
  const applySink = block(hook, "const applySink = useCallback(", "const setAudioSinkId = useCallback(");
  assert.match(applySink, /trace\("speaker_select_failed"/, "applySink must trace the failure");
  assert.match(applySink, /trace\("speaker_selected"/, "applySink must trace the success too, with the label");
  assert.match(applySink, /error: String\(e\?\.name/, "the error NAME must travel (NotFoundError = the device is gone)");
});

test("⛔ the device inventory and the auto-picked mic are recorded, with labels", () => {
  const refresh = block(hook, "const refreshAudioDevices = useCallback(", "const setAudioInputDeviceId = useCallback(");
  assert.match(refresh, /trace\("device_inventory", \{ \.\.\.summarizeDevices\(devices\)/);
  assert.match(refresh, /trace\("mic_auto_picked"/);
  assert.match(refresh, /speakerLabel: labelFor\(outputs, preferredSinkIdRef\.current\)/, "the auto-pick must record the speaker it was NOT paired with");
});

test("⛔ the microphone the call REALLY got is recorded from the track, not the id we asked for", () => {
  const acquire = block(hook, "const acquireMicStream = useCallback(", "const setExternalMicrophoneStream = useCallback(");
  assert.match(acquire, /trace\("mic_opened"/);
  assert.match(acquire, /label: t\?\.label/);
  assert.match(acquire, /trace\("mic_open_failed"/);
});

test("⛔ remote audio attach records the element's REAL sinkId and the play() outcome", () => {
  const attach = block(hook, "function attachRemoteStream(stream: MediaStream)", "function syncReceiversToAudio(");
  assert.match(attach, /\.sinkId \?\? currentSinkIdRef\.current/, "el.sinkId is the truth; the ref is what we asked for");
  assert.match(attach, /trace\("remote_audio_attached", \{ \.\.\.attachedFacts, play: "ok" \}\)/);
  assert.match(attach, /trace\("remote_audio_play_blocked"/);
  assert.match(attach, /remoteAudioSeenRef\.current = live/);
});

test("⛔ the one-way-audio detector and the remote-track lifecycle reach the server", () => {
  assert.match(hook, /trace\("one_way_audio"/);
  assert.match(hook, /trace\("incoming_audio_resumed"/);
  assert.match(hook, /trace\("remote_track_muted"/);
  assert.match(hook, /trace\("remote_track_unmuted"/);
  assert.match(hook, /trace\("remote_track_ended"/);
  assert.match(hook, /trace\("reg_state", \{ state: regState \}\)/);
});

test("⛔ every press on the call path is recorded — and DTMF carries a COUNT, never the digit", () => {
  for (const action of ["dial", "answer", "hangup", "hold", "mute", "dtmf"]) {
    assert.match(hook, new RegExp(`trace\\("press", \\{ action: (?:"${action}"|[^}]*"${action}")`), `press ${action} is not traced`);
  }
  const dtmf = /trace\("press", \{ action: "dtmf"[^}]*\}\)/.exec(hook);
  assert.ok(dtmf, "dtmf press trace not found");
  assert.doesNotMatch(dtmf![0], /digit\b(?!s)/, "the DTMF trace must not carry the digit");
  const dial = /trace\("press", \{ action: "dial"[^}]*\}\)/.exec(hook);
  assert.ok(dial);
  assert.match(dial![0], /digits: String\(target/, "dial must record a digit COUNT");
  assert.doesNotMatch(dial![0], /target,|target \}/, "dial must not record the number itself");
  assert.match(hook, /trace\("speaker_toggle"/);
});

test("⛔ the end-of-call report reads remoteAudioReceiving through the REF and names the devices", () => {
  // ⛔ the end marker must be CODE — whole-line comments are stripped above.
  const report = block(hook, 'apiPost("/voice/diag/call-quality-report"', 'apiPost("/voice/diag/call-quality-ping/clear"');
  assert.match(report, /remoteAudioReceiving: remoteAudioSeenRef\.current === true/, "diag.remoteAudioReceiving is reset by teardown before this runs (false in 53/53 reports)");
  assert.doesNotMatch(report, /remoteAudioReceiving: diag\.remoteAudioReceiving/);
  for (const f of ["lastCallError:", "micLabel:", "speakerLabel:", "micId:", "speakerId:", "speakerOn,"]) assert.ok(report.includes(f), `${f} missing from the report`);
  assert.match(report, /trace\("call_end"[\s\S]*\{ flush: true \}\)/, "call_end must flush immediately");
});

test("⛔ one diagnostics session per window — the hook delegates to the shared module", () => {
  assert.match(hook, /import \{ ensureVoiceDiagSession \} from "\.\.\/lib\/voiceDiagSession"/);
  assert.match(hook, /function ensureDiagSession\(\): Promise<string \| null> \{\s*return ensureVoiceDiagSession\(\);/);
  assert.doesNotMatch(hook, /let diagSessionPromise/, "the private session promise must be gone");
});

test("the dialer surfaces record settings opens and the ringer pick", () => {
  assert.match(mini, /trace\("settings_opened", \{ surface: "mini" \}\)/);
  assert.match(mini, /trace\("ringer_selected"/);
  assert.match(floating, /trace\("settings_opened", \{ surface: "floating" \}\)/);
});
