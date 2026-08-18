import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeTenantScope, sanitizeBaseName } from "../promptStorage";
import { isEnvFlagEnabled } from "../envFlag";

const DEFAULT_ROOT = path.resolve(__dirname, "../../data/crm-forms");
const PDF_MIME = "application/pdf";

/** Explicit opt-in for a throwaway, container-local storage root (dev only). */
export const CRM_FORM_ALLOW_EPHEMERAL_VAR = "CRM_FORM_STORAGE_ALLOW_EPHEMERAL";

/**
 * ⛔ `DEFAULT_ROOT` is INSIDE the container image. Anything written there is
 * destroyed by the next api deploy while the database row that points at it
 * survives — the exact data-loss shape as the onboarding-uploads bug
 * (`AGENT_HANDOFF_ONBOARDING_UPLOADS_VOLUME_2026-08-06.md`), where a customer's
 * uploaded phone bill was silently erased and a port order was filed without it.
 * Silent at every step: the write succeeds, the deploy succeeds.
 *
 * The guard against that used to read `!configuredRoot && NODE_ENV ===
 * "production"`, and **the api container sets no NODE_ENV** (proven live
 * 2026-08-18), so it was permanently false — the fallback was reachable in
 * production. See CLAUDE.md → "THE NODE_ENV SWEEP NOBODY DID".
 *
 * ✅ Safe to make it unconditional: verified live 2026-08-18 that
 * `CRM_DOC_STORAGE_DIR=/var/lib/connect/crm-lead-docs` is set inside
 * `app-api-1`, and that BOTH api compose blocks carry it with the
 * `crm-lead-docs` named volume mounted (`docker-compose.app.yml` lines
 * 154/209 for `api` and 327/364 for `api_candidate`) — so blue/green cannot
 * cut over onto a container that lacks it. `configuredRoot` is always truthy
 * in production; this throw cannot fire there.
 *
 * ⛔ Read at CALL time, and only from per-request paths
 * (`resolveCrmFormStoragePath`) — never at module load — so a misconfiguration
 * is a loud 500 on one upload, never a container that will not boot.
 */
export function getCrmFormStorageRoot(): string {
  const configuredRoot = process.env.CRM_FORM_STORAGE_DIR || process.env.CRM_DOC_STORAGE_DIR;
  if (!configuredRoot && !isEnvFlagEnabled(process.env[CRM_FORM_ALLOW_EPHEMERAL_VAR])) {
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
