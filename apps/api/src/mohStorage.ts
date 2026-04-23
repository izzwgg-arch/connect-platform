/**
 * MOH asset storage — pragmatic local-filesystem implementation.
 *
 * Why not S3 right away?
 *   • The monorepo has no S3 SDK today; adding one is a non-trivial extra
 *     dependency + config surface.
 *   • The PBX-host pull helper only needs an HTTPS URL to download from; it
 *     does not care whether the backend is S3 or disk.
 *   • Keeping a narrow interface (read/write/hash/signed-url/verify) means
 *     swapping to S3/R2 later is a single-file change — no call-site work.
 *
 * Directory layout:
 *   <MOH_STORAGE_DIR>/<tenantSlug>/<mohClassName>/<filename>
 *
 * The default storage dir is `./data/moh-assets` relative to the API process
 * cwd so local dev works out of the box; production deployments should set
 * MOH_STORAGE_DIR to a volume shared (or at least accessible via HTTPS) by
 * the API pod.
 *
 * Signed download URLs are HMAC-SHA256 tokens bound to the storage key and an
 * expiry timestamp. Signatures are verified in a constant-time compare and
 * expiry is enforced server-side — the PBX-host helper cannot re-use or
 * forward an expired URL. Token format:
 *
 *   ?exp=<unix_seconds>&sig=<hex_hmac(storageKey + ":" + exp)>
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const DEFAULT_ROOT = path.resolve(process.cwd(), "data/moh-assets");

export function getMohStorageRoot(): string {
  return (process.env.MOH_STORAGE_DIR || DEFAULT_ROOT).replace(/\/+$/, "");
}

/** HMAC secret for signed download URLs. Falls back to CDR_INGEST_SECRET so
 *  deployments don't need a new env var on day one; production should set a
 *  distinct MOH_URL_SIGNING_SECRET to isolate blast radius. */
function signingSecret(): string {
  return (process.env.MOH_URL_SIGNING_SECRET || process.env.CDR_INGEST_SECRET || "dev-signing-secret").trim();
}

/** Allow only a-z, 0-9, _, - in slug-like path segments. */
export function sanitizePathSegment(raw: string): string {
  return String(raw || "").toLowerCase().replace(/[^a-z0-9_\-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Deterministic MOH class name from tenant slug + user-provided name.
 *  Prefixed with "connect_" to visually distinguish from hand-created VitalPBX
 *  MOH classes and guarantee no collision with PBX defaults. */
export function buildMohClassName(tenantSlug: string, humanName: string): string {
  const slug = sanitizePathSegment(tenantSlug);
  const nameSlug = sanitizePathSegment(humanName);
  if (!slug || !nameSlug) throw new Error("mohClassName_requires_tenant_and_name");
  return `connect_${slug}_${nameSlug}`;
}

/** Full absolute filesystem path for a storage key. Storage keys are the
 *  relative path under the storage root (e.g. "acme/connect_acme_jazz/holiday.mp3").
 *  We refuse any key containing ".." to prevent traversal. */
export function resolveStoragePath(storageKey: string): string {
  const clean = String(storageKey || "").replace(/\\/g, "/");
  if (clean.includes("..")) throw new Error("invalid_storage_key");
  const root = getMohStorageRoot();
  const full = path.resolve(root, clean);
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new Error("invalid_storage_key_scope");
  }
  return full;
}

/** Write an upload buffer to disk under the tenant/class folder and return the
 *  storageKey + sha256 hash + size. ffprobe validation is intentionally
 *  optional — we don't require it to be installed; when it's missing we still
 *  accept the file (the PBX-side moh reload is the authoritative "does this
 *  actually play?" check). */
export async function writeMohFile(input: {
  tenantSlug: string;
  mohClassName: string;
  originalFilename: string;
  buffer: Buffer;
}): Promise<{ storageKey: string; sha256: string; sizeBytes: number; absolutePath: string }> {
  const tenantSeg = sanitizePathSegment(input.tenantSlug);
  const classSeg = sanitizePathSegment(input.mohClassName);
  if (!tenantSeg || !classSeg) throw new Error("invalid_tenant_or_class");

  const ext = path.extname(input.originalFilename || "").toLowerCase().replace(/[^.a-z0-9]/g, "");
  const baseName = `asset${ext || ""}`;
  const storageKey = `${tenantSeg}/${classSeg}/${baseName}`;
  const absolutePath = resolveStoragePath(storageKey);
  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.promises.writeFile(absolutePath, input.buffer);

  const sha256 = crypto.createHash("sha256").update(input.buffer).digest("hex");
  return { storageKey, sha256, sizeBytes: input.buffer.length, absolutePath };
}

export async function deleteMohFile(storageKey: string): Promise<void> {
  const p = resolveStoragePath(storageKey);
  await fs.promises.rm(p, { force: true });
}

/** Build a signed download URL the PBX-host helper can use. expiresInSec
 *  defaults to 10 minutes; manifest endpoint typically uses 30 minutes so
 *  the helper has time to run even on a flaky connection. */
export function buildSignedDownloadUrl(
  publicBaseUrl: string,
  storageKey: string,
  expiresInSec: number = 600,
): string {
  const exp = Math.floor(Date.now() / 1000) + Math.max(10, expiresInSec);
  const sig = crypto
    .createHmac("sha256", signingSecret())
    .update(`${storageKey}:${exp}`)
    .digest("hex");
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/voice/moh/download/${encodeURIComponent(storageKey)}?exp=${exp}&sig=${sig}`;
}

/** Constant-time signature verification + expiry check. */
export function verifySignedDownload(
  storageKey: string,
  expRaw: string | undefined,
  sigRaw: string | undefined,
): { ok: true } | { ok: false; reason: "expired" | "invalid" } {
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  if (typeof sigRaw !== "string" || sigRaw.length !== 64) {
    return { ok: false, reason: "invalid" };
  }
  const expected = crypto
    .createHmac("sha256", signingSecret())
    .update(`${storageKey}:${exp}`)
    .digest("hex");
  const a = Buffer.from(sigRaw, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "invalid" };
  return { ok: true };
}
