/**
 * CRM Lead Document Import Service — Phase 3
 *
 * Downloads confirmed Google Drive documents into tenant-scoped local storage.
 * Computes SHA-256 hash for dedup proof. Updates CrmLeadDocument status.
 *
 * Status lifecycle:
 *   IMPORT_PENDING → (start import) → IMPORTING → (success) → IMPORTED
 *                                                → (failure) → IMPORT_FAILED
 *
 * Rules:
 * - Tenant ownership is verified before every import.
 * - File content is NEVER logged.
 * - Drive tokens are NEVER logged.
 * - Google Workspace files (Docs/Sheets/Slides) are exported to PDF.
 * - Files exceeding CRM_DOC_IMPORT_MAX_BYTES are rejected with IMPORT_FAILED.
 * - Calling import on an already-IMPORTED doc is idempotent (skips re-download).
 * - Calling import on a non-IMPORT_PENDING doc (other than IMPORTED) is rejected.
 *
 * No OCR. No AI summaries. No phone extraction.
 */

import { db } from "@connect/db";
import {
  downloadDriveFile,
  exportDriveWorkspaceFile,
  DriveServiceError,
} from "./driveService";
import {
  writeCrmDocFile,
  getCrmDocMaxBytes,
  isGoogleWorkspaceMime,
  getWorkspaceExportMime,
} from "./docImportStorage";

// ── Error type ────────────────────────────────────────────────────────────────

export class DocImportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DocImportError";
  }
}

// ── Result type ───────────────────────────────────────────────────────────────

export interface DocImportResult {
  docId: string;
  status: "IMPORTED" | "IMPORT_FAILED" | "skipped";
  /** Populated when status = IMPORTED */
  storageKey?: string;
  contentHash?: string;
  storedBytes?: number;
  importedMimeType?: string;
  /** Populated when status = IMPORT_FAILED */
  errorCode?: string;
  errorMessage?: string;
}

export interface BatchImportResult {
  batchId: string;
  attempted: number;
  imported: number;
  failed: number;
  skipped: number;
  results: DocImportResult[];
}

// ── Single document import ────────────────────────────────────────────────────

/**
 * Imports a single CrmLeadDocument from Google Drive into local storage.
 *
 * @param docId     The CrmLeadDocument.id to import.
 * @param tenantId  Must match doc.tenantId — enforces tenant isolation.
 * @param force     If true, re-import even if already IMPORTED (re-downloads).
 */
export async function importSingleDocument(
  docId: string,
  tenantId: string,
  force = false,
): Promise<DocImportResult> {
  // 1. Load and verify the document belongs to this tenant
  const doc = await db.crmLeadDocument.findFirst({
    where: { id: docId, tenantId },
    select: {
      id: true,
      tenantId: true,
      status: true,
      googleDriveFileId: true,
      originalFileName: true,
      mimeType: true,
      importBatchId: true,
      storageKey: true,
    },
  });

  if (!doc) {
    throw new DocImportError("doc_not_found", "Document not found for this tenant.");
  }

  if (!doc.googleDriveFileId) {
    throw new DocImportError(
      "no_drive_file_id",
      "Document has no Google Drive file ID — cannot import.",
    );
  }

  // 2. Idempotency: skip re-import unless forced
  if (doc.status === "IMPORTED" && !force) {
    return {
      docId,
      status: "skipped",
      storageKey: doc.storageKey ?? undefined,
    };
  }

  // 3. Only import IMPORT_PENDING (or IMPORTED when forced / IMPORT_FAILED for retry)
  const importableStatuses = ["IMPORT_PENDING", "IMPORT_FAILED", "IMPORTED"];
  if (!importableStatuses.includes(doc.status) && !force) {
    throw new DocImportError(
      "invalid_status",
      `Document status '${doc.status}' cannot be imported. Expected IMPORT_PENDING.`,
    );
  }

  // 4. Load Drive folder config for the tenant → get the Google connection
  //    CrmLeadDocument.importBatchId → CrmImportBatch → tenant → CrmDriveFolder
  //    (The tenant is the authority on which connection to use)
  const folderConfig = await db.crmDriveFolder.findFirst({
    where: { tenantId, purpose: "LEAD_IMPORT_INBOX" },
    include: { googleConnection: true },
  });

  if (!folderConfig) {
    throw new DocImportError(
      "no_drive_folder",
      "No Drive folder configured for this tenant. Re-connect Google Drive first.",
    );
  }

  // 5. Mark as IMPORTING — prevents concurrent duplicate imports
  await db.crmLeadDocument.update({
    where: { id: docId },
    data: { status: "IMPORTING", importError: null },
  });

  const maxBytes = getCrmDocMaxBytes();
  const connection = folderConfig.googleConnection as any;

  try {
    // 6. Download (native file) or export (Google Workspace → PDF)
    const mimeType = doc.mimeType || "application/octet-stream";
    let buffer: Buffer;
    let importedMimeType: string;

    if (isGoogleWorkspaceMime(mimeType)) {
      const exportMime = getWorkspaceExportMime(mimeType);
      if (!exportMime) {
        throw new DocImportError(
          "unsupported_workspace_type",
          `Google Workspace type '${mimeType}' cannot be exported to a supported format.`,
        );
      }
      const result = await exportDriveWorkspaceFile(
        connection,
        doc.googleDriveFileId,
        exportMime,
        maxBytes,
      );
      buffer = result.buffer;
      importedMimeType = result.mimeType;
    } else {
      const result = await downloadDriveFile(connection, doc.googleDriveFileId, maxBytes);
      buffer = result.buffer;
      importedMimeType = result.mimeType;
    }

    // 7. Store file to disk
    const { storageKey, contentHash, storedBytes } = await writeCrmDocFile({
      tenantId,
      docId,
      buffer,
      mimeType: importedMimeType,
      originalFileName: doc.originalFileName,
    });

    // 8. Mark as IMPORTED
    await db.crmLeadDocument.update({
      where: { id: docId },
      data: {
        status: "IMPORTED",
        storageKey,
        contentHash,
        sizeBytes: BigInt(storedBytes),
        importedMimeType,
        importedAt: new Date(),
        importError: null,
      },
    });

    return { docId, status: "IMPORTED", storageKey, contentHash, storedBytes, importedMimeType };
  } catch (err: any) {
    // 9. Mark as IMPORT_FAILED with safe error message (never log content/tokens)
    const errorCode =
      err instanceof DriveServiceError ? err.code
      : err instanceof DocImportError  ? err.code
      : "import_error";
    const safeMessage = err?.message
      ? String(err.message).slice(0, 500)
      : "Unknown import error";

    await db.crmLeadDocument.update({
      where: { id: docId },
      data: {
        status: "IMPORT_FAILED",
        importError: safeMessage,
        storageKey: null,
      },
    }).catch(() => undefined); // best-effort status update

    return { docId, status: "IMPORT_FAILED", errorCode, errorMessage: safeMessage };
  }
}

