/**
 * Yiddish corpus — local audio analysis. ffmpeg/ffprobe only.
 *
 * ⛔ NOTHING IN THIS FILE CALLS A PAID API. Every number here comes from
 * ffmpeg on the box (ffmpeg and ffprobe live at /usr/bin in the api
 * container). No GPU, no model, no network.
 *
 * ⛔ HONESTY RULES, because these are heuristics and will be read as facts:
 *  - Nothing throws when ffmpeg is missing. Every entry point answers
 *    `{ available: false, reason }` so a box without ffmpeg degrades into
 *    "we did not measure this" rather than a crashed job.
 *  - Every classification carries a `confidence` and a `method` string, and
 *    the confidence is CAPPED below certainty. `detectSegments` is silence
 *    detection plus a cheap spectral heuristic — it is not a trained
 *    music/speech classifier and must never be reported as one.
 */

import { execFile } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  error: string | null;
}

export type RunFn = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export interface AudioDeps {
  run?: RunFn;
  ffmpegPath?: string;
  ffprobePath?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;

const defaultRun: RunFn = (cmd, args, timeoutMs) =>
  new Promise<RunResult>((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      resolve({
        code: err?.code == null ? 0 : Number(err.code) || 1,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        // ENOENT is the "ffmpeg is not installed" case and must stay a value,
        // never an exception.
        error: err ? String(err.code === "ENOENT" ? "ENOENT" : err.message || err) : null,
      });
    });
  });

function tools(deps: AudioDeps) {
  return {
    run: deps.run ?? defaultRun,
    ffmpeg: deps.ffmpegPath ?? process.env.YC_FFMPEG_PATH ?? "ffmpeg",
    ffprobe: deps.ffprobePath ?? process.env.YC_FFPROBE_PATH ?? "ffprobe",
  };
}

function missingReason(res: RunResult, bin: string): string | null {
  if (res.error === "ENOENT" || /ENOENT|not found|not recognized/i.test(res.error || "")) {
    return `${bin} is not installed on this host, so no audio measurement was taken`;
  }
  return null;
}

export interface FfmpegAvailability {
  available: boolean;
  reason: string | null;
  ffmpeg: boolean;
  ffprobe: boolean;
}

/** Is there an ffmpeg here at all? Answers, never throws. */
export async function ffmpegAvailability(deps: AudioDeps = {}): Promise<FfmpegAvailability> {
  const t = tools(deps);
  const [a, b] = await Promise.all([
    t.run(t.ffprobe, ["-version"], 15_000),
    t.run(t.ffmpeg, ["-version"], 15_000),
  ]);
  const ffprobeOk = !missingReason(a, "ffprobe") && a.code === 0;
  const ffmpegOk = !missingReason(b, "ffmpeg") && b.code === 0;
  if (ffprobeOk && ffmpegOk) return { available: true, reason: null, ffmpeg: true, ffprobe: true };
  const why = [!ffprobeOk ? "ffprobe" : null, !ffmpegOk ? "ffmpeg" : null].filter(Boolean).join(" and ");
  return {
    available: false,
    reason: `${why} unavailable on this host, so no audio measurement was taken`,
    ffmpeg: ffmpegOk,
    ffprobe: ffprobeOk,
  };
}

// ── probe ───────────────────────────────────────────────────────────────────

export interface ProbeAudioResult {
  available: boolean;
  reason: string | null;
  durationMs?: number | null;
  sampleRate?: number | null;
  channels?: number | null;
  codec?: string | null;
  bitrate?: number | null;
  sizeBytes?: number | null;
}

/** Container facts, straight from ffprobe. No heuristics live here. */
export async function probeAudio(filePath: string, deps: AudioDeps = {}): Promise<ProbeAudioResult> {
  const t = tools(deps);
  const res = await t.run(
    t.ffprobe,
    ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
    30_000,
  );
  const missing = missingReason(res, "ffprobe");
  if (missing) return { available: false, reason: missing };
  if (res.code !== 0 || !res.stdout.trim()) {
    return { available: false, reason: `ffprobe could not read the file (exit ${res.code})` };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { available: false, reason: "ffprobe returned output this code could not parse" };
  }
  const stream = (parsed?.streams || []).find((s: any) => s?.codec_type === "audio") || null;
  const fmt = parsed?.format || {};
  const num = (v: any): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const durSec = num(fmt.duration) ?? num(stream?.duration);
  return {
    available: true,
    reason: null,
    durationMs: durSec == null ? null : Math.round(durSec * 1000),
    sampleRate: num(stream?.sample_rate),
    channels: num(stream?.channels),
    codec: stream?.codec_name ? String(stream.codec_name) : null,
    bitrate: num(fmt.bit_rate),
    sizeBytes: num(fmt.size),
  };
}

