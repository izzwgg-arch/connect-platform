/**
 * Download inbound MMS media from VoIP.ms temporary URLs and persist as
 * tenant/thread-scoped chat files (same storage as user uploads).
 */

import { maxBytesForThread, writeChatAttachmentFile } from "./chatAttachmentStorage";

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
 * Fetch one VoIP.ms MMS URL and write to chat storage. Returns null on any failure (logged by caller).
 */
export async function fetchVoipMsMmsToChatFile(input: {
  tenantId: string;
  threadId: string;
  sourceUrl: string;
  /** Use SMS/MMS cap (VoIP.ms ~1.3 MB). */
  isSmsThread: boolean;
}): Promise<{ storageKey: string; mimeType: string; sizeBytes: number; fileName: string } | null> {
  const maxBytes = maxBytesForThread(input.isSmsThread);
  let buffer: Buffer;
  let contentType: string | null;
  try {
    ({ buffer, contentType } = await downloadVoipMsMmsBuffer(input.sourceUrl, maxBytes));
  } catch {
    return null;
  }
  const { fileName, mimeType } = inferMmsFileNameAndMime(input.sourceUrl, contentType);
  try {
    return await writeChatAttachmentFile({
      tenantKey: input.tenantId,
      threadId: input.threadId,
      originalFilename: fileName,
      buffer,
      mimeType,
      maxBytes,
    });
  } catch {
    return null;
  }
}
