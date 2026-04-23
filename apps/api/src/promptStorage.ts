/**
 * IVR prompt (system-recording) audio storage.
 *
 * Same pragmatic pattern as `mohStorage.ts`: tenant-scoped local filesystem
 * with HMAC-signed download URLs. Connect stores the audio bytes once per
 * unique VitalPBX recording so the in-browser "Play" button can stream
 * without touching the PBX on the user's click path.
 *
 * Directory layout (flat; prompts are globally unique by fileBaseName):
 *   <PROMPT_STORAGE_DIR>/<sanitisedBaseName><ext>
 *
 * The audio bytes are the authoritative copy for playback; the row's sha256
 * is the cache key used by the PBX-host helper (connect-prompt-sync.sh) to
 * avoid re-uploading unchanged files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const DEFAULT_ROOT = path.resolve(process.cwd(), "data/ivr-prompts");

export function getPromptStorageRoot(): string {
  return (process.env.PROMPT_STORAGE_DIR || DEFAULT_ROOT).replace(/\/+$/, "");
}

/** HMAC secret for signed download URLs. Reuses MOH_URL_SIGNING_SECRET /
 *  CDR_INGEST_SECRET so no new env var is required on day one; production
 *  can set PROMPT_URL_SIGNING_SECRET to isolate blast radius. */
function signingSecret(): string {
  return (
    process.env.PROMPT_URL_SIGNING_SECRET ||
    process.env.MOH_URL_SIGNING_SECRET ||
    process.env.CDR_INGEST_SECRET ||
    "dev-signing-secret"
  ).trim();
}

const ALLOWED_EXTS = new Set([
  ".wav", ".mp3", ".ogg", ".gsm", ".g722", ".g729", ".sln", ".sln16",
  ".ulaw", ".alaw", ".m4a", ".aac",
]);

const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  ".wav":   "audio/wav",
  ".wav49": "audio/wav",
  ".mp3":   "audio/mpeg",
  ".ogg":   "audio/ogg",
  ".opus":  "audio/ogg",
  ".m4a":   "audio/mp4",
  ".aac":   "audio/aac",
  ".gsm":   "audio/x-gsm",
  ".g722":  "audio/G722",
  ".g729":  "audio/G729",
  ".sln":   "audio/basic",
  ".sln16": "audio/basic",
  ".ulaw":  "audio/basic",
  ".alaw":  "audio/basic",
};

export function contentTypeForFilename(filename: string): string {
  const ext = path.extname(filename || "").toLowerCase();
  return EXT_TO_CONTENT_TYPE[ext] ?? "audio/wav";
}

/** Allow only a-z, 0-9, _, - in the sanitised storage basename. */
export function sanitizeBaseName(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/\.(wav|mp3|ogg|gsm|g722|g729|sln\d*|ulaw|alaw|m4a|aac|wav49)$/i, "")
    .replace(/[^a-z0-9_\-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Resolve a storage key to an absolute path, refusing traversal. */
export function resolvePromptStoragePath(storageKey: string): string {
  const clean = String(storageKey || "").replace(/\\/g, "/");
  if (clean.includes("..")) throw new Error("invalid_storage_key");
  const root = getPromptStorageRoot();
  const full = path.resolve(root, clean);
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new Error("invalid_storage_key_scope");
  }
  return full;
}

/** Write audio bytes to disk and return metadata. */
export async function writePromptFile(input: {
  baseName: string;           // e.g. "acme_welcome" or raw "custom/acme_welcome"
  originalFilename: string;   // e.g. "acme_welcome.wav"
  buffer: Buffer;
}): Promise<{ storageKey: string; sha256: string; sizeBytes: number; contentType: string; absolutePath: string }> {
  const base = sanitizeBaseName(input.baseName || input.originalFilename);
  if (!base) throw new Error("invalid_base_name");

  const rawExt = path.extname(input.originalFilename || "").toLowerCase();
  const ext = ALLOWED_EXTS.has(rawExt) ? rawExt : ".wav";
  const storageKey = `${base}${ext}`;
  const absolutePath = resolvePromptStoragePath(storageKey);

  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.promises.writeFile(absolutePath, input.buffer);

  const sha256 = crypto.createHash("sha256").update(input.buffer).digest("hex");
  const contentType = EXT_TO_CONTENT_TYPE[ext] ?? "audio/wav";
  return {
    storageKey,
    sha256,
    sizeBytes: input.buffer.length,
    contentType,
    absolutePath,
  };
}

export async function readPromptFile(storageKey: string): Promise<Buffer> {
  const p = resolvePromptStoragePath(storageKey);
  return fs.promises.readFile(p);
}

export async function deletePromptFile(storageKey: string): Promise<void> {
  const p = resolvePromptStoragePath(storageKey);
  await fs.promises.rm(p, { force: true });
}

/** Build a signed download URL (used by the PBX-host helper if it ever needs
 *  to *pull* from Connect — today we go the other direction, but keeping the
 *  helper symmetric keeps future S3/R2 migrations trivial). */
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
  return `${base}/voice/ivr/prompts/download/${encodeURIComponent(storageKey)}?exp=${exp}&sig=${sig}`;
}

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
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true };
}
