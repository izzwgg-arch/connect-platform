/**
 * CRM Lead Document Storage — Phase 3
 *
 * Tenant-scoped local filesystem storage for imported Drive documents.
 * Mirrors the pattern established by crmVoicemailDropStorage.ts and promptStorage.ts.
 *
 * Directory layout:
 *   <CRM_DOC_STORAGE_DIR>/tenants/<tenantId>/<docId>/file<ext>
 *
 * Security rules:
 * - Storage keys are validated against path traversal (no ".." segments).
 * - Keys are scoped to the configured root so no file outside the root is readable.
 * - Access URLs are HMAC-signed with an expiry — raw storage keys are NEVER exposed.
 * - File contents are NEVER logged.
 * - Max file size is enforced by CRM_DOC_IMPORT_MAX_BYTES (default 50 MB).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeTenantScope, sanitizeBaseName } from "../promptStorage";

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_ROOT = path.resolve(process.cwd(), "data/crm-lead-docs");

/** Root directory for all tenant CRM lead document files. */
export function getCrmDocStorageRoot(): string {
  return (process.env.CRM_DOC_STORAGE_DIR || DEFAULT_ROOT).replace(/\/+$/, "");
}

/** Maximum import file size in bytes. Default 50 MB. */
export function getCrmDocMaxBytes(): number {
  const raw = process.env.CRM_DOC_IMPORT_MAX_BYTES;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 50 * 1024 * 1024;
}

function signingSecret(): string {
  return (
    process.env.CRM_DOC_URL_SIGNING_SECRET ||
    process.env.PROMPT_URL_SIGNING_SECRET ||
    process.env.MOH_URL_SIGNING_SECRET ||
    process.env.CDR_INGEST_SECRET ||
    "dev-signing-secret"
  ).trim();
}

// ── MIME → extension ──────────────────────────────────────────────────────────

/** Known MIME types that Google Workspace files are exported to (PDF). */
const WORKSPACE_EXPORT_MIME = "application/pdf";

/** Known document MIME types and safe extensions for storage. */
const MIME_TO_EXT: Record<string, string> = {
  "application/pdf":                                                          ".pdf",
  "application/msword":                                                       ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":  ".docx",
  "application/vnd.ms-excel":                                                 ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":        ".xlsx",
  "application/vnd.ms-powerpoint":                                            ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":".pptx",
  "text/plain":                                                               ".txt",
  "text/csv":                                                                 ".csv",
  "image/jpeg":                                                               ".jpg",
  "image/png":                                                                ".png",
  "image/gif":                                                                ".gif",
  "image/webp":                                                               ".webp",
  "image/tiff":                                                               ".tiff",
};

/** Google Workspace MIME types that can be exported to PDF. */
export const GOOGLE_WORKSPACE_EXPORTABLE: Record<string, string> = {
  "application/vnd.google-apps.document":     "application/pdf",
  "application/vnd.google-apps.spreadsheet":  "application/pdf",
  "application/vnd.google-apps.presentation": "application/pdf",
  "application/vnd.google-apps.drawing":      "application/pdf",
};

/** Returns true if the MIME type is a Google Workspace file that must be exported. */
export function isGoogleWorkspaceMime(mimeType: string): boolean {
  return mimeType in GOOGLE_WORKSPACE_EXPORTABLE;
}

/** Returns the export MIME type for a given Workspace MIME, or null if unsupported. */
export function getWorkspaceExportMime(mimeType: string): string | null {
  return GOOGLE_WORKSPACE_EXPORTABLE[mimeType] ?? null;
}

/**
 * Returns a safe file extension for the given MIME type.
 * Falls back to the extension in the original filename, then ".bin".
 */
export function safeExtForMime(mimeType: string, originalName?: string): string {
  if (mimeType === WORKSPACE_EXPORT_MIME) return ".pdf";
  const fromMime = MIME_TO_EXT[mimeType];
  if (fromMime) return fromMime;
  if (originalName) {
    const ext = path.extname(originalName).toLowerCase();
    if (ext && /^\.[a-z0-9]{1,10}$/.test(ext)) return ext;
  }
  return ".bin";
}

// ── Storage key construction ──────────────────────────────────────────────────

/**
 * Builds the storage key for a document.
 * Format: tenants/<tenantId>/<docId>/file<ext>
 */
export function buildDocStorageKey(
  tenantId: string,
  docId: string,
  mimeType: string,
  originalName: string,
): string {
  const tenantScope = sanitizeTenantScope(tenantId);
  const docScope = sanitizeBaseName(docId).slice(0, 48);
  const ext = safeExtForMime(mimeType, originalName);
  return `tenants/${tenantScope}/${docScope}/file${ext}`;
}

// ── Path resolution ───────────────────────────────────────────────────────────

