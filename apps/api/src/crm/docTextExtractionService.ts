/**
 * CRM Document Text Extraction Service — Phase 5 / 5B (OCR hardening)
 *
 * Extracts text from locally-imported CRM documents. Supports:
 *   - PDFs with an embedded text layer (pdf-parse)          → provider: pdf_text_layer
 *   - Plain text files (.txt, .csv, text/plain MIME)        → provider: plain_text
 *   - DOCX files (mammoth)                                  → provider: docx_text
 *   - PNG / JPG / JPEG / TIFF images (Tesseract.js WASM)   → provider: tesseract_js
 *     (requires CRM_OCR_ENABLED=true)
 *
 * Scanned PDFs — explicitly unsupported:
 *   Rasterizing PDF pages to images safely in Node.js requires native binaries
 *   (Ghostscript / Poppler) which are fragile in Docker. Scanned PDFs fail with
 *   scanned_pdf_ocr_provider_not_configured. See KNOWN_ISSUES.md.
 *
 * OCR configuration (env vars):
 *   CRM_OCR_ENABLED          — "true" to enable image OCR. Default: false.
 *   CRM_OCR_MAX_FILE_BYTES   — Max image file size for OCR. Default: 10 MB.
 *   CRM_OCR_PROVIDER         — Provider name. Default: "tesseract_js".
 *   CRM_OCR_LANG             — Tesseract language. Default: "eng".
 *   CRM_OCR_LANG_PATH        — Path to pre-downloaded .traineddata files
 *                              (required in air-gapped environments).
 *
 * Security:
 *   - Tenant ownership is verified before every read.
 *   - Extracted text is NEVER logged.
 *   - Storage keys are NEVER returned to callers.
 *   - Errors are truncated to 500 chars before persistence.
 *   - OCR file size limit enforced before processing.
 *
 * Idempotency:
 *   - If status is TEXT_COMPLETE, returns { status: "skipped" } unless force=true.
 *   - TEXT_FAILED can always be retried (force not required).
 *   - The CrmLeadDocumentText row is upserted (not duplicated) on every run.
 */

import { db } from "@connect/db";
import { readCrmDocFile } from "./docImportStorage";
import {
  loadOcrConfig,
  getOcrProvider,
  assertOcrSizeLimit,
  OcrLimitError,
  resolveImageMime,
} from "./docOcrProvider";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string; numpages: number }>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth") as { extractRawText(input: { buffer: Buffer }): Promise<{ value: string }> };

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max chars to store in CrmLeadDocumentText.text (prevents unbounded rows). */
const MAX_STORED_CHARS = 500_000;

/** Max length for a safe error message stored in extractionError. */
const MAX_ERROR_MSG_CHARS = 500;

/** Plain-text MIME types that can be read directly without a library. */
const PLAIN_TEXT_MIMES = new Set([
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "application/csv",
]);

// ── Errors ────────────────────────────────────────────────────────────────────

export class DocTextExtractionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DocTextExtractionError";
    this.code = code;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ExtractionResult =
  | { status: "skipped"; reason: string }
  | {
      status: "complete";
      provider: string;
      charCount: number;
      pageCount: number | null;
      confidence?: number;
      ocrEngine?: string;
    }
  | { status: "failed"; provider: string; error: string };

export type BatchExtractionSummary = {
  attempted: number;
  complete: number;
  failed: number;
  skipped: number;
};

// ── Provider detection ────────────────────────────────────────────────────────

type BaseProvider = "pdf_text_layer" | "plain_text" | "docx_text" | "ocr_image" | "unsupported";

/**
 * Determines the extraction provider based on stored MIME type.
 * Returns "ocr_image" for image types (PNG/JPG/JPEG/TIFF).
 */
