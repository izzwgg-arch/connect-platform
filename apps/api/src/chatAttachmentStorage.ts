/**
 * Tenant-scoped storage for Connect chat attachments.
 *
 * Defaults to local disk for dev/back-compat. Set CHAT_STORAGE_DRIVER=s3 plus
 * CHAT_S3_* / CHAT_R2_* env vars to stream objects through S3/R2-compatible
 * storage without changing the public upload/download API.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { Readable } from "node:stream";
import * as path from "node:path";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const DEFAULT_ROOT = path.resolve(process.cwd(), "data/chat-attachments");
type ChatStorageDriver = "local" | "s3";
type StoredObjectInfo = { sizeBytes: number; contentType?: string };
type StoredObjectStream = StoredObjectInfo & { body: NodeJS.ReadableStream };

export function getChatAttachmentStorageRoot(): string {
  return (process.env.CHAT_STORAGE_DIR || DEFAULT_ROOT).replace(/\/+$/, "");
}

export function getChatAttachmentStorageDriver(): ChatStorageDriver {
  const raw = String(process.env.CHAT_STORAGE_DRIVER || process.env.CHAT_ATTACHMENT_STORAGE_DRIVER || "local").toLowerCase();
  return raw === "s3" || raw === "r2" || raw === "object" ? "s3" : "local";
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
  "image/heic",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "video/webm",
  "application/msword",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
]);

export function isAllowedChatMime(mime: string): boolean {
  return ALLOWED_MIME.has(String(mime || "").toLowerCase().split(";")[0].trim());
}

function normalizedMime(mime: string): string {
  return String(mime || "application/octet-stream").toLowerCase().split(";")[0].trim();
}

function s3Config() {
  const bucket = process.env.CHAT_S3_BUCKET || process.env.CHAT_R2_BUCKET || "";
  const endpoint = process.env.CHAT_S3_ENDPOINT || process.env.CHAT_R2_ENDPOINT || undefined;
  const region = process.env.CHAT_S3_REGION || process.env.AWS_REGION || "auto";
  const accessKeyId = process.env.CHAT_S3_ACCESS_KEY_ID || process.env.CHAT_R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.CHAT_S3_SECRET_ACCESS_KEY || process.env.CHAT_R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "";
  const forcePathStyle = String(process.env.CHAT_S3_FORCE_PATH_STYLE || "true").toLowerCase() !== "false";
  if (!bucket) throw new Error("chat_s3_bucket_missing");
  if (!accessKeyId || !secretAccessKey) throw new Error("chat_s3_credentials_missing");
  return { bucket, endpoint, region, accessKeyId, secretAccessKey, forcePathStyle };
}

let cachedS3: S3Client | null = null;

function s3Client(): S3Client {
  if (cachedS3) return cachedS3;
  const cfg = s3Config();
  cachedS3 = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return cachedS3;
}

async function putObject(storageKey: string, buffer: Buffer, mimeType: string): Promise<void> {
  if (getChatAttachmentStorageDriver() === "local") {
    const absolutePath = resolveChatStoragePath(storageKey);
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, buffer);
    return;
  }
  const cfg = s3Config();
  await s3Client().send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: storageKey,
    Body: buffer,
    ContentType: mimeType,
    Metadata: { "connect-scope": "chat" },
  }));
}

export async function statChatAttachment(storageKey: string): Promise<StoredObjectInfo | null> {
  if (getChatAttachmentStorageDriver() === "local") {
    let absolutePath: string;
    try {
      absolutePath = resolveChatStoragePath(storageKey);
    } catch {
      throw new Error("INVALID_STORAGE_KEY");
    }
    if (!fs.existsSync(absolutePath)) return null;
    const stat = await fs.promises.stat(absolutePath);
    return { sizeBytes: stat.size };
  }
  try {
    const cfg = s3Config();
    const res = await s3Client().send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: storageKey }));
    return { sizeBytes: Number(res.ContentLength || 0), contentType: res.ContentType || undefined };
  } catch (err: any) {
    const name = String(err?.name || "");
    const code = Number(err?.$metadata?.httpStatusCode || 0);
    if (name === "NotFound" || code === 404) return null;
    throw err;
  }
}

export async function readChatAttachment(storageKey: string): Promise<StoredObjectStream | null> {
  if (getChatAttachmentStorageDriver() === "local") {
    let absolutePath: string;
    try {
      absolutePath = resolveChatStoragePath(storageKey);
    } catch {
      throw new Error("INVALID_STORAGE_KEY");
    }
    if (!fs.existsSync(absolutePath)) return null;
    const stat = await fs.promises.stat(absolutePath);
    return { body: fs.createReadStream(absolutePath), sizeBytes: stat.size };
  }
  try {
    const cfg = s3Config();
    const res = await s3Client().send(new GetObjectCommand({ Bucket: cfg.bucket, Key: storageKey }));
    const body = res.Body instanceof Readable ? res.Body : Readable.fromWeb(res.Body as any);
    return {
      body,
      sizeBytes: Number(res.ContentLength || 0),
      contentType: res.ContentType || undefined,
    };
  } catch (err: any) {
    const name = String(err?.name || "");
    const code = Number(err?.$metadata?.httpStatusCode || 0);
    if (name === "NoSuchKey" || name === "NotFound" || code === 404) return null;
    throw err;
  }
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
  const mimeType = normalizedMime(input.mimeType);
  if (!isAllowedChatMime(mimeType)) throw new Error("mime_not_allowed");
  if (input.buffer.length > input.maxBytes) throw new Error("file_too_large");

  const tenantSeg = sanitizePathSegment(input.tenantKey);
  const threadSeg = sanitizePathSegment(input.threadId);
  if (!tenantSeg || !threadSeg) throw new Error("invalid_tenant_or_thread");

  const ext = path.extname(input.originalFilename || "").toLowerCase().replace(/[^.a-z0-9]/g, "");
  const id = crypto.randomBytes(8).toString("hex");
  const base = `f_${id}${ext || ""}`;
  const storageKey = `${tenantSeg}/${threadSeg}/${base}`;
  await putObject(storageKey, input.buffer, mimeType);

  const sha256 = crypto.createHash("sha256").update(input.buffer).digest("hex");
  const fileName = path.basename(input.originalFilename || base) || base;
  return { storageKey, sha256, sizeBytes: input.buffer.length, mimeType, fileName };
}

export function assertStorageKeyForThread(storageKey: string, tenantId: string, threadId: string): void {
  const tenantSeg = sanitizePathSegment(tenantId);
  const threadSeg = sanitizePathSegment(threadId);
  const prefix = `${tenantSeg}/${threadSeg}/`;
  if (!storageKey.startsWith(prefix)) throw new Error("storage_key_mismatch");
}
