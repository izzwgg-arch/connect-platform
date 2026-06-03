import test from "node:test";
import assert from "node:assert/strict";
import { buildVoiceAudioConstraints } from "./voiceAudioConstraints.js";

test("voice audio constraints are Asterisk-compatible (no strict channelCount/sampleRate)", () => {
  const c = buildVoiceAudioConstraints();
  assert.equal(c.video, false);
  assert.ok(c.audio && typeof c.audio === "object");
  const audio = c.audio as MediaTrackConstraints;
  assert.equal(audio.echoCancellation, true);
  assert.equal(audio.noiseSuppression, true);
  assert.equal(audio.autoGainControl, true);
  assert.equal("channelCount" in audio, false);
  assert.equal("sampleRate" in audio, false);
});