export function detectExtractionProvider(
  importedMimeType: string | null | undefined,
  originalMimeType: string | null | undefined,
  originalFileName: string,
): BaseProvider {
  const mime = (importedMimeType || originalMimeType || "").toLowerCase();
  const ext = originalFileName.split(".").pop()?.toLowerCase() ?? "";

  if (mime === "application/pdf" || ext === "pdf") return "pdf_text_layer";

  if (PLAIN_TEXT_MIMES.has(mime) || ext === "txt" || ext === "csv") return "plain_text";

  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  )
    return "docx_text";

  // Image types — handled by OCR provider when enabled
  const resolvedMime = resolveImageMime(mime, originalFileName);
  if (resolvedMime.startsWith("image/")) return "ocr_image";

  return "unsupported";
}

// ── Core extraction ───────────────────────────────────────────────────────────

/** Extracts text from a buffer using the given non-OCR provider. */
async function extractTextNative(
  provider: "pdf_text_layer" | "plain_text" | "docx_text" | "unsupported",
  buffer: Buffer,
): Promise<{ text: string; pageCount: number | null }> {
  switch (provider) {
    case "pdf_text_layer": {
      const result = await pdfParse(buffer);
      const text = result.text ?? "";
      // pdf-parse returns empty text for image-only PDFs
      if (text.trim().length === 0) {
        throw new DocTextExtractionError(
          "scanned_pdf_ocr_provider_not_configured",
          "PDF contains no embedded text layer. Scanned PDF — OCR for PDF pages requires a PDF rasterizer which is not configured. Only image files (PNG/JPG) support OCR.",
        );
      }
      return { text, pageCount: result.numpages ?? null };
    }

    case "plain_text": {
      const text = buffer.toString("utf8");
      return { text, pageCount: null };
    }

    case "docx_text": {
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value ?? "", pageCount: null };
    }

    case "unsupported":
      throw new DocTextExtractionError(
        "unsupported_file_type",
        "This file type does not have a supported text extractor in the current version.",
      );
  }
}

// ── Single document extraction ────────────────────────────────────────────────

/**
 * Runs text extraction for a single document.
 *
 * @param documentId  CrmLeadDocument.id
 * @param tenantId    Caller's tenant (used to verify ownership)
 * @param force       If true, re-extract even if already TEXT_COMPLETE
 */
