import { createHash, createHmac } from "node:crypto";
import type { Db } from "../db.js";
import { env } from "../env.js";
import { badRequest } from "../lib/errors.js";
import { storage } from "../lib/storage.js";

/**
 * Media pipeline: MIME sniffed from BYTES (never trusted from the client),
 * images resized into thumb/medium/original variants with metadata stripped,
 * sha256 recorded, private assets served only with a signed URL.
 */
export const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export const DOC_MIMES = new Set(["application/pdf"]);
export const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
export const AUDIO_MIMES = new Set(["audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg", "audio/wav", "audio/x-m4a"]);

export type AssetKind = "image" | "video" | "document" | "audio";

export const MAX_BYTES: Record<AssetKind, number> = { image: 15 * 1024 * 1024, video: 50 * 1024 * 1024, document: 20 * 1024 * 1024, audio: 20 * 1024 * 1024 };

/** Magic-number sniff. Returns null for anything we do not accept. */
export function sniffMime(buf: Buffer, declared?: string): string | null {
  if (buf.length < 12) return null;
  const b = buf;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (b.toString("ascii", 0, 4) === "%PDF") return "application/pdf";
  const ftyp = b.toString("ascii", 4, 8);
  if (ftyp === "ftyp") {
    const brand = b.toString("ascii", 8, 12);
    if (brand.startsWith("qt")) return "video/quicktime";
    if (brand.startsWith("M4A")) return "audio/mp4";
    return "video/mp4";
  }
  if (b.toString("ascii", 0, 4) === "\x1aE\xdf\xa3" || (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)) return declared === "audio/webm" ? "audio/webm" : "video/webm";
  if (b.toString("ascii", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (b.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  return null;
}

export function kindForMime(mime: string): AssetKind | null {
  if (IMAGE_MIMES.has(mime)) return "image";
  if (DOC_MIMES.has(mime)) return "document";
  if (VIDEO_MIMES.has(mime)) return "video";
  if (AUDIO_MIMES.has(mime)) return "audio";
  return null;
}

export type StoredAsset = { id: string; kind: string; mime: string; bytes: number; width: number | null; height: number | null; status: string; isPrivate: boolean; variants: Record<string, string> | null; originalName: string | null };

/**
 * Stores an upload. Images: EXIF stripped (sharp re-encodes), variants
 * thumb (160) / medium (1200) as WebP, original re-encoded in place.
 */
export async function storeUpload(
  db: Db,
  ownerId: string,
  file: { buffer: Buffer; filename?: string; mimetype?: string },
  opts: { isPrivate?: boolean; allow?: AssetKind[] } = {},
): Promise<StoredAsset> {
  const mime = sniffMime(file.buffer, file.mimetype);
  if (!mime) throw badRequest("file_type", "That file type isn't supported. Use JPG, PNG, WebP, GIF, PDF, MP4, MOV, or an audio file.");
  const kind = kindForMime(mime)!;
  if (opts.allow && !opts.allow.includes(kind)) throw badRequest("file_kind", `Only ${opts.allow.join("/")} files are allowed here.`);
  if (file.buffer.length > MAX_BYTES[kind]) throw badRequest("file_too_large", `That ${kind} is too large — the limit is ${Math.round(MAX_BYTES[kind] / 1024 / 1024)} MB.`);
  const sha = createHash("sha256").update(file.buffer).digest("hex");
  const asset = await db.mediaAsset.create({
    data: { ownerId, kind, mime, bytes: file.buffer.length, storageKey: "", status: "PROCESSING", isPrivate: !!opts.isPrivate, sha256: sha, originalName: file.filename?.slice(0, 200) ?? null },
  });
  const base = `${ownerId}/${asset.id}`;
  const variants: Record<string, string> = {};
  let width: number | null = null;
  let height: number | null = null;
  let finalMime = mime;
  let originalKey = `${base}/original`;
  try {
    if (kind === "image" && mime !== "image/gif") {
      const sharp = (await import("sharp")).default;
      const img = sharp(file.buffer, { failOn: "none" }).rotate();
      const meta = await img.metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
      const original = await sharp(file.buffer).rotate().webp({ quality: 90 }).toBuffer();
      const medium = await sharp(file.buffer).rotate().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      const thumb = await sharp(file.buffer).rotate().resize({ width: 320, height: 320, fit: "cover" }).webp({ quality: 78 }).toBuffer();
      finalMime = "image/webp";
      originalKey = `${base}/original.webp`;
      await storage().put(originalKey, original, finalMime);
      await storage().put(`${base}/medium.webp`, medium, finalMime);
      await storage().put(`${base}/thumb.webp`, thumb, finalMime);
      variants.original = originalKey;
      variants.medium = `${base}/medium.webp`;
      variants.thumb = `${base}/thumb.webp`;
    } else {
      await storage().put(originalKey, file.buffer, mime);
      variants.original = originalKey;
      if (kind === "image") {
        variants.medium = originalKey;
        variants.thumb = originalKey;
      }
    }
    const done = await db.mediaAsset.update({
      where: { id: asset.id },
      data: { storageKey: originalKey, mime: finalMime, width, height, variants, status: "READY", scanResult: "clean" },
    });
    return toStored(done);
  } catch (err) {
    await db.mediaAsset.update({ where: { id: asset.id }, data: { status: "REJECTED", scanResult: String((err as Error).message).slice(0, 200) } });
    throw badRequest("file_processing", "We couldn't process that file. Try a different one.");
  }
}

export function toStored(a: { id: string; kind: string; mime: string; bytes: number; width: number | null; height: number | null; status: string; isPrivate: boolean; variants: unknown; originalName: string | null }): StoredAsset {
  return { id: a.id, kind: a.kind, mime: a.mime, bytes: a.bytes, width: a.width, height: a.height, status: a.status, isPrivate: a.isPrivate, variants: (a.variants as Record<string, string>) ?? null, originalName: a.originalName };
}

/** Signed URL for private assets: HMAC of id+variant+expiry with the JWT secret. */
export function signMediaUrl(assetId: string, variant: string, ttlSeconds = 900): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createHmac("sha256", env().COMMUNITY_JWT_SECRET).update(`${assetId}:${variant}:${exp}`).digest("base64url");
  return `${env().COMMUNITY_API_URL}/media/file/${assetId}/${variant}?exp=${exp}&sig=${sig}`;
}

export function verifyMediaSignature(assetId: string, variant: string, exp: string | undefined, sig: string | undefined): boolean {
  if (!exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac("sha256", env().COMMUNITY_JWT_SECRET).update(`${assetId}:${variant}:${exp}`).digest("base64url");
  return expected.length === sig.length && expected === sig;
}