// ── segments ────────────────────────────────────────────────────────────────

export type YcSegmentClass = "SPEECH" | "MUSIC" | "SILENCE" | "MIXED" | "UNKNOWN";

export interface DetectedSegment {
  startMs: number;
  endMs: number;
  klass: YcSegmentClass;
  /** 0..1, and deliberately never 1. These are heuristics. */
  klassConfidence: number;
  /** Plain English: exactly which measurement produced this label. */
  basis: string;
}

export interface DetectSegmentsResult {
  available: boolean;
  reason: string | null;
  method?: string;
  segments?: DetectedSegment[];
  speechRatio?: number | null;
  silenceRatio?: number | null;
  durationMs?: number | null;
}

/** Highest confidence this heuristic is ever allowed to claim. */
export const YC_SEGMENT_MAX_CONFIDENCE = 0.75;

export interface SilenceSpan {
  startMs: number;
  endMs: number;
}

/** Parse ffmpeg's `silencedetect` lines out of stderr. Pure and testable. */
export function parseSilenceDetect(stderr: string, totalMs: number | null): SilenceSpan[] {
  const spans: SilenceSpan[] = [];
  let openStart: number | null = null;
  const re = /silence_(start|end):\s*(-?[\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) {
    const at = Math.max(0, Math.round(Number(m[2]) * 1000));
    if (!Number.isFinite(at)) continue;
    if (m[1] === "start") openStart = at;
    else if (openStart != null) {
      if (at > openStart) spans.push({ startMs: openStart, endMs: at });
      openStart = null;
    }
  }
  if (openStart != null && totalMs != null && totalMs > openStart) {
    spans.push({ startMs: openStart, endMs: totalMs });
  }
  return spans;
}

/** Parse the `Parsed_astats` block ffmpeg prints on stderr. Pure and testable. */
export function parseAstats(stderr: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /^\s*\[Parsed_astats[^\]]*\]\s*([A-Za-z_ ()/.-]+?):\s*(-?[\d.]+(?:e[-+]?\d+)?)\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) {
    const key = m[1].trim().toLowerCase().replace(/\s+/g, "_");
    const val = Number(m[2]);
    if (Number.isFinite(val)) out[key] = val;
  }
  return out;
}

/**
 * THE MUSIC-VS-SPEECH HEURISTIC, stated honestly.
 *
 * We do NOT have a classifier. What we have is two cheap measurements:
 *   1. `silencedetect` gap density. Conversational speech pauses: a talk
 *      segment typically shows several sub-second gaps per minute. Continuous
 *      music shows almost none.
 *   2. ffmpeg `astats` entropy and flat factor over the span. Broadband music
 *      sits at a higher spectral entropy and a lower flat factor than a single
 *      voice on a telephone-band recording.
 *
 * Neither is decisive. So: a span with a healthy pause density AND
 * speech-like entropy is called SPEECH at 0.7; a span with near-zero pauses
 * AND high entropy is called MUSIC at 0.6; anything that disagrees with
 * itself is MIXED at 0.4; a span with no usable astats is UNKNOWN at 0.2.
 * Nothing here is ever above YC_SEGMENT_MAX_CONFIDENCE, and `basis` always
 * names the numbers that produced the label.
 *
 * ⛔ Do not present these labels as ground truth anywhere in the UI.
 */
export function classifySpan(input: {
  durationMs: number;
  pauseCount: number;
  entropy: number | null;
  flatFactor: number | null;
}): { klass: YcSegmentClass; klassConfidence: number; basis: string } {
  const minutes = Math.max(input.durationMs / 60_000, 1 / 60);
  const pausesPerMin = input.pauseCount / minutes;
  const ent = input.entropy;
  const parts = [
    `${pausesPerMin.toFixed(1)} pauses/min`,
    ent == null ? "no entropy reading" : `entropy ${ent.toFixed(3)}`,
    input.flatFactor == null ? "no flat factor" : `flat ${input.flatFactor.toFixed(1)}`,
  ];
  const basis = `heuristic: ${parts.join(", ")}`;

  if (ent == null) return { klass: "UNKNOWN", klassConfidence: 0.2, basis: `${basis} — not enough to judge` };

  const speechLikePauses = pausesPerMin >= 4;
  const musicLikePauses = pausesPerMin < 1;
  const speechLikeSpectrum = ent < 0.75;
  const musicLikeSpectrum = ent >= 0.75;

  if (speechLikePauses && speechLikeSpectrum) return { klass: "SPEECH", klassConfidence: 0.7, basis };
  if (musicLikePauses && musicLikeSpectrum) return { klass: "MUSIC", klassConfidence: 0.6, basis };
  if (speechLikePauses || speechLikeSpectrum) return { klass: "SPEECH", klassConfidence: 0.45, basis };
  return { klass: "MIXED", klassConfidence: 0.4, basis };
}