export async function extractDocumentText(
  documentId: string,
  tenantId: string,
  force = false,
): Promise<ExtractionResult> {
  // Load document — scoped to caller's tenant
  const doc = await db.crmLeadDocument.findFirst({
    where: { id: documentId, tenantId, status: "IMPORTED" },
    select: {
      id: true,
      tenantId: true,
      contactId: true,
      importBatchId: true,
      storageKey: true,
      mimeType: true,
      importedMimeType: true,
      originalFileName: true,
      textExtractionStatus: true,
    },
  });

  if (!doc) {
    throw new DocTextExtractionError(
      "doc_not_imported",
      "Document not found or not yet imported for this tenant.",
    );
  }

  if (!doc.storageKey) {
    throw new DocTextExtractionError("no_storage_key", "Document has no storage key.");
  }

  // Idempotency: skip if already complete and not forced
  if (doc.textExtractionStatus === "TEXT_COMPLETE" && !force) {
    return { status: "skipped", reason: "already_complete" };
  }

  const baseProvider = detectExtractionProvider(doc.importedMimeType, doc.mimeType, doc.originalFileName);

  // Mark as TEXT_PROCESSING
  await db.$transaction([
    db.crmLeadDocument.update({
      where: { id: documentId },
      data: { textExtractionStatus: "TEXT_PROCESSING", textExtractionError: null },
    }),
  ]);

  let text = "";
  let pageCount: number | null = null;
  let finalProvider: string = baseProvider === "ocr_image" ? "tesseract_js" : baseProvider;
  let confidence: number | undefined;
  let extractionMetadata: Record<string, unknown> | undefined;

  try {
    const buffer = await readCrmDocFile(doc.storageKey);

    if (baseProvider === "ocr_image") {
      // ── OCR path ──────────────────────────────────────────────────────────
      const ocrConfig = loadOcrConfig();
      const ocrProvider = getOcrProvider(ocrConfig);

      if (!ocrProvider) {
        throw new DocTextExtractionError(
          "ocr_not_enabled",
          "OCR is not enabled. Set CRM_OCR_ENABLED=true in the API environment to process image files.",
        );
      }

      // Size limit check
      assertOcrSizeLimit(buffer, ocrConfig);

      const imageMime = resolveImageMime(
        doc.importedMimeType ?? doc.mimeType ?? "",
        doc.originalFileName,
      );

      if (!ocrProvider.supports(imageMime)) {
        throw new DocTextExtractionError(
          "ocr_unsupported_image_type",
          `Image MIME type '${imageMime}' is not supported by the configured OCR provider.`,
        );
      }

      const ocrResult = await ocrProvider.extractText(
        { buffer, mimeType: imageMime, fileName: doc.originalFileName },
        ocrConfig,
      );

      text = ocrResult.text.slice(0, MAX_STORED_CHARS);
      pageCount = ocrResult.pageCount;
      confidence = ocrResult.confidence;
      extractionMetadata = ocrResult.metadata;
      finalProvider = ocrProvider.name;
    } else {
      // ── Native extraction path ────────────────────────────────────────────
      const extracted = await extractTextNative(
        baseProvider as "pdf_text_layer" | "plain_text" | "docx_text" | "unsupported",
        buffer,
      );
      text = extracted.text.slice(0, MAX_STORED_CHARS);
      pageCount = extracted.pageCount;
    }
  } catch (err: unknown) {
    const errCode =
      err instanceof DocTextExtractionError
        ? err.code
        : err instanceof OcrLimitError
          ? err.code
          : "extraction_error";
    const safeMsg = truncateError(err);

    // Map error code to stored provider name
    if (errCode === "scanned_pdf_ocr_provider_not_configured") {
      finalProvider = "future_ocr";
    } else if (errCode === "unsupported_file_type" || errCode === "ocr_unsupported_image_type") {
      finalProvider = "unsupported";
    } else if (errCode === "ocr_not_enabled" || errCode === "ocr_file_too_large") {
      finalProvider = "tesseract_js";
    }

    // Persist failure
    await db.$transaction([
      db.crmLeadDocumentText.upsert({
        where: { documentId },
        create: {
          id: `cdt_${documentId}`,
          tenantId,
          documentId,
          contactId: doc.contactId ?? null,
          importBatchId: doc.importBatchId ?? null,
          text: "",
          charCount: 0,
          pageCount: null,
          extractionProvider: finalProvider as any,
          extractionStatus: "TEXT_FAILED",
          extractionError: safeMsg,
          extractedAt: null,
        },
        update: {
          extractionStatus: "TEXT_FAILED",
          extractionError: safeMsg,
          extractionProvider: finalProvider as any,
          text: "",
          charCount: 0,
          pageCount: null,
          extractionConfidence: null,
          extractionMetadata: null as any,
          extractedAt: null,
          updatedAt: new Date(),
        },
      }),
      db.crmLeadDocument.update({
        where: { id: documentId },
        data: {
          textExtractionStatus: "TEXT_FAILED",
          textExtractionError: safeMsg,
          textExtractedAt: null,
        },
      }),
    ]);

    return { status: "failed", provider: finalProvider, error: safeMsg };
  }

  const charCount = text.length;
  const now = new Date();

  // Persist success
  await db.$transaction([
    db.crmLeadDocumentText.upsert({
      where: { documentId },
      create: {
        id: `cdt_${documentId}`,
        tenantId,
        documentId,
        contactId: doc.contactId ?? null,
        importBatchId: doc.importBatchId ?? null,
        text,
        charCount,
        pageCount,
        extractionProvider: finalProvider as any,
        extractionStatus: "TEXT_COMPLETE",
        extractionError: null,
        extractedAt: now,
        extractionConfidence: confidence ?? null,
        extractionMetadata: (extractionMetadata ?? null) as any,
      },
      update: {
        text,
        charCount,
        pageCount,
        extractionProvider: finalProvider as any,
        extractionStatus: "TEXT_COMPLETE",
        extractionError: null,
        extractedAt: now,
        extractionConfidence: confidence ?? null,
        extractionMetadata: (extractionMetadata ?? null) as any,
        updatedAt: now,
      },
    }),
    db.crmLeadDocument.update({
      where: { id: documentId },
      data: {
        textExtractionStatus: "TEXT_COMPLETE",
        textExtractionError: null,
        textExtractedAt: now,
      },
    }),
  ]);

  return {
    status: "complete",
    provider: finalProvider,
    charCount,
    pageCount,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(extractionMetadata?.ocrEngine ? { ocrEngine: extractionMetadata.ocrEngine as string } : {}),
  };
}