// ── Batch document import ────────────────────────────────────────────────────

/**
 * Imports all IMPORT_PENDING documents for a given import batch.
 * Processes in serial — one at a time — to avoid overwhelming Drive API.
 * Controlled chunk limit: max 20 documents per call.
 *
 * NOTE: No background job queue exists yet. This is a synchronous call with a
 * hard limit. For very large batches, call repeatedly until `attempted === 0`
 * or count remaining IMPORT_PENDING docs. A future worker will replace this.
 */
export async function importBatchDocuments(
  batchId: string,
  tenantId: string,
  limit = 20,
): Promise<BatchImportResult> {
  // Verify batch belongs to tenant
  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true },
  });
  if (!batch) {
    throw new DocImportError("batch_not_found", "Import batch not found for this tenant.");
  }

  // Find IMPORT_PENDING docs for this batch
  const pendingDocs = await db.crmLeadDocument.findMany({
    where: {
      tenantId,
      importBatchId: batchId,
      status: "IMPORT_PENDING",
      googleDriveFileId: { not: null },
    },
    select: { id: true },
    take: Math.min(limit, 20),
  });

  const results: DocImportResult[] = [];
  let imported = 0;
  let failed = 0;
  let skipped = 0;

  for (const { id } of pendingDocs) {
    try {
      const result = await importSingleDocument(id, tenantId);
      results.push(result);
      if (result.status === "IMPORTED") imported++;
      else if (result.status === "IMPORT_FAILED") failed++;
      else skipped++;
    } catch (err: any) {
      // Unexpected throw — doc not found / invalid status (shouldn't happen)
      failed++;
      results.push({
        docId: id,
        status: "IMPORT_FAILED",
        errorCode: "unexpected_error",
        errorMessage: err?.message ? String(err.message).slice(0, 200) : "Unexpected error",
      });
    }
  }

  return {
    batchId,
    attempted: pendingDocs.length,
    imported,
    failed,
    skipped,
    results,
  };
}

// ── Batch document status summary ─────────────────────────────────────────────

/** Returns counts of documents by status for a given import batch. */
export async function getBatchDocumentImportStatus(
  batchId: string,
  tenantId: string,
): Promise<{
  batchId: string;
  discovered: number;
  importPending: number;
  importing: number;
  imported: number;
  importFailed: number;
  rejected: number;
  total: number;
}> {
  // Verify batch belongs to tenant
  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true },
  });
  if (!batch) {
    throw new DocImportError("batch_not_found", "Import batch not found for this tenant.");
  }

  const groups = await db.crmLeadDocument.groupBy({
    by: ["status"],
    where: { tenantId, importBatchId: batchId },
    _count: { status: true },
  });

  const counts: Record<string, number> = {};
  for (const g of groups) {
    counts[g.status] = g._count.status;
  }

  return {
    batchId,
    discovered:    counts["DISCOVERED"]    ?? 0,
    importPending: counts["IMPORT_PENDING"] ?? 0,
    importing:     counts["IMPORTING"]      ?? 0,
    imported:      counts["IMPORTED"]       ?? 0,
    importFailed:  counts["IMPORT_FAILED"]  ?? 0,
    rejected:      counts["REJECTED"]       ?? 0,
    total: Object.values(counts).reduce((s, n) => s + n, 0),
  };
}
