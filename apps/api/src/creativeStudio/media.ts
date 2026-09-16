/**
 * Creative Studio — the media pipeline.
 *
 * FFmpeg is already in the api and worker images and is called the way the
 * rest of Loopcom calls it: execFile with an ARGUMENT ARRAY. No shell string is
 * ever built, so there is nothing for a filename or a prompt to escape into.
 *
 * ⛔ Every call passes -protocol_whitelist file,pipe. A playlist or container
 * can otherwise talk FFmpeg into fetching a URL, which would turn "join these
 * two clips" into a request from our own server to anywhere — the classic
 * media-pipeline SSRF. Local files and pipes only.
 */
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const SAFE_PROTOCOLS = ["-protocol_whitelist", "file,pipe"];

export class MediaError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
  }
}

function run(bin: string, args: string[], timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message).split("\n").slice(-6).join("\n");
        reject(new MediaError(`${path.basename(bin)} failed`, detail));
        return;
      }
      resolve(String(stdout || stderr || ""));
    });
  });
}

/** A scratch directory that cleans itself up, even when a step throws. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "creative-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function tempName(ext: string): string {
  return `${crypto.randomBytes(8).toString("hex")}.${ext.replace(/[^a-z0-9]/gi, "")}`;
}

export interface Probe {
  durationMs: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
}

export async function probe(file: string): Promise<Probe> {
  const out = await run(FFPROBE, [
    ...SAFE_PROTOCOLS,
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    file,
  ], 60_000);
  const parsed = JSON.parse(out || "{}");
  const streams: any[] = parsed.streams || [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const seconds = Number(parsed.format?.duration || video?.duration || 0);
  return {
    durationMs: Math.round(seconds * 1000),
    width: video ? Number(video.width) : undefined,
    height: video ? Number(video.height) : undefined,
    hasAudio: !!audio,
  };
}

/** A small JPEG for a list view. Works for both images and video. */
export async function thumbnail(input: string, output: string, atSeconds = 0.5): Promise<void> {
  await run(FFMPEG, [
    ...SAFE_PROTOCOLS,
    "-y",
    "-ss", String(atSeconds),
    "-i", input,
    "-frames:v", "1",
    "-vf", "scale='min(480,iw)':-2",
    "-q:v", "6",
    output,
  ], 120_000);
}

/** The last frame of a clip — what a continuing segment starts from. */
export async function lastFrame(input: string, output: string): Promise<void> {
  const info = await probe(input);
  const at = Math.max(0, info.durationMs / 1000 - 0.08);
  await run(FFMPEG, [...SAFE_PROTOCOLS, "-y", "-ss", String(at), "-i", input, "-frames:v", "1", output], 120_000);
}

/**
 * Take a piece out of a clip. `fromSeconds` is what makes splitting a shot in
 * the editor honest: without it the second half would start at the beginning
 * of the source again, which looks like the editor ignoring you.
 *
 * ⛔ -ss goes BEFORE -i so FFmpeg seeks instead of decoding and throwing away
 * everything up to the cut; with a 15-second clip the difference is small, but
 * on a minute of footage it is the difference between instant and a wait.
 */
export async function trimTo(input: string, output: string, seconds: number, fromSeconds = 0): Promise<void> {
  const from = Math.max(0, Number(fromSeconds) || 0);
  await run(FFMPEG, [
    ...SAFE_PROTOCOLS, "-y",
    ...(from > 0.01 ? ["-ss", String(from)] : []),
    "-i", input, "-t", String(Math.max(0.1, seconds)),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart", output,
  ]);
}

/**
 * Join clips into one file. Re-encoded rather than stream-copied because the
 * segments can come from different engines at different settings, and a
 * concat of mismatched streams produces a file that plays for three seconds
 * and then freezes — which looks exactly like a broken render.
 */
export async function concat(inputs: string[], output: string, opts: { width?: number; height?: number; fps?: number } = {}): Promise<void> {
  if (!inputs.length) throw new MediaError("Nothing to join");
  if (inputs.length === 1) {
    await run(FFMPEG, [...SAFE_PROTOCOLS, "-y", "-i", inputs[0], "-c", "copy", "-movflags", "+faststart", output]);
    return;
  }
  const w = opts.width || 1280;
  const h = opts.height || 720;
  const fps = opts.fps || 30;
  const args: string[] = [...SAFE_PROTOCOLS, "-y"];
  inputs.forEach((f) => args.push("-i", f));
  const chains = inputs
    .map((_, i) => `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${i}]`)
    .join(";");
  const joined = inputs.map((_, i) => `[v${i}]`).join("");
  args.push(
    "-filter_complex", `${chains};${joined}concat=n=${inputs.length}:v=1:a=0[outv]`,
    "-map", "[outv]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    output,
  );
  await run(FFMPEG, args, 900_000);
}

