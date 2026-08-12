import { strict as assert } from "node:assert";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  readVoicemailAudio,
  resolveVoicemailAudioPath,
  saveVoicemailAudio,
  voicemailAudioExtFromFilename,
  voicemailAudioFilename,
} from "./audioStore";

/**
 * The local voicemail audio store exists so each message costs the PBX at most
 * ONE fetch, ever (2026-08-12: per-play PBX fetches + a preloader that retried
 * dead voicemails forever pinned the PBX helper at 1.5 cores with zero calls).
 * These tests cover the store itself AND — the lesson from the invite-link bug,
 * where the resolver was fine and the CALLER was broken — assert that the
 * server, compose file, and portal preloader are actually wired to it.
 */

function withStoreDir(dir: string) {
  const previous = process.env.VOICEMAIL_AUDIO_STORAGE_DIR;
  process.env.VOICEMAIL_AUDIO_STORAGE_DIR = dir;
  return () => {
    if (previous === undefined) delete process.env.VOICEMAIL_AUDIO_STORAGE_DIR;
    else process.env.VOICEMAIL_AUDIO_STORAGE_DIR = previous;
  };
}

test("filenames are <id>.<ext> and hostile ids/exts are refused", () => {
  assert.equal(voicemailAudioFilename("cmabc123", "wav"), "cmabc123.wav");
  assert.equal(voicemailAudioFilename("cmabc123", "MP3"), "cmabc123.mp3");
  // ext is sanitised, never trusted
  assert.equal(voicemailAudioFilename("cmabc123", "../../etc"), "cmabc123.etc");
  // an id that cannot form a safe filename is refused outright
  assert.equal(voicemailAudioFilename("../evil", "wav"), null);
  assert.equal(voicemailAudioFilename("", "wav"), null);
});

test("path resolution refuses traversal and absolute escapes", () => {
  const restore = withStoreDir(path.join(os.tmpdir(), "vm-audio-test-root"));
  try {
    assert.ok(resolveVoicemailAudioPath("cmabc123.wav"));
    assert.equal(resolveVoicemailAudioPath("../cmabc123.wav"), null);
    assert.equal(resolveVoicemailAudioPath("..\\cmabc123.wav"), null);
    assert.equal(resolveVoicemailAudioPath("/etc/passwd"), null);
    assert.equal(resolveVoicemailAudioPath("a/b.wav"), null);
    assert.equal(resolveVoicemailAudioPath(""), null);
  } finally {
    restore();
  }
});

test("save → read roundtrip returns the exact bytes; missing files read as null", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vm-audio-"));
  const restore = withStoreDir(dir);
  try {
    const audio = Buffer.from("RIFF....WAVEfmt fake-audio-bytes");
    const filename = await saveVoicemailAudio("cmtest1", "wav", audio);
    assert.equal(filename, "cmtest1.wav");
    const back = readVoicemailAudio(filename);
    assert.ok(back && back.equals(audio));
    // no half-written tmp files left behind
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, ["cmtest1.wav"]);
    assert.equal(readVoicemailAudio("cmnothere.wav"), null);
    assert.equal(readVoicemailAudio(null), null);
  } finally {
    restore();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("empty and oversized buffers are refused (caller keeps streaming from the PBX)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vm-audio-"));
  const restore = withStoreDir(dir);
  try {
    assert.equal(await saveVoicemailAudio("cmtest2", "wav", Buffer.alloc(0)), null);
    assert.equal(await saveVoicemailAudio("cmtest3", "wav", Buffer.alloc(26 * 1024 * 1024)), null);
  } finally {
    restore();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("ext-from-filename drives the mime type and never trusts junk", () => {
  assert.equal(voicemailAudioExtFromFilename("cmabc.mp3"), "mp3");
  assert.equal(voicemailAudioExtFromFilename("cmabc.wav"), "wav");
  assert.equal(voicemailAudioExtFromFilename("cmabc"), "wav");
  assert.equal(voicemailAudioExtFromFilename(""), "wav");
});

// ── Wiring: a store nobody calls is not a fix ────────────────────────────────

test("server.ts is wired: serve-from-store, gone-verdict, persist, bounded notify scan, arrival copy", async () => {
  const serverSrc = await fsp.readFile(path.join(__dirname, "..", "server.ts"), "utf8");

  // stream path serves from the local store and short-circuits gone audio
  assert.ok(serverSrc.includes("readVoicemailAudio(vm.localAudioPath)"), "stream path must read the local store first");
  assert.ok(serverSrc.includes("if (vm.audioGoneAt)"), "stream path must short-circuit on the audio-gone verdict");

  // every PBX fetch persists; the store-serve path must NOT re-persist
  assert.ok(serverSrc.includes("persistLocalCopy = true"), "finishVoicemailStreamFromBuffer must persist by default");
  assert.match(serverSrc, /voicemailAudioExtFromFilename\(vm\.localAudioPath\), skipTranscode, allowReadStamp,\s*\n\s*false/, "serving from the store must pass persistLocalCopy=false");

  // the gone verdict is only stamped after a COMPLETE scan
  assert.match(
    serverSrc,
    /paginationComplete !== false\)\s*\{\s*\n\s*await db\.voicemail\.update\(\{ where: \{ id: vm\.id \}, data: \{ audioGoneAt: new Date\(\) \} \}\)/,
    "audioGoneAt must be stamped only behind the pagination-complete guard",
  );

  // voicemail-notify bounds its helper scan and copies fresh audio
  const notifyIdx = serverSrc.indexOf("/internal/voicemail-notify");
  assert.ok(notifyIdx > 0);
  const notifyBlock = serverSrc.slice(notifyIdx, notifyIdx + 12_000);
  assert.ok(notifyBlock.includes("sinceOrigtime"), "notify helper scan must be bounded by the newest known origtime");
  assert.ok(notifyBlock.includes("copyFreshVoicemailAudioToStore"), "notify must trigger arrival-time audio copy");
});

test("docker-compose mounts the voicemail-audio volume in BOTH api blocks", async () => {
  const compose = await fsp.readFile(path.join(__dirname, "..", "..", "..", "..", "docker-compose.app.yml"), "utf8");
  const mounts = compose.match(/- voicemail-audio:\/var\/lib\/connect\/voicemail-audio/g) || [];
  assert.equal(mounts.length, 2, "api AND api_candidate must both mount voicemail-audio (blue/green)");
  const envs = compose.match(/VOICEMAIL_AUDIO_STORAGE_DIR: \$\{VOICEMAIL_AUDIO_STORAGE_DIR:-\/var\/lib\/connect\/voicemail-audio\}/g) || [];
  assert.equal(envs.length, 2, "api AND api_candidate must both set VOICEMAIL_AUDIO_STORAGE_DIR");
  assert.match(compose, /\r?\n  voicemail-audio:\r?\n/, "the named volume must be declared");
});

test("the mini-dialer preloader never re-requests a voicemail the server said is gone", async () => {
  const dialerSrc = await fsp.readFile(
    path.join(__dirname, "..", "..", "..", "portal", "components", "DesktopMiniDialer.tsx"),
    "utf8",
  );
  assert.ok(dialerSrc.includes("vmAudioGone.has(id)"), "preload loop must skip known-gone ids");
  assert.match(
    dialerSrc,
    /resp\.status === 404 \|\| resp\.status === 410\) \{\s*\n\s*vmAudioGone\.add\(id\)/,
    "a 404/410 preload must mark the id gone",
  );
});
