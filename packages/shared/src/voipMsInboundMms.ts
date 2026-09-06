/**
 * Download inbound MMS media from VoIP.ms temporary URLs and persist as
 * tenant/thread-scoped chat files (same storage as user uploads).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { maxBytesForThread, writeChatAttachmentFile } from "./chatAttachmentStorage";

const execFileAsync = promisify(execFile);

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return String(url || "").toLowerCase();
  }
}

/** VoIP.ms sometimes sends multiple comma-separated MIME tokens. */
function firstMimeToken(header: string | null | undefined): string {
  const raw = String(header || "").trim();
  if (!raw) return "";
  return raw.split(",")[0].split(";")[0].trim().toLowerCase();
}

const EXT_MIME: Record<string, string> = {
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  // Carrier-only audio containers (an iPhone voice memo sent as MMS arrives
  // from VoIP.ms as `media.amr`). Not playable in any browser and refused by
  // chat storage — they are transcoded to AAC/M4A before writing, see
  // isCarrierOnlyAudio() + transcodeCarrierAudioToM4a().
  ".amr": "audio/amr",
  ".awb": "audio/amr-wb",
  ".3ga": "audio/3gpp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".3gp": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
};

export function inferMmsFileNameAndMime(url: string, contentTypeHeader: string | null): { fileName: string; mimeType: string } {
  let path = pathnameOf(url);
  const last = path.split("/").pop() || "mms.bin";
  const extMatch = last.match(/(\.[a-z0-9]+)$/);
  const ext = extMatch ? extMatch[1] : "";
  const mimeFromExt = ext ? EXT_MIME[ext] || "" : "";
  const headerMime = firstMimeToken(contentTypeHeader);

  let mimeType = mimeFromExt;
  if (headerMime && headerMime !== "application/octet-stream" && headerMime !== "binary/octet-stream") {
    if (!mimeFromExt || headerMime.startsWith("image/") || headerMime.startsWith("video/") || headerMime.startsWith("audio/")) {
      mimeType = headerMime;
    }
  }
  if (ext === ".m4a") mimeType = "audio/mp4";
  if (!mimeType) mimeType = "application/octet-stream";

  const safeName = last.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || `mms${ext || ".bin"}`;
  return { fileName: safeName, mimeType };
}

/** Maps stored MIME to chat attachment `mediaKind` for consistent UI routing. */
export function mediaKindFromMime(mimeType: string): "image" | "audio" | "video" | "file" {
  const m = String(mimeType || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return "file";
}

export async function downloadVoipMsMmsBuffer(
  url: string,
  maxBytes: number,
  timeoutMs = 25_000,
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ac.signal,
      headers: { "User-Agent": "Connect-InboundMMS/1.0", Accept: "*/*" },
    });
    if (!res.ok) throw new Error(`mms_fetch_http_${res.status}`);
    const cl = res.headers.get("content-length");
    if (cl) {
      const n = Number(cl);
      if (Number.isFinite(n) && n > maxBytes) throw new Error("mms_fetch_too_large");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const body = res.body;
    if (!body) throw new Error("mms_fetch_no_body");
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (total > maxBytes) throw new Error("mms_fetch_too_large");
      chunks.push(b);
    }
    return { buffer: Buffer.concat(chunks), contentType: res.headers.get("content-type") };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Audio a carrier MMS gateway hands us that NO browser can decode and that
 * chat storage (rightly) refuses: AMR-NB/AMR-WB and the 3GPP audio wrappers.
 * An iPhone "voice memo" sent by text arrives exactly like this. Before
 * 2026-09-06 such a message was never mirrored (Fixup Group received two and
 * the Windows app showed a player that could not play) — the mirror silently
 * failed on `mime_not_allowed`, and the fallback was the raw VoIP.ms URL fed
 * to an `<audio>` element that has no AMR decoder.
 */
export function isCarrierOnlyAudio(mimeType: string, fileName: string): boolean {
  const mime = String(mimeType || "").toLowerCase().split(";")[0].trim();
  if (mime === "audio/amr" || mime === "audio/amr-wb" || mime === "audio/3gpp" || mime === "audio/3gpp2") return true;
  const lower = String(fileName || "").toLowerCase();
  return /\.(amr|awb|3ga)$/.test(lower);
}

