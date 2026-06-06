import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeTenantScope, sanitizeBaseName } from "../promptStorage";

const DEFAULT_ROOT = path.resolve(__dirname, "../../data/crm-forms");
const PDF_MIME = "application/pdf";

export function getCrmFormStorageRoot(): string {
  const configuredRoot = process.env.CRM_FORM_STORAGE_DIR || process.env.CRM_DOC_STORAGE_DIR;
  if (!configuredRoot && process.env.NODE_ENV === "production") {
    throw new Error("crm_form_storage_dir_required");
  }
  return (configuredRoot || DEFAULT_ROOT).replace(/\/+$/, "");
}

export function getCrmFormMaxBytes(): number {
  const raw = process.env.CRM_FORM_UPLOAD_MAX_BYTES || process.env.CRM_DOC_IMPORT_MAX_BYTES;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 25 * 1024 * 1024;
}

export function assertPdfUpload(input: { buffer: Buffer; mimeType?: string | null; fileName: string }) {
  const mime = String(input.mimeType || PDF_MIME).toLowerCase();
  const fileName = String(input.fileName || "").toLowerCase();
  if (mime !== PDF_MIME && !fileName.endsWith(".pdf")) {
    throw Object.assign(new Error("pdf_required"), { code: "pdf_required" });
  }
  if (input.buffer.length > getCrmFormMaxBytes()) {
    throw Object.assign(new Error("file_too_large"), { code: "file_too_large" });
  }
}

export function buildCrmFormTemplateStorageKey(tenantId: string, templateId: string): string {
  return `tenants/${sanitizeTenantScope(tenantId)}/templates/${sanitizeBaseName(templateId).slice(0, 48)}/original.pdf`;
}

export function buildCrmFormCompletedStorageKey(tenantId: string, submissionId: string): string {
  return `tenants/${sanitizeTenantScope(tenantId)}/submissions/${sanitizeBaseName(submissionId).slice(0, 48)}/completed.pdf`;
}

export function resolveCrmFormStoragePath(storageKey: string): string {
  const clean = String(storageKey || "").replace(/\\/g, "/");
  if (!clean || clean.includes("..")) throw new Error("invalid_storage_key");
  const root = getCrmFormStorageRoot();
  const full = path.resolve(root, clean);
  if (!full.startsWith(root + path.sep) && full !== root) throw new Error("invalid_storage_key_scope");
  return full;
}

export async function writeCrmFormFile(storageKey: string, buffer: Buffer): Promise<{ contentHash: string; sizeBytes: number }> {
  const fullPath = resolveCrmFormStoragePath(storageKey);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, buffer);
  return { contentHash: crypto.createHash("sha256").update(buffer).digest("hex"), sizeBytes: buffer.length };
}

export async function readCrmFormFile(storageKey: string): Promise<Buffer> {
  return fs.promises.readFile(resolveCrmFormStoragePath(storageKey));
}

export function extractBasicPdfMetadata(buffer: Buffer): { pageCount: number | null; pdfMetadata: Record<string, unknown> } {
  const sample = buffer.subarray(0, Math.min(buffer.length, 2_000_000)).toString("latin1");
  const pageMatches = sample.match(/\/Type\s*\/Page\b/g);
  const acroFormDetected = /\/AcroForm\b/.test(sample);
  const fieldMarkerCount = (sample.match(/\/T\s*\(/g) || []).length;
  return {
    pageCount: pageMatches?.length || null,
    pdfMetadata: {
      acroFormDetected,
      fieldMarkerCount,
      detection: acroFormDetected ? "acroform_marker_detected" : "manual_fields_required",
    },
  };
}
