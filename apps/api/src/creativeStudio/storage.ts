/**
 * Creative Studio — object storage.
 *
 * Media never goes in a database row. Bytes live in S3-compatible object
 * storage (the MinIO that already runs beside Postgres on infra_default);
 * CreativeAsset rows carry only the key, the hash and what we know about it.
 *
 * ⛔ Keys are built by US, never by a caller. Every key starts with the
 * tenant id, so a cross-company read is impossible to express, let alone
 * perform. Callers hand us bytes and a name; we hand back a key.
 */
import crypto from "crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

export const CREATIVE_BUCKET = process.env.CREATIVE_S3_BUCKET || "creative";

let client: S3Client | null = null;
let ensured = false;

export function creativeStorageConfigured(): boolean {
  return !!(process.env.CREATIVE_S3_ENDPOINT || process.env.CREATIVE_S3_ACCESS_KEY);
}

export function s3(): S3Client {
  if (client) return client;
  const endpoint = process.env.CREATIVE_S3_ENDPOINT || "http://connectcomms-minio:9000";
  client = new S3Client({
    endpoint,
    region: process.env.CREATIVE_S3_REGION || "us-east-1",
    // MinIO speaks path style; virtual-host style needs DNS per bucket.
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.CREATIVE_S3_ACCESS_KEY || "",
      secretAccessKey: process.env.CREATIVE_S3_SECRET_KEY || "",
    },
  });
  return client;
}

/** Create the bucket once per process if it is not there yet. */
export async function ensureBucket(): Promise<void> {
  if (ensured) return;
  const c = s3();
  try {
    await c.send(new HeadBucketCommand({ Bucket: CREATIVE_BUCKET }));
  } catch {
    try {
      await c.send(new CreateBucketCommand({ Bucket: CREATIVE_BUCKET }));
    } catch (e: any) {
      // Someone else created it between the head and the create: fine.
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/i.test(String(e?.name || e))) throw e;
    }
  }
  ensured = true;
}

const SAFE = /[^a-zA-Z0-9._-]/g;

/** One path segment, with anything surprising replaced. Never empty. */
export function safeSegment(input: string, fallback = "file"): string {
  const trimmed = String(input || "")
    .trim()
    .replace(SAFE, "_")
    // ⛔ A RUN of dots is collapsed, not just a leading one: "../../etc/passwd"
    // becomes "_.._.._etc_passwd" otherwise, and a key that still contains ".."
    // is a key somebody will eventually join onto a filesystem path.
    .replace(/\.{2,}/g, "_")
    .replace(/^[._-]+/, "_")
    .slice(0, 80);
  return trimmed || fallback;
}

/**
 * The only way a storage key is made. Shape:
 *   t/<tenantId>/<kind>/<yyyy-mm>/<assetId>/<name>
 * The tenant id comes first so a prefix listing can never cross companies.
 */
export function buildKey(opts: { tenantId: string; kind: string; assetId: string; name: string; variant?: string }): string {
  const month = new Date().toISOString().slice(0, 7);
  const name = safeSegment(opts.name, "asset");
  const variant = opts.variant ? safeSegment(opts.variant) + "-" : "";
  return `t/${safeSegment(opts.tenantId, "unknown")}/${safeSegment(opts.kind, "misc")}/${month}/${safeSegment(opts.assetId, "id")}/${variant}${name}`;
}

/** True when this key belongs to that tenant. Used before every read. */
export function keyBelongsToTenant(key: string, tenantId: string): boolean {
  if (!key || !tenantId) return false;
  if (key.includes("..")) return false;
  return key.startsWith(`t/${safeSegment(tenantId, "unknown")}/`);
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<{ key: string; bytes: number; sha256: string }> {
  await ensureBucket();
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  await s3().send(new PutObjectCommand({ Bucket: CREATIVE_BUCKET, Key: key, Body: body, ContentType: contentType }));
  return { key, bytes: body.length, sha256 };
}

export async function getObject(key: string): Promise<{ body: Buffer; contentType: string }> {
  await ensureBucket();
  const res = await s3().send(new GetObjectCommand({ Bucket: CREATIVE_BUCKET, Key: key }));
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as any) chunks.push(Buffer.from(chunk));
  return { body: Buffer.concat(chunks), contentType: String(res.ContentType || "application/octet-stream") };
}

/** Streamed read, for serving a video without holding it in memory. */
export async function getObjectStream(key: string): Promise<{ stream: any; contentType: string; bytes?: number }> {
  await ensureBucket();
  const res = await s3().send(new GetObjectCommand({ Bucket: CREATIVE_BUCKET, Key: key }));
  return { stream: res.Body as any, contentType: String(res.ContentType || "application/octet-stream"), bytes: res.ContentLength };
}

export async function deleteObject(key: string): Promise<void> {
  await ensureBucket();
  await s3().send(new DeleteObjectCommand({ Bucket: CREATIVE_BUCKET, Key: key }));
}

/** Bytes a company is holding, for the storage line on the usage screen. */
export async function tenantBytes(tenantId: string): Promise<number> {
  await ensureBucket();
  let total = 0;
  let token: string | undefined;
  do {
    const res: any = await s3().send(
      new ListObjectsV2Command({ Bucket: CREATIVE_BUCKET, Prefix: `t/${safeSegment(tenantId, "unknown")}/`, ContinuationToken: token }),
    );
    for (const o of res.Contents || []) total += Number(o.Size || 0);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return total;
}

/**
 * What a file really is, read from its own bytes rather than its name.
 * An upload that claims to be a PNG and is not is refused.
 */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.slice(0, 4).toString("ascii") === "RIFF" && b.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (b.slice(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (b.slice(4, 8).toString("ascii") === "ftyp") {
    const brand = b.slice(8, 12).toString("ascii");
    if (/^(qt|M4A)/.test(brand)) return "audio/mp4";
    return "video/mp4";
  }
  if (b.slice(0, 4).toString("hex") === "1a45dfa3") return "video/webm";
  if (b.slice(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  if (b.slice(0, 3).toString("ascii") === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (b.slice(0, 4).toString("ascii") === "RIFF" && b.slice(8, 12).toString("ascii") === "WAVE") return "audio/wav";
  if (b.slice(0, 4).toString("ascii") === "%PDF") return "application/pdf";
  if (b.slice(0, 4).toString("hex") === "00010000" || b.slice(0, 4).toString("ascii") === "OTTO" || b.slice(0, 4).toString("ascii") === "wOFF" || b.slice(0, 4).toString("ascii") === "wOF2") return "font/sfnt";
  return null;
}

export const ALLOWED_UPLOAD_MIME = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "video/mp4", "video/webm",
  "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4",
  "font/sfnt", "application/pdf",
]);

export function kindForMime(mime: string): "image" | "video" | "audio" | "font" | "doc" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("font/")) return "font";
  return "doc";
}