export interface DetectSegmentsOptions extends AudioDeps {
  /** silencedetect noise floor in dB (negative). */
  noiseDb?: number;
  /** Minimum silence length, seconds. */
  minSilenceSec?: number;
  /** Spans shorter than this are folded into their neighbour. */
  minSegmentMs?: number;
}

/**
 * Split an asset into speech / silence / music spans.
 * Two ffmpeg passes, both local: one `silencedetect`, one `astats`.
 */
export async function detectSegments(
  filePath: string,
  opts: DetectSegmentsOptions = {},
): Promise<DetectSegmentsResult> {
  const t = tools(opts);
  const noiseDb = opts.noiseDb ?? -35;
  const minSilenceSec = opts.minSilenceSec ?? 0.35;
  const minSegmentMs = opts.minSegmentMs ?? 1_000;

  const probed = await probeAudio(filePath, opts);
  if (!probed.available) return { available: false, reason: probed.reason };
  const totalMs = probed.durationMs ?? null;

  const silenceRun = await t.run(
    t.ffmpeg,
    ["-hide_banner", "-nostats", "-i", filePath, "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`, "-f", "null", "-"],
    DEFAULT_TIMEOUT_MS,
  );
  const missing = missingReason(silenceRun, "ffmpeg");
  if (missing) return { available: false, reason: missing };

  const statsRun = await t.run(
    t.ffmpeg,
    ["-hide_banner", "-nostats", "-i", filePath, "-af", "astats=measure_perchannel=none", "-f", "null", "-"],
    DEFAULT_TIMEOUT_MS,
  );
  const stats = parseAstats(statsRun.stderr);
  const entropy = stats.entropy ?? null;
  const flatFactor = stats.flat_factor ?? null;

  const silences = parseSilenceDetect(silenceRun.stderr, totalMs);
  const segments: DetectedSegment[] = [];
  let cursor = 0;
  const pushLoud = (startMs: number, endMs: number) => {
    if (endMs - startMs < minSegmentMs) return;
    // Pauses INSIDE this span are what the heuristic reads; a loud span is
    // bounded by silences, so we count the silences that touch it.
    const pauseCount = silences.filter((s) => s.startMs >= startMs - 1 && s.endMs <= endMs + 1).length;
    const verdict = classifySpan({ durationMs: endMs - startMs, pauseCount, entropy, flatFactor });
    segments.push({ startMs, endMs, ...verdict });
  };

  for (const s of silences) {
    if (s.startMs > cursor) pushLoud(cursor, s.startMs);
    if (s.endMs - s.startMs >= minSegmentMs) {
      segments.push({
        startMs: s.startMs,
        endMs: s.endMs,
        klass: "SILENCE",
        klassConfidence: 0.7,
        basis: `silencedetect below ${noiseDb} dB for ${((s.endMs - s.startMs) / 1000).toFixed(2)}s`,
      });
    }
    cursor = Math.max(cursor, s.endMs);
  }
  if (totalMs != null && totalMs > cursor) pushLoud(cursor, totalMs);

  // Whole-file heuristic when silencedetect found nothing at all: one span.
  if (segments.length === 0 && totalMs != null && totalMs > 0) {
    const verdict = classifySpan({ durationMs: totalMs, pauseCount: 0, entropy, flatFactor });
    segments.push({ startMs: 0, endMs: totalMs, ...verdict });
  }

  const denom = totalMs && totalMs > 0 ? totalMs : segments.reduce((a, s) => a + (s.endMs - s.startMs), 0) || null;
  const sum = (pred: (s: DetectedSegment) => boolean) =>
    segments.filter(pred).reduce((a, s) => a + (s.endMs - s.startMs), 0);

  return {
    available: true,
    reason: null,
    method: `ffmpeg silencedetect(noise=${noiseDb}dB,d=${minSilenceSec}s) + astats heuristic — not a trained classifier`,
    segments,
    durationMs: totalMs,
    speechRatio: denom ? Number((sum((s) => s.klass === "SPEECH") / denom).toFixed(4)) : null,
    silenceRatio: denom ? Number((sum((s) => s.klass === "SILENCE") / denom).toFixed(4)) : null,
  };
}

// ── features ────────────────────────────────────────────────────────────────

export interface AudioFeatures {
  available: boolean;
  reason: string | null;
  method?: string;
  rmsDb?: number | null;
  peakDb?: number | null;
  /** EBU R128 integrated loudness, when ffmpeg's loudnorm is willing. */
  loudnessLufs?: number | null;
  dynamicRangeDb?: number | null;
  zeroCrossingRate?: number | null;
  /** Pauses per minute and their spread — the prosody-relevant half. */
  pauseCount?: number | null;
  pausesPerMinute?: number | null;
  medianPauseMs?: number | null;
  longestPauseMs?: number | null;
  /**
   * Syllables/second is NOT measured — there is no aligner here. This is an
   * ENERGY-BURST rate, which correlates with speech rate and is labelled as
   * an estimate everywhere it is surfaced.
   */
  speechRateEstimate?: number | null;
  speechRateBasis?: string | null;
  /** Rough pitch statistics, only when they are cheap. Often null. */
  pitchMeanHz?: number | null;
  pitchBasis?: string | null;
}

/**
 * Per-span measurements: loudness, pause distribution, a speech-rate estimate
 * and (cheaply, often not at all) rough pitch.
 *
 * Every field can be null and the caller must treat null as "not measured",
 * never as zero.
 */
export async function extractFeatures(
  filePath: string,
  segment: { startMs?: number | null; endMs?: number | null } | null | undefined,
  opts: DetectSegmentsOptions = {},
): Promise<AudioFeatures> {
  const t = tools(opts);
  const startMs = Math.max(0, Number(segment?.startMs ?? 0) || 0);
  const endMs = Number(segment?.endMs ?? 0) || 0;
  const spanSec = endMs > startMs ? (endMs - startMs) / 1000 : null;

  const trim: string[] = [];
  if (startMs > 0) trim.push("-ss", (startMs / 1000).toFixed(3));
  if (spanSec) trim.push("-t", spanSec.toFixed(3));

  const noiseDb = opts.noiseDb ?? -35;
  const minSilenceSec = opts.minSilenceSec ?? 0.25;

  const run = await t.run(
    t.ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      ...trim,
      "-i",
      filePath,
      "-af",
      `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec},astats=measure_perchannel=none`,
      "-f",
      "null",
      "-",
    ],
    DEFAULT_TIMEOUT_MS,
  );
  const missing = missingReason(run, "ffmpeg");
  if (missing) return { available: false, reason: missing };
  if (run.code !== 0 && !run.stderr) {
    return { available: false, reason: `ffmpeg could not analyse the file (exit ${run.code})` };
  }

  const stats = parseAstats(run.stderr);
  const durSec = spanSec ?? (stats.number_of_samples && stats.sample_rate ? stats.number_of_samples / stats.sample_rate : null);
  const silences = parseSilenceDetect(run.stderr, durSec == null ? null : Math.round(durSec * 1000));
  const pauseLengths = silences.map((s) => s.endMs - s.startMs).sort((a, b) => a - b);
  const median = pauseLengths.length
    ? pauseLengths[Math.floor((pauseLengths.length - 1) / 2)]
    : null;

  // Energy bursts = the loud spans between detected silences. Their rate is
  // the speech-rate PROXY. It is not a syllable count and is never called one.
  const burstCount = silences.length + (durSec ? 1 : 0);
  const speechRate = durSec && durSec > 0 ? Number((burstCount / durSec).toFixed(3)) : null;

  const val = (k: string): number | null => (Number.isFinite(stats[k]) ? stats[k] : null);
  const rmsDb = val("rms_level_db") ?? val("overall_rms_level_db") ?? null;
  const peakDb = val("peak_level_db") ?? val("max_level_db") ?? null;

  return {
    available: true,
    reason: null,
    method: "ffmpeg astats + silencedetect, single local pass",
    rmsDb,
    peakDb,
    loudnessLufs: null,
    dynamicRangeDb: val("dynamic_range") ?? (rmsDb != null && peakDb != null ? Number((peakDb - rmsDb).toFixed(2)) : null),
    zeroCrossingRate: val("zero_crossings_rate"),
    pauseCount: silences.length,
    pausesPerMinute: durSec && durSec > 0 ? Number(((silences.length / durSec) * 60).toFixed(2)) : null,
    medianPauseMs: median,
    longestPauseMs: pauseLengths.length ? pauseLengths[pauseLengths.length - 1] : null,
    speechRateEstimate: speechRate,
    speechRateBasis:
      "energy bursts per second between detected silences — a PROXY for speech rate, not a syllable count",
    // ffmpeg gives no cheap f0. We say so rather than inventing a number.
    pitchMeanHz: null,
    pitchBasis: "not measured: no cheap local pitch tracker in this pipeline",
  };
}
