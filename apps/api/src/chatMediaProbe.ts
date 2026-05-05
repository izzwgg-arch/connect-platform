/**
 * Media metadata probe for chat attachments.
 *
 * Used by the chat upload handler to capture:
 *   - mediaKind        : "image" | "audio" | "video" | "file"
 *   - durationMs       : audio/video only
 *   - width / height   : image/video only
 *
 * Why this exists: the mobile + portal chat UIs need exact dimensions to
 * lay out image bubbles without a flash-of-incorrect-size, and the
 * voice-note bubble needs duration for its progress slider before the
 * audio has been decoded. The MMS worker also reads `durationMs` to skip
 * the ffmpeg conversion when the source is already short + small.
 *
 * Implementation: shells out to `ffprobe` (already in the API container —
 * see apps/api/Dockerfile) for audio/video, and a tiny header parser for
 * the four common image formats so we don't pay the ~50 ms ffprobe cold
 * start for every photo upload.
 *
 * Failure mode: if probing fails for any reason we still return a sane
 * `mediaKind` (derived from the MIME type) and leave optional fields
 * undefined. Chat upload must NEVER fail because of probe issues — those
 * fields are decorative.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Minimal structured logger. The api process already has Fastify's pino
// available via req.log, but `probeChatMedia` is also called from contexts
// that don't carry a request (background re-scans, dev scripts), so we use
// console here intentionally — these probe failures are non-fatal and
// purely diagnostic.
const log = {
  warn(payload: Record<string, unknown>, msg: string): void {
    try {
      console.warn(JSON.stringify({ event: "chat_media_probe_warn", msg, ...payload }));
    } catch {
      console.warn(msg, payload);
    }
  },
};

export type ChatMediaKind = "image" | "audio" | "video" | "file";

export type ChatMediaMetadata = {
  mediaKind: ChatMediaKind;
  durationMs?: number;
  width?: number;
  height?: number;
};

export function classifyChatMediaKind(mimeType: string): ChatMediaKind {
  const m = String(mimeType || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return "file";
}

/**
 * Probe a chat attachment buffer for media metadata. Always resolves with
 * at least `mediaKind` populated; never throws.
 */
export async function probeChatMedia(
  buffer: Buffer,
  mimeType: string,
): Promise<ChatMediaMetadata> {
  const mediaKind = classifyChatMediaKind(mimeType);

  if (mediaKind === "image") {
    const dims = parseImageDimensions(buffer, mimeType);
    if (dims) return { mediaKind, width: dims.width, height: dims.height };
    return { mediaKind };
  }

  if (mediaKind === "audio" || mediaKind === "video") {
    try {
      const probed = await ffprobeFromBuffer(buffer, mediaKind === "video");
      return { mediaKind, ...probed };
    } catch (err: any) {
      log.warn(
        { err: err?.message, mimeType, mediaKind },
        "ffprobe failed — returning bare mediaKind",
      );
      return { mediaKind };
    }
  }

  return { mediaKind };
}

// ─── ffprobe (audio + video) ─────────────────────────────────────────────────

async function ffprobeFromBuffer(
  buffer: Buffer,
  wantDimensions: boolean,
): Promise<{ durationMs?: number; width?: number; height?: number }> {
  const tmp = path.join(
    os.tmpdir(),
    `cc-chatprobe-${crypto.randomBytes(6).toString("hex")}`,
  );
  await fs.promises.writeFile(tmp, buffer);
  try {
    const args = [
      "-v",
      "error",
      "-show_entries",
      wantDimensions
        ? "stream=width,height:format=duration"
        : "format=duration",
      "-of",
      "json",
      tmp,
    ];
    const { stdout } = await execFileAsync("ffprobe", args, { timeout: 8_000 });
    const parsed = JSON.parse(stdout || "{}");
    const dur = Number(parsed?.format?.duration);
    const out: { durationMs?: number; width?: number; height?: number } = {};
    if (Number.isFinite(dur) && dur > 0) out.durationMs = Math.round(dur * 1000);
    if (wantDimensions) {
      const stream = (parsed?.streams || []).find((s: any) => s?.width && s?.height);
      if (stream) {
        out.width = Number(stream.width) || undefined;
        out.height = Number(stream.height) || undefined;
      }
    }
    return out;
  } finally {
    fs.promises.unlink(tmp).catch(() => undefined);
  }
}

// ─── Image dimension parser (no native deps) ─────────────────────────────────
//
// Supports JPEG, PNG, GIF, WebP. Falls back to undefined for any other
// container or malformed file — caller will treat the bubble as "best-fit"
// and let `Image.getSize` handle it on the client side.

function parseImageDimensions(
  buffer: Buffer,
  mimeType: string,
): { width: number; height: number } | null {
  const mime = String(mimeType || "").toLowerCase();
  try {
    if (mime === "image/png") return parsePng(buffer);
    if (mime === "image/jpeg") return parseJpeg(buffer);
    if (mime === "image/gif") return parseGif(buffer);
    if (mime === "image/webp") return parseWebp(buffer);
  } catch {
    /* fall through */
  }
  return null;
}

function parsePng(buf: Buffer): { width: number; height: number } | null {
  // PNG signature 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A then IHDR chunk
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf.toString("ascii", 1, 4) !== "PNG") return null;
  // IHDR width @ offset 16, height @ offset 20 (big-endian uint32)
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width && height ? { width, height } : null;
}

function parseJpeg(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) return null;
    let marker = buf[i + 1];
    // Skip fill bytes
    while (marker === 0xff && i + 2 < buf.length) {
      i += 1;
      marker = buf[i + 1];
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS — no dimensions
    const segLen = buf.readUInt16BE(i + 2);
    // SOFn markers (0xC0..0xCF) carry frame dimensions, except 0xC4 (DHT), 0xC8 (JPG), 0xCC (DAC)
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      // After segment length (2 bytes) and precision (1 byte): height (2), width (2)
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return width && height ? { width, height } : null;
    }
    i += 2 + segLen;
  }
  return null;
}

function parseGif(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 10) return null;
  const sig = buf.toString("ascii", 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  return width && height ? { width, height } : null;
}

function parseWebp(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 30) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const fourcc = buf.toString("ascii", 12, 16);
  if (fourcc === "VP8 ") {
    // Lossy: dimensions @ 26 (14 bits each, little-endian, mask out top 2 bits)
    const w = buf.readUInt16LE(26) & 0x3fff;
    const h = buf.readUInt16LE(28) & 0x3fff;
    return w && h ? { width: w, height: h } : null;
  }
  if (fourcc === "VP8L") {
    // Lossless: dimensions packed into 14 bits each starting @ 21, with +1 offset
    const b0 = buf[21];
    const b1 = buf[22];
    const b2 = buf[23];
    const b3 = buf[24];
    const w = 1 + (((b1 & 0x3f) << 8) | b0);
    const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width: w, height: h };
  }
  if (fourcc === "VP8X") {
    // Extended: 24-bit width @ 24, height @ 27 (each +1)
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width: w, height: h };
  }
  return null;
}