/**
 * Resolves a storage key to an absolute filesystem path.
 * Throws if the key attempts to escape the storage root (path traversal guard).
 */
export function resolveCrmDocStoragePath(storageKey: string): string {
  const clean = String(storageKey || "").replace(/\\/g, "/");
  if (!clean || clean.includes("..")) throw new Error("invalid_storage_key");
  const root = getCrmDocStorageRoot();
  const full = path.resolve(root, clean);
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new Error("invalid_storage_key_scope");
  }
  return full;
}

// ── Write / Read ──────────────────────────────────────────────────────────────

/**
 * Writes a document buffer to the tenant-scoped storage path.
 * Returns the storage key, SHA-256 hash, and byte count.
 */
export async function writeCrmDocFile(input: {
  tenantId: string;
  docId: string;
  buffer: Buffer;
  mimeType: string;
  originalFileName: string;
}): Promise<{ storageKey: string; contentHash: string; storedBytes: number }> {
  const storageKey = buildDocStorageKey(
    input.tenantId,
    input.docId,
    input.mimeType,
    input.originalFileName,
  );
  const fullPath = resolveCrmDocStoragePath(storageKey);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, input.buffer);
  const contentHash = crypto.createHash("sha256").update(input.buffer).digest("hex");
  return { storageKey, contentHash, storedBytes: input.buffer.length };
}

/**
 * Reads a document from storage. Throws "invalid_storage_key" if path escapes root.
 */
export async function readCrmDocFile(storageKey: string): Promise<Buffer> {
  return fs.promises.readFile(resolveCrmDocStoragePath(storageKey));
}

// ── Signed URL ────────────────────────────────────────────────────────────────
//
// v2 HMAC binding (Phase 3 harden):
//   message = "crm-doc-open:v2:" + docId + ":" + tenantId + ":" + userId + ":" + exp
//
// Security properties:
//   - purpose-bound: "crm-doc-open:v2" prefix prevents reuse across other signing contexts
//   - docId-bound: signature cannot be reused for a different document
//   - tenantId-bound: signature cannot be used by a different tenant
//   - userId-bound: signature cannot be used by a different user
//   - expiry-bound: short-lived (default 10 min)
//
// Old v1 signatures (format: "crm-doc:{docId}:{storageKey}:{exp}") automatically
// fail because the HMAC message format is different. No migration needed.
// storageKey is NOT embedded in the URL or the HMAC (never expose storage paths).

/**
 * Builds a short-lived HMAC-signed URL for the document open route.
 * The signature binds docId + tenantId + userId + expiry.
 *
 * @param publicBaseUrl  API base URL (e.g. https://api.example.com)
 * @param docId          CrmLeadDocument.id
 * @param tenantId       Owning tenant — bound into the signature
 * @param userId         Requesting user — bound into the signature
 * @param expiresInSec   Seconds until expiry (default 600 / 10 min)
 */
export function buildSignedCrmDocUrl(
  publicBaseUrl: string,
  docId: string,
  tenantId: string,
  userId: string,
  expiresInSec = 600,
): string {
  const exp = Math.floor(Date.now() / 1000) + Math.max(10, expiresInSec);
  const message = `crm-doc-open:v2:${docId}:${tenantId}:${userId}:${exp}`;
  const sig = crypto
    .createHmac("sha256", signingSecret())
    .update(message)
    .digest("hex");
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/crm/documents/${encodeURIComponent(docId)}/open?exp=${exp}&sig=${sig}`;
}

/**
 * Verifies a signed doc URL against the expected tenantId and userId.
 *
 * Returns { ok: true } on success, or { ok: false, reason } on failure.
 * reason values:
 *   "expired"  — link has passed its expiry timestamp
 *   "invalid"  — signature is wrong (wrong secret, tampered params, or wrong tenant/user)
 */
export function verifySignedCrmDocUrl(
  docId: string,
  tenantId: string,
  userId: string,
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
  const message = `crm-doc-open:v2:${docId}:${tenantId}:${userId}:${exp}`;
  const expected = crypto
    .createHmac("sha256", signingSecret())
    .update(message)
    .digest("hex");
  const a = Buffer.from(sigRaw, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true };
}

/**
 * Returns the Content-Type header value for a stored document.
 * Uses importedMimeType (the actual stored MIME) if available, else original.
 */
export function contentTypeForCrmDoc(
  importedMimeType: string | null | undefined,
  originalMimeType: string | null | undefined,
  storageKey: string,
): string {
  if (importedMimeType) return importedMimeType;
  if (originalMimeType) return originalMimeType;
  const ext = path.extname(storageKey).toLowerCase();
  return MIME_TO_EXT[ext] ?? "application/octet-stream";
}
