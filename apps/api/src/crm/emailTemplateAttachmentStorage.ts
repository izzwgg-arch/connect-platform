import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeBaseName, sanitizeTenantScope } from "../promptStorage";

const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;

export const CRM_EMAIL_ALLOWED_ATTACHMENT_MIME: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/csv": ".csv",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export const CRM_EMAIL_ALLOWED_LOGO_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export function getCrmEmailAssetStorageRoot(): string {
  const root =
    process.env.CRM_EMAIL_ASSET_STORAGE_DIR ||
    (process.env.CRM_DOC_STORAGE_DIR
      ? path.join(process.env.CRM_DOC_STORAGE_DIR, "email-assets")
      : path.resolve(process.cwd(), "data/crm-email-assets"));
  return root.replace(/\/+$/, "");
}

export function getCrmEmailAttachmentMaxBytes(): number {
  const raw = process.env.CRM_EMAIL_ATTACHMENT_MAX_BYTES;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

export function normalizeCrmEmailMime(mimeType: string | undefined | null): string {
  return String(mimeType || "application/octet-stream").split(";")[0].trim().toLowerCase();
}

function extFromName(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

export function safeCrmEmailExt(mimeType: string, originalName: string, logo = false): string {
  const allow = logo ? CRM_EMAIL_ALLOWED_LOGO_MIME : CRM_EMAIL_ALLOWED_ATTACHMENT_MIME;
  return allow[mimeType] || extFromName(originalName) || ".bin";
}

export function assertCrmEmailFileAllowed(input: {
  mimeType: string;
  originalFileName: string;
  sizeBytes: number;
  logo?: boolean;
}) {
  const mimeType = normalizeCrmEmailMime(input.mimeType);
  const allow = input.logo ? CRM_EMAIL_ALLOWED_LOGO_MIME : CRM_EMAIL_ALLOWED_ATTACHMENT_MIME;
  if (!allow[mimeType]) throw new Error("unsupported_file_type");
  const maxBytes = input.logo ? 2 * 1024 * 1024 : getCrmEmailAttachmentMaxBytes();
  if (input.sizeBytes <= 0) throw new Error("empty_file");
  if (input.sizeBytes > maxBytes) throw new Error("file_too_large");
}

export function buildCrmEmailAssetStorageKey(input: {
  tenantId: string;
  ownerId: string;
  fileId: string;
  mimeType: string;
  originalFileName: string;
  logo?: boolean;
}): string {
  const tenantScope = sanitizeTenantScope(input.tenantId);
  const ownerScope = sanitizeBaseName(input.ownerId).slice(0, 64);
  const fileScope = sanitizeBaseName(input.fileId).slice(0, 64);
  const kind = input.logo ? "branding" : "templates";
  const ext = safeCrmEmailExt(normalizeCrmEmailMime(input.mimeType), input.originalFileName, input.logo);
  return `tenants/${tenantScope}/${kind}/${ownerScope}/${fileScope}${ext}`;
}

export function resolveCrmEmailAssetStoragePath(storageKey: string): string {
  const clean = String(storageKey || "").replace(/\\/g, "/");
  if (!clean || clean.includes("..")) throw new Error("invalid_storage_key");
  const root = getCrmEmailAssetStorageRoot();
  const full = path.resolve(root, clean);
  if (!full.startsWith(root + path.sep) && full !== root) throw new Error("invalid_storage_key_scope");
  return full;
}

export async function writeCrmEmailAssetFile(input: {
  tenantId: string;
  ownerId: string;
  fileId: string;
  buffer: Buffer;
  mimeType: string;
  originalFileName: string;
  logo?: boolean;
}): Promise<{ storageKey: string; contentHash: string; storedBytes: number }> {
  const mimeType = normalizeCrmEmailMime(input.mimeType);
  assertCrmEmailFileAllowed({
    mimeType,
    originalFileName: input.originalFileName,
    sizeBytes: input.buffer.length,
    logo: input.logo,
  });
  const storageKey = buildCrmEmailAssetStorageKey({ ...input, mimeType });
  const fullPath = resolveCrmEmailAssetStoragePath(storageKey);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, input.buffer);
  const contentHash = crypto.createHash("sha256").update(input.buffer).digest("hex");
  return { storageKey, contentHash, storedBytes: input.buffer.length };
}

export async function readCrmEmailAssetFile(storageKey: string): Promise<Buffer> {
  return fs.promises.readFile(resolveCrmEmailAssetStoragePath(storageKey));
}
