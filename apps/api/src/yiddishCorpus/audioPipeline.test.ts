/**
 * Yiddish corpus — audio pipeline tests.
 *
 * ⛔ No ffmpeg is invoked here and no audio file is read. `run` is injected, so
 * these tests assert the two things that actually bite in production:
 *   1. a host with no ffmpeg DEGRADES HONESTLY — `{ available: false, reason }`
 *      everywhere, never a throw that kills a queue worker;
 *   2. the music/speech call is a HEURISTIC and says so — confidence capped,
 *      a `basis` naming the numbers, and no branch that claims certainty.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  classifySpan,
  cutChunk,
  detectSegments,
  extractFeatures,
  ffmpegAvailability,
  parseAstats,
  parseSilenceDetect,
  planChunks,
  probeAudio,
  YC_SEGMENT_MAX_CONFIDENCE,
  type RunFn,
} from "./audioPipeline";

const ENOENT: RunFn = async () => ({ code: 1, stdout: "", stderr: "", error: "ENOENT" });

const FFPROBE_JSON = JSON.stringify({
  streams: [{ codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 2, duration: "4180.0" }],
  format: { duration: "4180.000000", bit_rate: "92000", size: "48000000" },
});

const SILENCE_STDERR = [
  "[silencedetect @ 0x1] silence_start: 0",
  "[silencedetect @ 0x1] silence_end: 2.5 | silence_duration: 2.5",
  "[silencedetect @ 0x1] silence_start: 12.0",
  "[silencedetect @ 0x1] silence_end: 12.8 | silence_duration: 0.8",
  "[silencedetect @ 0x1] silence_start: 20.25",
  "[silencedetect @ 0x1] silence_end: 21.0 | silence_duration: 0.75",
].join("\n");

const ASTATS_STDERR = [
  "[Parsed_astats_1 @ 0x2] Overall",
  "[Parsed_astats_1 @ 0x2] RMS level dB: -22.418000",
  "[Parsed_astats_1 @ 0x2] Peak level dB: -1.250000",
  "[Parsed_astats_1 @ 0x2] Flat factor: 0.000000",
  "[Parsed_astats_1 @ 0x2] Entropy: 0.612345",
  "[Parsed_astats_1 @ 0x2] Zero crossings rate: 0.041000",
  "[Parsed_astats_1 @ 0x2] Number of samples: 1323000",
  "[Parsed_astats_1 @ 0x2] Sample rate: 44100",
].join("\n");

function scriptedRun(script: (cmd: string, args: string[]) => { stdout?: string; stderr?: string; code?: number }): RunFn {
  return async (cmd, args) => {
    const r = script(cmd, args);
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: null };
  };
}

// ── 1. ⛔ ffmpeg missing degrades, never throws ──────────────────────────────

test("a host with no ffmpeg answers {available:false, reason} from EVERY entry point", async () => {
  const deps = { run: ENOENT };

  const avail = await ffmpegAvailability(deps);
  assert.equal(avail.available, false);
  assert.match(String(avail.reason), /not installed|unavailable/i);

  const probed = await probeAudio("/tmp/whatever.mp3", deps);
  assert.equal(probed.available, false);
  assert.match(String(probed.reason), /ffprobe is not installed/i);
  assert.equal(probed.durationMs, undefined, "no invented numbers when nothing was measured");

  const segs = await detectSegments("/tmp/whatever.mp3", deps);
  assert.equal(segs.available, false);
  assert.ok(segs.reason);
  assert.equal(segs.segments, undefined);

  const feats = await extractFeatures("/tmp/whatever.mp3", { startMs: 0, endMs: 1000 }, deps);
  assert.equal(feats.available, false);
  assert.ok(feats.reason);
});

test("ffprobe present but unable to read the file is still an answer, not a throw", async () => {
  const deps = { run: scriptedRun(() => ({ code: 1, stdout: "" })) };
  const probed = await probeAudio("/tmp/broken.mp3", deps);
  assert.equal(probed.available, false);
  assert.match(String(probed.reason), /could not read/i);

  const garbage = { run: scriptedRun(() => ({ code: 0, stdout: "<<not json>>" })) };
  const bad = await probeAudio("/tmp/broken.mp3", garbage);
  assert.equal(bad.available, false);
  assert.match(String(bad.reason), /could not parse/i);
});

// ── 2. probe ────────────────────────────────────────────────────────────────

test("probeAudio reports exactly what ffprobe said", async () => {
  const deps = { run: scriptedRun(() => ({ stdout: FFPROBE_JSON })) };
  const r = await probeAudio("/tmp/a.mp3", deps);
  assert.equal(r.available, true);
  assert.equal(r.durationMs, 4_180_000);
  assert.equal(r.sampleRate, 44100);
  assert.equal(r.channels, 2);
  assert.equal(r.codec, "mp3");
  assert.equal(r.bitrate, 92000);
});

// ── 3. the two stderr parsers ───────────────────────────────────────────────

test("parseSilenceDetect pairs starts with ends and closes a dangling start at the end", () => {
  const spans = parseSilenceDetect(SILENCE_STDERR, 30_000);
  assert.deepEqual(spans, [
    { startMs: 0, endMs: 2500 },
    { startMs: 12000, endMs: 12800 },
    { startMs: 20250, endMs: 21000 },
  ]);

  const dangling = parseSilenceDetect("silence_start: 5.0", 9000);
  assert.deepEqual(dangling, [{ startMs: 5000, endMs: 9000 }]);
  // No total duration means we cannot honestly close it, so we do not.
  assert.deepEqual(parseSilenceDetect("silence_start: 5.0", null), []);
  assert.deepEqual(parseSilenceDetect("", 1000), []);
});

test("parseAstats pulls the numeric fields and ignores the prose", () => {
  const stats = parseAstats(ASTATS_STDERR);
  assert.equal(stats.rms_level_db, -22.418);
  assert.equal(stats.peak_level_db, -1.25);
  assert.equal(stats.entropy, 0.612345);
  assert.equal(stats.zero_crossings_rate, 0.041);
  assert.equal(stats.sample_rate, 44100);
  assert.equal(stats.overall, undefined, "a header line is not a measurement");
  assert.deepEqual(parseAstats(""), {});
});

// ── 4. ⛔ the heuristic is labelled a heuristic ──────────────────────────────

test("classifySpan never claims certainty and always names its basis", () => {
  const speech = classifySpan({ durationMs: 60_000, pauseCount: 9, entropy: 0.6, flatFactor: 0 });
  assert.equal(speech.klass, "SPEECH");
  assert.ok(speech.klassConfidence <= YC_SEGMENT_MAX_CONFIDENCE);
  assert.match(speech.basis, /heuristic/);
  assert.match(speech.basis, /pauses\/min/);

  const music = classifySpan({ durationMs: 180_000, pauseCount: 0, entropy: 0.92, flatFactor: 1 });
  assert.equal(music.klass, "MUSIC");
  assert.ok(music.klassConfidence <= YC_SEGMENT_MAX_CONFIDENCE);

  const unsure = classifySpan({ durationMs: 60_000, pauseCount: 2, entropy: 0.9, flatFactor: 0 });
  assert.equal(unsure.klass, "MIXED");
  assert.ok(unsure.klassConfidence < 0.5);

  // No entropy reading = UNKNOWN, not a guess.
  const blind = classifySpan({ durationMs: 60_000, pauseCount: 9, entropy: null, flatFactor: null });
  assert.equal(blind.klass, "UNKNOWN");
  assert.ok(blind.klassConfidence <= 0.2);
  assert.match(blind.basis, /not enough to judge/);

  // Exhaustive: no input combination may ever reach certainty.
  for (const pauseCount of [0, 1, 3, 5, 20, 100]) {
    for (const entropy of [null, 0.1, 0.5, 0.74, 0.75, 0.99]) {
      const v = classifySpan({ durationMs: 60_000, pauseCount, entropy, flatFactor: 0 });
      assert.ok(v.klassConfidence <= YC_SEGMENT_MAX_CONFIDENCE, `confidence too high for ${pauseCount}/${entropy}`);
      assert.ok(v.klassConfidence > 0);
      assert.ok(v.basis.length > 10);
    }
  }
});

// ── 5. segments and features end to end, ffmpeg faked ───────────────────────

test("detectSegments builds silence and loud spans and labels its method honestly", async () => {
  const deps = {
    run: scriptedRun((cmd, args) => {
      if (/ffprobe/.test(cmd)) return { stdout: FFPROBE_JSON.replace("4180.000000", "30.0").replace('"4180.0"', '"30.0"') };
      if (args.join(" ").includes("silencedetect")) return { stderr: SILENCE_STDERR };
      return { stderr: ASTATS_STDERR };
    }),
  };
  const res = await detectSegments("/tmp/a.mp3", deps);
  assert.equal(res.available, true);
  assert.match(String(res.method), /not a trained classifier/);
  const segs = res.segments!;
  assert.ok(segs.length >= 4, `expected silence + loud spans, got ${segs.length}`);
  assert.equal(segs[0].klass, "SILENCE");
  assert.equal(segs[0].startMs, 0);
  assert.equal(segs[0].endMs, 2500);
  // The loud span between the first two silences.
  const loud = segs.find((s) => s.startMs === 2500);
  assert.ok(loud, "the span between two silences must be classified, not dropped");
  assert.notEqual(loud!.klass, "SILENCE");
  assert.ok(loud!.klassConfidence <= YC_SEGMENT_MAX_CONFIDENCE);
  // Spans must be ordered and non-overlapping.
  for (let i = 1; i < segs.length; i += 1) assert.ok(segs[i].startMs >= segs[i - 1].endMs);
  assert.ok((res.silenceRatio ?? 0) > 0 && (res.silenceRatio ?? 0) < 1);
});

test("extractFeatures measures what it can and says plainly what it did not", async () => {
  const deps = { run: scriptedRun(() => ({ stderr: `${SILENCE_STDERR}\n${ASTATS_STDERR}` })) };
  const f = await extractFeatures("/tmp/a.mp3", { startMs: 0, endMs: 30_000 }, deps);
  assert.equal(f.available, true);
  assert.equal(f.rmsDb, -22.418);
  assert.equal(f.peakDb, -1.25);
  assert.equal(f.pauseCount, 3);
  assert.equal(f.pausesPerMinute, 6);
  assert.equal(f.medianPauseMs, 800);
  assert.equal(f.longestPauseMs, 2500);
  assert.ok((f.speechRateEstimate ?? 0) > 0);
  // ⛔ The honesty clauses. A reader must not mistake the proxy for a measurement.
  assert.match(String(f.speechRateBasis), /PROXY for speech rate, not a syllable count/);
  assert.equal(f.pitchMeanHz, null);
  assert.match(String(f.pitchBasis), /not measured/);
});

// ── 5b. cutChunk (Whisper fine-tune Lane A) ─────────────────────────────────

test("cutChunk runs ffmpeg with a 16kHz mono output and the requested trim window", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: RunFn = async (cmd, args) => {
    calls.push({ cmd, args });
    return { code: 0, stdout: "", stderr: "", error: null };
  };
  const res = await cutChunk("/audio/in.mp3", 10_000, 40_000, "/tmp/out.mp3", { run });
  assert.equal(res.available, true);
  assert.equal(res.reason, null);
  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.ok(args.includes("-i") && args.includes("/audio/in.mp3"));
  assert.ok(args.includes("-ar") && args.includes("16000"), "must resample to 16kHz");
  assert.ok(args.includes("-ac") && args.includes("1"), "must downmix to mono");
  assert.ok(args.includes("/tmp/out.mp3"));
  const ssIdx = args.indexOf("-ss");
  assert.equal(args[ssIdx + 1], "10.000");
  const tIdx = args.indexOf("-t");
  assert.equal(args[tIdx + 1], "30.000", "duration is endMs-startMs, not endMs");
});

test("cutChunk degrades honestly with no ffmpeg, and refuses an empty window without running anything", async () => {
  const res = await cutChunk("/audio/in.mp3", 0, 1000, "/tmp/out.mp3", { run: ENOENT });
  assert.equal(res.available, false);
  assert.match(res.reason!, /not installed/);

  let ran = false;
  const run: RunFn = async () => {
    ran = true;
    return { code: 0, stdout: "", stderr: "", error: null };
  };
  const empty = await cutChunk("/audio/in.mp3", 5000, 5000, "/tmp/out.mp3", { run });
  assert.equal(empty.available, false);
  assert.equal(ran, false, "an empty/backwards window must never invoke ffmpeg");
});

// ── 5c. planChunks — pure, no ffmpeg, no I/O ────────────────────────────────

test("planChunks groups SPEECH segments into windows no longer than chunkSec", () => {
  const segments = [
    { startMs: 0, endMs: 100_000, klass: "SPEECH" },
    { startMs: 100_000, endMs: 110_000, klass: "SILENCE" },
    { startMs: 110_000, endMs: 200_000, klass: "SPEECH" },
  ];
  const windows = planChunks(segments, 200_000, 120); // 120s cap
  assert.ok(windows.length >= 2, `expected at least 2 windows, got ${windows.length}`);
  for (const w of windows) assert.ok(w.endMs - w.startMs <= 120_000, "no window may exceed chunkSec");
  // Every ms of window time is covered by real speech somewhere in `segments`.
  for (const w of windows) {
    const covered = segments.some((s) => s.klass === "SPEECH" && s.startMs < w.endMs && s.endMs > w.startMs);
    assert.ok(covered, `window ${w.startMs}-${w.endMs} must contain real speech`);
  }
});

test("planChunks produces nothing for a span with no SPEECH at all — there is nothing to skip around", () => {
  const segments = [
    { startMs: 0, endMs: 60_000, klass: "MUSIC" },
    { startMs: 60_000, endMs: 120_000, klass: "SILENCE" },
  ];
  assert.deepEqual(planChunks(segments, 120_000, 600), []);
  assert.deepEqual(planChunks([], 120_000, 600), []);
  assert.deepEqual(planChunks(null as any, 120_000, 600), []);
});

test("planChunks splits a single SPEECH segment longer than chunkSec into chunk-sized pieces", () => {
  const segments = [{ startMs: 0, endMs: 25 * 60_000, klass: "SPEECH" }]; // 25 minutes
  const windows = planChunks(segments, 25 * 60_000, 600); // 10-minute cap
  assert.equal(windows.length, 3);
  assert.deepEqual(
    windows.map((w) => [w.startMs, w.endMs]),
    [[0, 600_000], [600_000, 1_200_000], [1_200_000, 1_500_000]],
  );
  assert.deepEqual(windows.map((w) => w.index), [0, 1, 2]);
});

test("planChunks never produces overlapping windows, and windows stay in chronological order", () => {
  const segments = [
    { startMs: 0, endMs: 50_000, klass: "SPEECH" },
    { startMs: 700_000, endMs: 950_000, klass: "SPEECH" },
    { startMs: 1_000_000, endMs: 1_400_000, klass: "SPEECH" },
  ];
  const windows = planChunks(segments, 1_400_000, 600);
  for (let i = 1; i < windows.length; i += 1) {
    assert.ok(windows[i].startMs >= windows[i - 1].endMs, "windows must never overlap");
    assert.ok(windows[i].startMs >= windows[i - 1].startMs, "windows must stay chronological");
  }
});

// ── 6. SOURCE GUARD: no paid API may ever appear in this file ───────────────

test("SOURCE GUARD: audioPipeline.ts calls no paid API and opens no socket", () => {
  const src = readFileSync(path.join(__dirname, "audioPipeline.ts"), "utf8").replace(/\r\n/g, "\n");
  const body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  for (const banned of ["fetch(", "openai", "OpenAI", "elevenlabs", "https://", "axios", "node:https"]) {
    assert.equal(body.includes(banned), false, `audioPipeline must not reference ${banned}`);
  }
});