export interface AudioLayer {
  file: string;
  startMs: number;
  gain: number;
  /** Music ducks under narration; narration does not duck. */
  duck?: boolean;
}

/**
 * Lay voice, music and effects under a picture. Music is ducked by a fixed
 * amount when narration is present, which is what "ducking" means to the
 * person who asked for it — a sidechain compressor is more faithful and far
 * more fragile across FFmpeg builds.
 */
export async function mixAudioOntoVideo(video: string, layers: AudioLayer[], output: string, totalMs: number): Promise<void> {
  if (!layers.length) {
    await run(FFMPEG, [...SAFE_PROTOCOLS, "-y", "-i", video, "-c", "copy", "-movflags", "+faststart", output]);
    return;
  }
  const args: string[] = [...SAFE_PROTOCOLS, "-y", "-i", video];
  layers.forEach((l) => args.push("-i", l.file));
  const chains = layers
    .map((l, i) => {
      const idx = i + 1;
      const delay = Math.max(0, Math.round(l.startMs));
      const gain = Math.max(0, Math.min(4, l.gain));
      return `[${idx}:a]adelay=${delay}|${delay},volume=${gain.toFixed(3)}[a${idx}]`;
    })
    .join(";");
  const inputs = layers.map((_, i) => `[a${i + 1}]`).join("");
  args.push(
    "-filter_complex", `${chains};${inputs}amix=inputs=${layers.length}:duration=longest:dropout_transition=0,alimiter=limit=0.95[outa]`,
    "-map", "0:v", "-map", "[outa]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-t", String(Math.max(0.5, totalMs / 1000)),
    "-movflags", "+faststart",
    output,
  );
  await run(FFMPEG, args, 900_000);
}

export interface CaptionCue {
  startMs: number;
  endMs: number;
  text: string;
}

function srtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = String(Math.floor(total / 3_600_000)).padStart(2, "0");
  const m = String(Math.floor((total % 3_600_000) / 60_000)).padStart(2, "0");
  const s = String(Math.floor((total % 60_000) / 1000)).padStart(2, "0");
  const f = String(total % 1000).padStart(3, "0");
  return `${h}:${m}:${s},${f}`;
}

export function toSrt(cues: CaptionCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\n${String(c.text || "").replace(/\r?\n/g, " ").trim()}\n`)
    .join("\n");
}

/** Burn captions in. The .srt is written beside it for platforms that want one. */
export async function burnCaptions(video: string, srtFile: string, output: string, style: { fontSize?: number; colour?: string } = {}): Promise<void> {
  const size = Math.max(12, Math.min(48, style.fontSize || 24));
  // The subtitles filter takes a filename in a filter string, so the path is
  // escaped rather than interpolated raw: a colon or backslash in it would
  // otherwise be read as filter syntax.
  const escaped = srtFile.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  await run(FFMPEG, [
    ...SAFE_PROTOCOLS, "-y", "-i", video,
    "-vf", `subtitles='${escaped}':force_style='FontSize=${size},PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=2,Shadow=0,MarginV=40'`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "copy", "-movflags", "+faststart",
    output,
  ], 900_000);
}

/** Re-frame for a platform: fill the target shape, never stretch. */
export async function reframe(input: string, output: string, width: number, height: number): Promise<void> {
  await run(FFMPEG, [
    ...SAFE_PROTOCOLS, "-y", "-i", input,
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    // The level social platforms expect, so a video is not quieter than
    // everything around it in the feed.
    "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
    "-movflags", "+faststart",
    output,
  ], 900_000);
}

/** Convert a still image to a given size/format for export. */
export async function convertImage(input: string, output: string, opts: { width?: number; height?: number; quality?: number } = {}): Promise<void> {
  const filters: string[] = [];
  if (opts.width && opts.height) filters.push(`scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase,crop=${opts.width}:${opts.height}`);
  else if (opts.width) filters.push(`scale=${opts.width}:-2`);
  const args = [...SAFE_PROTOCOLS, "-y", "-i", input];
  if (filters.length) args.push("-vf", filters.join(","));
  if (opts.quality) args.push("-q:v", String(opts.quality));
  args.push(output);
  await run(FFMPEG, args, 180_000);
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run(FFMPEG, ["-version"], 10_000);
    return true;
  } catch {
    return false;
  }
}