/**
 * ffmpeg arguments after `-i <in>`: audio only, AAC mono, low bitrate (the
 * source is 8 kHz telephony speech), M4A with the index up front so a
 * browser can start playing before the whole file lands.
 */
export const CARRIER_AUDIO_TRANSCODE_ARGS = [
  "-vn",
  "-c:a", "aac",
  "-b:a", "64k",
  "-ac", "1",
  "-ar", "24000",
  "-movflags", "+faststart",
];

/**
 * Transcode carrier-only audio to AAC in an M4A container (`audio/mp4`, which
 * chat storage accepts and every client already plays — it is the voice-note
 * format). Returns null on any failure; the reason is logged here because the
 * callers' `.catch(() => null)` throws it away.
 */
export async function transcodeCarrierAudioToM4a(input: Buffer, sourceExt = ".amr"): Promise<Buffer | null> {
  const id = crypto.randomBytes(6).toString("hex");
  const inPath = path.join(os.tmpdir(), `cc-mms-in-${id}${sourceExt}`);
  const outPath = path.join(os.tmpdir(), `cc-mms-out-${id}.m4a`);
  try {
    await fs.promises.writeFile(inPath, input);
    await execFileAsync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", inPath, ...CARRIER_AUDIO_TRANSCODE_ARGS, outPath],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const out = await fs.promises.readFile(outPath);
    return out.length > 0 ? out : null;
  } catch (err: any) {
    console.warn(
      JSON.stringify({
        event: "voipms_mms_transcode_failed",
        reason: String(err?.message || err).slice(0, 200),
      }),
    );
    return null;
  } finally {
    await fs.promises.unlink(inPath).catch(() => undefined);
    await fs.promises.unlink(outPath).catch(() => undefined);
  }
}

/**
 * Fetch one VoIP.ms MMS URL and write to chat storage. Returns null on any
 * failure — the REASON is logged here (`voipms_mms_fetch_failed`), because
 * both callers wrap this in `.catch(() => null)` and used to lose it.
 */
export async function fetchVoipMsMmsToChatFile(input: {
  tenantId: string;
  threadId: string;
  sourceUrl: string;
  /** Use SMS/MMS cap (VoIP.ms ~1.3 MB). */
  isSmsThread: boolean;
}): Promise<{ storageKey: string; mimeType: string; sizeBytes: number; fileName: string } | null> {
  const maxBytes = maxBytesForThread(input.isSmsThread);
  const urlPrefix = String(input.sourceUrl || "").slice(0, 96);
  let buffer: Buffer;
  let contentType: string | null;
  try {
    ({ buffer, contentType } = await downloadVoipMsMmsBuffer(input.sourceUrl, maxBytes));
  } catch (err: any) {
    console.warn(JSON.stringify({ event: "voipms_mms_fetch_failed", stage: "download", reason: String(err?.message || err).slice(0, 120), urlPrefix }));
    return null;
  }
  let { fileName, mimeType } = inferMmsFileNameAndMime(input.sourceUrl, contentType);
  if (isCarrierOnlyAudio(mimeType, fileName)) {
    const ext = (fileName.match(/(\.[a-z0-9]+)$/i)?.[1] || ".amr").toLowerCase();
    const transcoded = await transcodeCarrierAudioToM4a(buffer, ext);
    if (!transcoded) {
      console.warn(JSON.stringify({ event: "voipms_mms_fetch_failed", stage: "transcode", reason: "carrier_audio_transcode_failed", mimeType, urlPrefix }));
      return null;
    }
    buffer = transcoded;
    mimeType = "audio/mp4";
    fileName = fileName.replace(/\.[a-z0-9]+$/i, "") + ".m4a";
  }
  try {
    return await writeChatAttachmentFile({
      tenantKey: input.tenantId,
      threadId: input.threadId,
      originalFilename: fileName,
      buffer,
      mimeType,
      maxBytes,
    });
  } catch (err: any) {
    console.warn(JSON.stringify({ event: "voipms_mms_fetch_failed", stage: "write", reason: String(err?.message || err).slice(0, 120), mimeType, urlPrefix }));
    return null;
  }
}