// ── Batch extraction ──────────────────────────────────────────────────────────

/**
 * Extracts text for up to `limit` IMPORTED documents in a batch that haven't
 * been extracted yet (or have failed).
 *
 * Returns counts of attempted / complete / failed / skipped.
 * Max limit is 5 per call — callers must loop for large batches.
 */
export async function extractBatchDocumentText(
  batchId: string,
  tenantId: string,
  limit = 5,
  force = false,
): Promise<BatchExtractionSummary> {
  // Validate batch belongs to tenant
  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true },
  });
  if (!batch) {
    throw new DocTextExtractionError("batch_not_found", "Import batch not found for this tenant.");
  }

  const effectiveLimit = Math.min(5, Math.max(1, limit));

  const whereStatus = force
    ? { status: "IMPORTED" as const }
    : {
        status: "IMPORTED" as const,
        OR: [
          { textExtractionStatus: null },
          { textExtractionStatus: "TEXT_FAILED" as const },
          { textExtractionStatus: "TEXT_PENDING" as const },
        ],
      };

  const docs = await db.crmLeadDocument.findMany({
    where: { importBatchId: batchId, tenantId, ...whereStatus },
    select: { id: true },
    take: effectiveLimit,
    orderBy: { createdAt: "asc" },
  });

  const summary: BatchExtractionSummary = {
    attempted: docs.length,
    complete: 0,
    failed: 0,
    skipped: 0,
  };

  for (const doc of docs) {
    const result = await extractDocumentText(doc.id, tenantId, force);
    if (result.status === "complete") summary.complete++;
    else if (result.status === "failed") summary.failed++;
    else summary.skipped++;
  }

  return summary;
}

// ── Batch status summary ──────────────────────────────────────────────────────

export type BatchTextExtractionStatus = {
  total: number;
  pending: number;
  processing: number;
  complete: number;
  failed: number;
  notAttempted: number;
};

/**
 * Returns aggregate text extraction status counts for all IMPORTED documents
 * in a given import batch.
 */
export async function getBatchTextExtractionStatus(
  batchId: string,
  tenantId: string,
): Promise<BatchTextExtractionStatus> {
  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true },
  });
  if (!batch) {
    throw new DocTextExtractionError("batch_not_found", "Import batch not found for this tenant.");
  }

  const rows = await db.crmLeadDocument.groupBy({
    by: ["textExtractionStatus"],
    where: { importBatchId: batchId, tenantId, status: "IMPORTED" },
    _count: { id: true },
  });

  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = row.textExtractionStatus ?? "null";
    counts[key] = row._count.id;
  }

  return {
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    pending: counts["TEXT_PENDING"] ?? 0,
    processing: counts["TEXT_PROCESSING"] ?? 0,
    complete: counts["TEXT_COMPLETE"] ?? 0,
    failed: counts["TEXT_FAILED"] ?? 0,
    notAttempted: counts["null"] ?? 0,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncateError(err: unknown): string {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "unknown_error";
  return msg.slice(0, MAX_ERROR_MSG_CHARS);
}
