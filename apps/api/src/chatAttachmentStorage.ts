/**
 * Local filesystem storage for Connect chat attachments + path resolution.
 * Signed download URLs live in @connect/shared (`buildChatSignedDownloadUrl`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const DEFAULT_ROOT = path.resolve(process.cwd(), "data/chat-attachments");

export function getChatAttachmentStorageRoot(): string {
  return (process.env.CHAT_STORAGE_DIR || DEFAULT_ROOT).replace(/\/+$/, "");
}

/** Match moh-style segment sanitizer. */
export function sanitizePathSegment(raw: string): string {
  return String(raw || "").toLowerCase().replace(/[^a-z0-9_\-]+/g, "_").replace(/^_+|_+$/g, "");
}

export function resolveChatStoragePath(storageKey: string): string {
  const clean = String(storageKey || "").replace(/\\/g, "/");
  if (clean.includes("..")) throw new Error("invalid_storage_key");
  const root = getChatAttachmentStorageRoot();
  const full = path.resolve(root, clean);
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new Error("invalid_storage_key_scope");
  }
  return full;
}

const MMS_MAX_BYTES = Math.min(Number(process.env.CHAT_MMS_MAX_BYTES) || 1300 * 1024, 5 * 1024 * 1024);
const INTERNAL_MAX_BYTES = Math.min(Number(process.env.CHAT_ATTACHMENT_MAX_BYTES) || 25 * 1024 * 1024, 50 * 1024 * 1024);

export function maxBytesForThread(isSms: boolean): number {
  return isSms ? MMS_MAX_BYTES : INTERNAL_MAX_BYTES;
}

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "audio/mpeg",
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "application/pdf",
]);

export function isAllowedChatMime(mime: string): boolean {
  return ALLOWED_MIME.has(String(mime || "").toLowerCase().split(";")[0].trim());
}

export async function writeChatAttachmentFile(input: {
  /** Sanitized tenant id (path segment under storage root). */
  tenantKey: string;
  threadId: string;
  originalFilename: string;
  buffer: Buffer;
  mimeType: string;
  maxBytes: number;
}): Promise<{ storageKey: string; sha256: string; sizeBytes: number; mimeType: string; fileName: string }> {
  if (!isAllowedChatMime(input.mimeType)) throw new Error("mime_not_allowed");
  if (input.buffer.length > input.maxBytes) throw new Error("file_too_large");

  const tenantSeg = sanitizePathSegment(input.tenantKey);
  const threadSeg = sanitizePathSegment(input.threadId);
  if (!tenantSeg || !threadSeg) throw new Error("invalid_tenant_or_thread");

  const ext = path.extname(input.originalFilename || "").toLowerCase().replace(/[^.a-z0-9]/g, "");
  const id = crypto.randomBytes(8).toString("hex");
  const base = `f_${id}${ext || ""}`;
  const storageKey = `${tenantSeg}/${threadSeg}/${base}`;
  const absolutePath = resolveChatStoragePath(storageKey);
  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.promises.writeFile(absolutePath, input.buffer);

  const sha256 = crypto.createHash("sha256").update(input.buffer).digest("hex");
  const fileName = path.basename(input.originalFilename || base) || base;
  return { storageKey, sha256, sizeBytes: input.buffer.length, mimeType: input.mimeType.split(";")[0].trim(), fileName };
}

export function assertStorageKeyForThread(storageKey: string, tenantId: string, threadId: string): void {
  const tenantSeg = sanitizePathSegment(tenantId);
  const threadSeg = sanitizePathSegment(threadId);
  const prefix = `${tenantSeg}/${threadSeg}/`;
  if (!storageKey.startsWith(prefix)) throw new Error("storage_key_mismatch");
}
