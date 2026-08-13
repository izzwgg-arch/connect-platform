import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { VOICE_NOTE_FILTER_CHAIN, isVoiceNoteFilename, isVoiceNoteUpload } from "./chatVoiceNoteDenoise";

/**
 * 2026-08-13: a voice note reached the recipient sounding hollow and far away
 * ("like I'm in a dungeon"). Cause was one number in the ffmpeg chain —
 * afftdn's noise floor at nf=-25, against a valid range of -80..-20 and a
 * default of -50. Speech averages about -20 dB, so the denoiser was told to
 * treat the voice itself as noise. These lock the audible properties of the
 * chain so it cannot regress into that silently again.
 */

function filterParam(chain: string, filter: string, key: string): number | null {
  const stage = chain.split(",").find((s) => s.startsWith(`${filter}=`) || s.startsWith(`${filter}:`));
  if (!stage) return null;
  const m = stage.match(new RegExp(`(?:^|[=:])${key}=(-?[0-9.]+)`));
  return m ? Number(m[1]) : null;
}

test("the denoiser never treats speech as noise: nf stays at or below the safe default", () => {
  const nf = filterParam(VOICE_NOTE_FILTER_CHAIN, "afftdn", "nf");
  assert.notEqual(nf, null, "chain must still denoise");
  // -50 is ffmpeg's default; anything above it starts eating quiet speech.
  assert.ok(nf! <= -50, `afftdn nf must be <= -50 (ffmpeg default), got ${nf} — this is the "dungeon" bug`);
  assert.ok(nf! >= -80, `afftdn nf must stay inside ffmpeg's -80..-20 range, got ${nf}`);
});

test("the chain lifts quiet speech and adds presence, so a voice does not sound distant", () => {
  // Compression is what pulls soft syllables forward; without it a recording
  // with a wide range reads as "far away" no matter how loud the peaks are.
  assert.match(VOICE_NOTE_FILTER_CHAIN, /acompressor=/, "voice notes need compression");
  // Presence lift around 2-4 kHz is what makes speech intelligible.
  const presence = VOICE_NOTE_FILTER_CHAIN.split(",").some((s) => {
    const f = s.match(/^equalizer=f=(\d+)/);
    const g = s.match(/g=(-?[0-9.]+)/);
    return Boolean(f && g && Number(f[1]) >= 2000 && Number(f[1]) <= 4000 && Number(g[1]) > 0);
  });
  assert.ok(presence, "chain must boost the 2-4kHz presence band");
});

test("loudness is normalized to a consistent, tight range", () => {
  const lra = filterParam(VOICE_NOTE_FILTER_CHAIN, "loudnorm", "LRA");
  assert.notEqual(lra, null, "chain must normalize loudness");
  // The measured bad note had LRA 11.0 LU — quiet parts 11dB back.
  assert.ok(lra! <= 8, `loudnorm LRA should be <= 8 LU for speech, got ${lra}`);
});

test("output sample rate is pinned, never inherited from the upload", () => {
  // A real upload arrived at 96 kHz because -ar was absent.
  // ⛔ `import.meta` is TS1343 here (this package compiles as CommonJS).
  const source = readFileSync(path.join(__dirname, "chatVoiceNoteDenoise.ts"), "utf8");
  assert.match(source, /"-ar",\s*\n?\s*"48000"/, "denoiseVoiceNote must force -ar 48000");
});

test("voice notes are still recognised by filename and audio mime", () => {
  assert.equal(isVoiceNoteFilename("voice-note-1786630652620.m4a"), true);
  assert.equal(isVoiceNoteFilename("holiday-photo.jpg"), false);
  assert.equal(isVoiceNoteUpload("voice-note-1.m4a", "audio/mp4"), true);
  assert.equal(isVoiceNoteUpload("voice-note-1.m4a", "video/mp4"), false);
});
