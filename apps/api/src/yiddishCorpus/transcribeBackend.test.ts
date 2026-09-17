/**
 * Yiddish corpus — transcription backend resolution + the local faster-whisper
 * backend's JSON mapping.
 *
 * No network, no real python/faster-whisper needed: the local backend is
 * exercised by pointing `pythonPath` at `process.execPath` (node itself) and
 * `scriptPath` at a tiny stub script that prints canned JSON on stdout —
 * exactly the "python path + script path are both overridable" design the
 * class was built for. `EverettBackend` is exercised by injecting a fake
 * `EverettClient`-shaped object, never the real network client.
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test
 *   "src/yiddishCorpus/*.test.ts"
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  resolveTranscribeBackend,
  setTranscribeBackendForTests,
  EverettBackend,
  LocalFasterWhisperBackend,
  NoneBackend,
  YC_EVERETT_CENTS_PER_AUDIO_MINUTE,
} from "./transcribeBackend";

// ── fixtures: stub "python" scripts run by real node, no real python needed ─

let fixtureDir: string;
let okScriptPath: string;
let failScriptPath: string;
let badJsonScriptPath: string;

before(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "yc-local-whisper-test-"));

  okScriptPath = path.join(fixtureDir, "stub-ok.js");
  writeFileSync(
    okScriptPath,
    `
      const args = process.argv.slice(2);
      const out = {
        model: "stub-model",
        language: "yi",
        duration: 1.5,
        segments: [
          {
            start: 0,
            end: 1.5,
            text: "אַ גוטן טאָג",
            avg_logprob: -0.12,
            no_speech_prob: 0.01,
            words: [{ word: "אַ", start: 0, end: 0.3, probability: 0.9 }],
          },
          { start: 1.5, end: 2.5, text: "יאָ", avg_logprob: -0.3, no_speech_prob: 0.4 },
        ],
      };
      process.stderr.write("diagnostics go to stderr, args=" + JSON.stringify(args) + "\\n");
      process.stdout.write(JSON.stringify(out));
    `,
  );

  failScriptPath = path.join(fixtureDir, "stub-fail.js");
  writeFileSync(
    failScriptPath,
    `
      process.stderr.write("faster-whisper is not installed\\n");
      process.exit(1);
    `,
  );

  badJsonScriptPath = path.join(fixtureDir, "stub-badjson.js");
  writeFileSync(
    badJsonScriptPath,
    `
      process.stdout.write("not json at all");
    `,
  );
});

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function reset() {
  setTranscribeBackendForTests(null);
}

// ── 1. resolution rules ─────────────────────────────────────────────────────

test("YC_TRANSCRIBE_BACKEND=local forces the local backend regardless of everything else", () => {
  reset();
  const backend = resolveTranscribeBackend({
    YC_TRANSCRIBE_BACKEND: "local",
    EVERETT_ENDPOINT_ID: "some-endpoint",
    EVERETT_API_KEY: "some-key",
  } as any);
  assert.ok(backend instanceof LocalFasterWhisperBackend);
  assert.equal(backend.name, "local");
});

test("YC_TRANSCRIBE_BACKEND=everett forces Everett regardless of YC_LOCAL_WHISPER_PYTHON", () => {
  reset();
  const backend = resolveTranscribeBackend({
    YC_TRANSCRIBE_BACKEND: "everett",
    YC_LOCAL_WHISPER_PYTHON: "/usr/bin/python3",
  } as any);
  assert.ok(backend instanceof EverettBackend);
  assert.equal(backend.name, "everett");
});

test("unset + YC_LOCAL_WHISPER_PYTHON set => local (local wins over an also-configured Everett)", () => {
  reset();
  const backend = resolveTranscribeBackend({
    YC_LOCAL_WHISPER_PYTHON: "/usr/bin/python3",
    EVERETT_ENDPOINT_ID: "some-endpoint",
  } as any);
  assert.ok(backend instanceof LocalFasterWhisperBackend);
});

test("unset + no YC_LOCAL_WHISPER_PYTHON + EVERETT_ENDPOINT_ID set => everett", () => {
  reset();
  const backend = resolveTranscribeBackend({ EVERETT_ENDPOINT_ID: "some-endpoint" } as any);
  assert.ok(backend instanceof EverettBackend);
});

test("unset + neither configured => an honestly-unconfigured NoneBackend, never a crash", () => {
  reset();
  const backend = resolveTranscribeBackend({} as any);
  assert.ok(backend instanceof NoneBackend);
  assert.equal(backend.configured, false);
});

test("a test override always wins over any env, including a forced one", () => {
  reset();
  const marker: any = { name: "everett", model: "marker", configured: true, costCentsPerMinute: 0, transcribeChunk: async () => ({ status: "completed", segments: [] }) };
  setTranscribeBackendForTests(marker);
  const backend = resolveTranscribeBackend({ YC_TRANSCRIBE_BACKEND: "local" } as any);
  assert.equal(backend, marker);
  reset();
});

// ── 2. NoneBackend is honest, not silently crashy ───────────────────────────

test("NoneBackend: unconfigured, and transcribeChunk throws a plain, actionable reason (never a silent skip elsewhere)", async () => {
  const backend = new NoneBackend();
  assert.equal(backend.configured, false);
  assert.equal(backend.costCentsPerMinute, 0);
  await assert.rejects(() => backend.transcribeChunk({ file: Buffer.from("x") }), /no transcription backend configured/i);
});

// ── 3. EverettBackend wraps an injected EverettClient-shaped object ────────

test("EverettBackend: configured/model/cost come from the wrapped client; segments pass through", async () => {
  const fakeClient: any = {
    model: "ivrit-ai/whisper-large-v3-turbo-ct2",
    configured: true,
    async transcribeChunk() {
      return {
        id: "x",
        status: "completed",
        language: "yi",
        segments: [{ text: "hi", start: 0, end: 1, avgLogprob: -0.1, noSpeechProb: 0.02, words: undefined }],
      };
    },
  };
  const backend = new EverettBackend(fakeClient);
  assert.equal(backend.name, "everett");
  assert.equal(backend.model, "ivrit-ai/whisper-large-v3-turbo-ct2");
  assert.equal(backend.configured, true);
  assert.equal(backend.costCentsPerMinute, YC_EVERETT_CENTS_PER_AUDIO_MINUTE);
  const res = await backend.transcribeChunk({ file: Buffer.from("audio") });
  assert.equal(res.status, "completed");
  assert.equal(res.segments.length, 1);
  assert.equal(res.segments[0].text, "hi");
});

test("EverettBackend: an unconfigured wrapped client reports unconfigured, never throws just from reading .configured", () => {
  const fakeClient: any = { model: "m", configured: false, transcribeChunk: async () => ({ status: "failed" }) };
  const backend = new EverettBackend(fakeClient);
  assert.equal(backend.configured, false);
});

// ── 4. LocalFasterWhisperBackend: configured is a real file check ──────────

test("LocalFasterWhisperBackend: not configured when pythonPath is unset", () => {
  const backend = new LocalFasterWhisperBackend({ pythonPath: null });
  assert.equal(backend.configured, false);
});

test("LocalFasterWhisperBackend: not configured when pythonPath points at a file that does not exist", () => {
  const backend = new LocalFasterWhisperBackend({ pythonPath: path.join(fixtureDir, "no-such-python-binary") });
  assert.equal(backend.configured, false);
});

test("LocalFasterWhisperBackend: configured when pythonPath exists on disk (node itself, here)", () => {
  const backend = new LocalFasterWhisperBackend({ pythonPath: process.execPath, scriptPath: okScriptPath });
  assert.equal(backend.configured, true);
  assert.equal(backend.name, "local");
  assert.equal(backend.costCentsPerMinute, 0, "the whole point: local labelling costs $0");
  assert.match(backend.model, /^local:/);
});

// ── 5. LocalFasterWhisperBackend maps a fake python JSON correctly ─────────

test("LocalFasterWhisperBackend.transcribeChunk maps snake_case python JSON to the shared TranscribeSegment shape", async () => {
  const backend = new LocalFasterWhisperBackend({
    pythonPath: process.execPath,
    scriptPath: okScriptPath,
    model: "ivrit-ai/yi-whisper-large-v3-turbo-ct2",
  });
  const res = await backend.transcribeChunk({ file: Buffer.from("fake audio bytes") });
  assert.equal(res.status, "completed");
  assert.equal(res.language, "yi");
  assert.equal(res.segments.length, 2);
  const [a, b] = res.segments;
  assert.equal(a.text, "אַ גוטן טאָג");
  assert.equal(a.start, 0);
  assert.equal(a.end, 1.5);
  assert.equal(a.avgLogprob, -0.12, "avg_logprob maps to avgLogprob");
  assert.equal(a.noSpeechProb, 0.01, "no_speech_prob maps to noSpeechProb");
  assert.equal(a.words?.length, 1);
  assert.equal(a.words?.[0].word, "אַ");
  assert.equal(a.words?.[0].probability, 0.9);
  assert.equal(b.words, undefined, "a segment with no words from the script stays undefined, never a guess");
});

test("LocalFasterWhisperBackend.transcribeChunk accepts input.path instead of writing a temp file", async () => {
  const backend = new LocalFasterWhisperBackend({ pythonPath: process.execPath, scriptPath: okScriptPath });
  const audioFile = path.join(fixtureDir, "already-on-disk.wav");
  writeFileSync(audioFile, "not real audio, just needs to exist");
  const res = await backend.transcribeChunk({ file: Buffer.alloc(0), path: audioFile });
  assert.equal(res.status, "completed");
});

test("LocalFasterWhisperBackend.transcribeChunk throws (chunk-level failure) on a non-zero exit, never crashes the process", async () => {
  const backend = new LocalFasterWhisperBackend({ pythonPath: process.execPath, scriptPath: failScriptPath });
  await assert.rejects(() => backend.transcribeChunk({ file: Buffer.from("x") }));
});

test("LocalFasterWhisperBackend.transcribeChunk throws on unparseable stdout instead of returning a guessed result", async () => {
  const backend = new LocalFasterWhisperBackend({ pythonPath: process.execPath, scriptPath: badJsonScriptPath });
  await assert.rejects(() => backend.transcribeChunk({ file: Buffer.from("x") }));
});

// ── 6. ⛔ never Yiddish Labs ──────────────────────────────────────────────

test("SOURCE GUARD: transcribeBackend.ts and local_whisper.py never mention Yiddish Labs", () => {
  const backendSrc = readFileSync(path.join(__dirname, "transcribeBackend.ts"), "utf8").replace(/\r\n/g, "\n");
  const pySrc = readFileSync(path.join(__dirname, "local_whisper.py"), "utf8").replace(/\r\n/g, "\n");
  // ⛔ NOT "yiddish labs" (the two-word phrase) — see transcribe.test.ts's
  // guard test for why: the codebase legitimately says "Yiddish Labs" in
  // prose to warn against referencing it, including in this file's own
  // header comment above.
  for (const marker of ["yiddishlabs", "yiddish-labs", "yiddish_labs"]) {
    assert.equal(backendSrc.toLowerCase().includes(marker), false, `transcribeBackend.ts must never mention "${marker}"`);
    assert.equal(pySrc.toLowerCase().includes(marker), false, `local_whisper.py must never mention "${marker}"`);
  }
});
