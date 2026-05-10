import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

import { transcodeMohToPbxWav } from "./mohStorage";

/**
 * Detect whether `ffmpeg` is on PATH. Tests that depend on transcoding skip
 * themselves on machines without ffmpeg (most local dev boxes) so CI / contributor
 * runs without ffmpeg don't fail. The deployed API container ships ffmpeg, so
 * production builds always exercise the real code path.
 */
function ffmpegAvailable(): boolean {
  try {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-version"], {
      stdio: "ignore",
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Build a deterministic 1-second mono 16 kHz PCM-16 RIFF/WAVE file in memory. */
function buildSilentPcmWav(): Buffer {
  const sampleRate = 16000;
  const seconds = 1;
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataLen = sampleRate * seconds * channels * (bitsPerSample / 8);
  const buf = Buffer.alloc(44 + dataLen);
  let o = 0;
  buf.write("RIFF", o);
  o += 4;
  buf.writeUInt32LE(36 + dataLen, o);
  o += 4;
  buf.write("WAVE", o);
  o += 4;
  buf.write("fmt ", o);
  o += 4;
  buf.writeUInt32LE(16, o);
  o += 4;
  buf.writeUInt16LE(1, o);
  o += 2;
  buf.writeUInt16LE(channels, o);
  o += 2;
  buf.writeUInt32LE(sampleRate, o);
  o += 4;
  buf.writeUInt32LE(byteRate, o);
  o += 4;
  buf.writeUInt16LE(blockAlign, o);
  o += 2;
  buf.writeUInt16LE(bitsPerSample, o);
  o += 2;
  buf.write("data", o);
  o += 4;
  buf.writeUInt32LE(dataLen, o);
  // body is already zero-filled silence
  return buf;
}

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "moh-storage-test-"));
}

function listTempArtifacts(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => /\.tmp\.\d+(\.wav)?$/.test(name) || name.endsWith(".tmp"));
}

const skipUnlessFfmpeg: { skip?: string } = ffmpegAvailable()
  ? {}
  : { skip: "ffmpeg not available on PATH" };

test("transcodeMohToPbxWav: valid WAV → ready WAV at dest, no temp leftovers", skipUnlessFfmpeg, async () => {
  const dir = mkTmpDir();
  try {
    const src = path.join(dir, "src.wav");
    const dest = path.join(dir, "asset.wav");
    fs.writeFileSync(src, buildSilentPcmWav());

    const result = await transcodeMohToPbxWav({
      sourceAbsolutePath: src,
      destAbsolutePath: dest,
    });
    assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
    assert.ok(fs.existsSync(dest), "dest WAV should exist");

    const head = fs.readFileSync(dest).subarray(0, 12);
    assert.equal(head.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(head.subarray(8, 12).toString("ascii"), "WAVE");

    assert.deepEqual(
      listTempArtifacts(dir),
      [],
      "no .tmp.<pid>(.wav) files should remain in the dest dir",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transcodeMohToPbxWav: invalid input fails cleanly with no temp leftovers", skipUnlessFfmpeg, async () => {
  const dir = mkTmpDir();
  try {
    const src = path.join(dir, "garbage.bin");
    const dest = path.join(dir, "asset.wav");
    // Random non-audio bytes — ffmpeg should reject this as not a recognized
    // input format.
    fs.writeFileSync(src, Buffer.from("this is definitely not audio bytes", "utf8"));

    const result = await transcodeMohToPbxWav({
      sourceAbsolutePath: src,
      destAbsolutePath: dest,
    });
    assert.equal(result.ok, false, "invalid input must not report ok");
    if (result.ok === false) {
      assert.match(result.error, /^ffmpeg_failed:/);
    }
    assert.ok(!fs.existsSync(dest), "dest must not be created on failure");
    assert.deepEqual(
      listTempArtifacts(dir),
      [],
      "ffmpeg failure must clean up its temp output",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transcodeMohToPbxWav: missing source path returns ffmpeg_failed", skipUnlessFfmpeg, async () => {
  const dir = mkTmpDir();
  try {
    const src = path.join(dir, "does-not-exist.wav");
    const dest = path.join(dir, "asset.wav");

    const result = await transcodeMohToPbxWav({
      sourceAbsolutePath: src,
      destAbsolutePath: dest,
    });
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.match(result.error, /^ffmpeg_failed:/);
    }
    assert.deepEqual(listTempArtifacts(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
