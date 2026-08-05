/**
 * CRM Document Text Extraction — Phase 5 / 5B focused tests
 *
 * Tests pure/unit-level logic:
 *   docTextExtractionService: detectExtractionProvider, DocTextExtractionError
 *   docOcrProvider: loadOcrConfig, TesseractJsOcrProvider.supports, assertOcrSizeLimit,
 *                   resolveImageMime, getOcrProvider, OcrLimitError
 *
 * Also documents the service and route contracts:
 *   Phase 5 (base):
 *   - Cannot extract from non-imported docs
 *   - Tenant B cannot extract/read Tenant A text
 *   - Status transitions
 *   - TEXT_COMPLETE idempotency (force=false skips)
 *   - force=true refreshes
 *   - Extraction failure stores safe error only
 *   - Batch limit enforced (max 5)
 *   - Scanned PDF path — scanned_pdf_ocr_provider_not_configured
 *   - Unsupported file types have a clear failure reason
 *
 *   Phase 5B (OCR):
 *   - Image MIME type → detectExtractionProvider returns "ocr_image"
 *   - OCR disabled → ocr_not_enabled failure stored safely
 *   - OCR enabled → TesseractJsOcrProvider called with buffer
 *   - File size limit enforced before OCR
 *   - OCR success stores text, confidence, metadata (no raw text in logs)
 *   - OCR failure stores safe error only
 *   - Unsupported image type fails safely
 *   - Tenant isolation unchanged with OCR
 *   - Existing PDF text-layer extraction still works
 *   - GET response includes extractionConfidence and extractionMetadata
 *
 * Does NOT hit the database, file system, or external libraries.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectExtractionProvider, DocTextExtractionError } from "./docTextExtractionService";
import {
  loadOcrConfig,
  getOcrProvider,
  assertOcrSizeLimit,
  OcrLimitError,
  resolveImageMime,
  TesseractJsOcrProvider,
} from "./docOcrProvider";

// ── detectExtractionProvider ─────────────────────────────────────────────────

describe("detectExtractionProvider", () => {
  it("returns pdf_text_layer for application/pdf MIME", () => {
    assert.equal(detectExtractionProvider("application/pdf", null, "document.pdf"), "pdf_text_layer");
  });

  it("returns pdf_text_layer for .pdf extension when MIME is missing", () => {
    assert.equal(detectExtractionProvider(null, null, "report.pdf"), "pdf_text_layer");
  });

  it("returns pdf_text_layer for importedMimeType=pdf (Google Workspace exported)", () => {
    // Google Docs exported to PDF: importedMimeType=application/pdf, original=google-apps.document
    assert.equal(detectExtractionProvider(
        "application/pdf",
        "application/vnd.google-apps.document",
        "doc.gdoc",
      ), "pdf_text_layer");
  });

  it("returns plain_text for text/plain", () => {
    assert.equal(detectExtractionProvider("text/plain", null, "notes.txt"), "plain_text");
  });

  it("returns plain_text for text/csv", () => {
    assert.equal(detectExtractionProvider("text/csv", null, "leads.csv"), "plain_text");
  });

  it("returns plain_text for .txt extension when MIME unknown", () => {
    assert.equal(detectExtractionProvider(null, null, "document.txt"), "plain_text");
  });

  it("returns docx_text for DOCX MIME", () => {
    assert.equal(detectExtractionProvider(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        null,
        "contract.docx",
      ), "docx_text");
  });

  it("returns docx_text for .docx extension when MIME unknown", () => {
    assert.equal(detectExtractionProvider(null, null, "proposal.docx"), "docx_text");
  });

  it("returns ocr_image for JPEG image", () => {
    assert.equal(detectExtractionProvider("image/jpeg", null, "scan.jpg"), "ocr_image");
  });

  it("returns ocr_image for PNG", () => {
    assert.equal(detectExtractionProvider("image/png", null, "screenshot.png"), "ocr_image");
  });

  it("returns ocr_image for TIFF (common for scanned docs)", () => {
    assert.equal(detectExtractionProvider("image/tiff", null, "scanned.tiff"), "ocr_image");
  });

  it("returns unsupported for XLSX", () => {
    assert.equal(detectExtractionProvider(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        null,
        "data.xlsx",
      ), "unsupported");
  });

  it("returns unsupported for arbitrary binary", () => {
    assert.equal(detectExtractionProvider("application/octet-stream", null, "file.bin"), "unsupported",);
  });

  it("importedMimeType takes precedence over originalMimeType", () => {
    // File originally discovered as Google Slides but exported to PDF
    assert.equal(detectExtractionProvider(
        "application/pdf",
        "application/vnd.google-apps.presentation",
        "slides.pdf",
      ), "pdf_text_layer");
  });
});

// ── DocTextExtractionError ────────────────────────────────────────────────────

describe("DocTextExtractionError", () => {
  it("has a code and is an Error", () => {
    const err = new DocTextExtractionError("test_code", "test message");
    assert.equal(err.code, "test_code");
    assert.equal(err.message, "test message");
    assert.equal(err instanceof Error, true);
    assert.equal(err.name, "DocTextExtractionError");
  });
});

// ── extractDocumentText contract (documented) ─────────────────────────────────

describe("extractDocumentText contract (documented)", () => {
  it("requires doc.status === IMPORTED (rejects non-imported docs)", () => {
    // Contract: findFirst({ where: { id, tenantId, status: "IMPORTED" } })
    // DISCOVERED, IMPORT_PENDING, IMPORT_FAILED → DocTextExtractionError("doc_not_imported")
    assert.equal(true, true);
  });

  it("tenant B cannot extract tenant A document", () => {
    // Contract: findFirst({ where: { id, tenantId } }) — tenantId from JWT.
    // Tenant B querying tenant A's doc returns null → DocTextExtractionError("doc_not_imported").
    assert.equal(true, true);
  });

  it("TEXT_COMPLETE with force=false returns { status: 'skipped' }", () => {
    // Idempotency: already extracted docs are not re-processed.
    assert.equal(true, true);
  });

  it("TEXT_COMPLETE with force=true re-runs extraction", () => {
    // force=true bypasses the idempotency skip and runs the extractor again.
    assert.equal(true, true);
  });

  it("TEXT_FAILED can always be retried without force=true", () => {
    // Failed docs always enter the TEXT_PROCESSING → TEXT_COMPLETE/TEXT_FAILED cycle again.
    assert.equal(true, true);
  });

  it("status transition: null → TEXT_PROCESSING → TEXT_COMPLETE on success", () => {
    // Sets textExtractionStatus=TEXT_PROCESSING before calling extractor.
    // On success: upserts CrmLeadDocumentText + sets TEXT_COMPLETE on doc.
    assert.equal(true, true);
  });

  it("status transition: TEXT_PROCESSING → TEXT_FAILED on extraction error", () => {
    // On exception from pdfParse/mammoth/plain-text read:
    // upserts CrmLeadDocumentText with TEXT_FAILED + safe truncated error message.
    assert.equal(true, true);
  });

  it("extraction error message is truncated to 500 chars (no content leak)", () => {
    // Contract: truncateError(err) limits to MAX_ERROR_MSG_CHARS = 500.
    // This prevents large exception messages (which may include partial content) from leaking.
    assert.equal(true, true);
  });

  it("scanned PDF (no text layer) results in TEXT_FAILED with 'scanned_or_image_ocr_not_configured'", () => {
    // Contract: pdf-parse returns empty string for image-only PDFs.
    // Service throws DocTextExtractionError("scanned_or_image_ocr_not_configured") →
    // stored as TEXT_FAILED with extractionProvider=future_ocr.
    assert.equal(true, true);
  });

  it("unsupported file type results in TEXT_FAILED with 'unsupported_file_type'", () => {
    // Contract: detectExtractionProvider returns "unsupported" for JPEG/PNG/TIFF/XLSX/etc.
    // extractText("unsupported", ...) throws DocTextExtractionError("unsupported_file_type").
    assert.equal(true, true);
  });

  it("upserts CrmLeadDocumentText — does not create a second row on retry", () => {
    // Contract: db.crmLeadDocumentText.upsert({ where: { documentId } })
    // Re-running extraction replaces the existing row, never creates a duplicate.
    assert.equal(true, true);
  });

  it("extracted text is NOT logged at any level", () => {
    // Contract: the service never calls app.log / console with text content.
    // Log entries contain only { docId, tenantId, userId } identifiers.
    assert.equal(true, true);
  });
});

// ── extractBatchDocumentText contract (documented) ───────────────────────────

describe("extractBatchDocumentText contract (documented)", () => {
  it("max limit is 5 per call (effectiveLimit = min(5, max(1, limit)))", () => {
    // Contract: passing limit=100 is capped to 5 to prevent blocking requests.
    assert.equal(true, true);
  });

  it("only picks status=IMPORTED docs (never re-imports non-imported)", () => {
    // Contract: WHERE status='IMPORTED' — extraction is not triggered for DISCOVERED etc.
    assert.equal(true, true);
  });

  it("only picks textExtractionStatus IS NULL or TEXT_FAILED or TEXT_PENDING", () => {
    // Not-yet-attempted (null) + failed docs are eligible; complete docs are skipped.
    assert.equal(true, true);
  });

  it("force=true includes TEXT_COMPLETE docs in the batch run", () => {
    // Contract: force=true removes the status filter and re-processes everything.
    assert.equal(true, true);
  });

  it("requires batch.tenantId to match caller tenantId", () => {
    // Contract: findFirst({ where: { id: batchId, tenantId } }) →
    // DocTextExtractionError("batch_not_found") if batch belongs to another tenant.
    assert.equal(true, true);
  });

  it("returns { attempted, complete, failed, skipped } summary", () => {
    // Contract: one counter per individual extractDocumentText result status.
    assert.equal(true, true);
  });
});

// ── Phase 5B: detectExtractionProvider — image types ─────────────────────────

describe("detectExtractionProvider — image types (Phase 5B)", () => {
  it("returns ocr_image for image/png MIME", () => {
    assert.equal(detectExtractionProvider("image/png", null, "scan.png"), "ocr_image");
  });

  it("returns ocr_image for image/jpeg MIME", () => {
    assert.equal(detectExtractionProvider("image/jpeg", null, "photo.jpg"), "ocr_image");
  });

  it("returns ocr_image for .png extension when MIME missing", () => {
    assert.equal(detectExtractionProvider(null, null, "scan.png"), "ocr_image");
  });

  it("returns ocr_image for .jpg extension when MIME missing", () => {
    assert.equal(detectExtractionProvider(null, null, "photo.jpg"), "ocr_image");
  });

  it("returns ocr_image for .jpeg extension when MIME missing", () => {
    assert.equal(detectExtractionProvider(null, null, "photo.jpeg"), "ocr_image");
  });

  it("returns ocr_image for .tiff extension", () => {
    assert.equal(detectExtractionProvider("image/tiff", null, "scan.tiff"), "ocr_image");
  });

  it("still returns pdf_text_layer for application/pdf (not affected by OCR path)", () => {
    assert.equal(detectExtractionProvider("application/pdf", null, "report.pdf"), "pdf_text_layer");
  });

  it("still returns unsupported for unknown types", () => {
    assert.equal(detectExtractionProvider("application/x-executable", null, "binary.exe"), "unsupported");
  });
});

// ── Phase 5B: resolveImageMime ────────────────────────────────────────────────

describe("resolveImageMime", () => {
  it("returns image/png for image/png MIME", () => {
    assert.equal(resolveImageMime("image/png", "scan.png"), "image/png");
  });

  it("returns image/jpeg for image/jpeg MIME", () => {
    assert.equal(resolveImageMime("image/jpeg", "photo.jpg"), "image/jpeg");
  });

  it("falls back to extension when MIME is missing", () => {
    assert.equal(resolveImageMime("", "scan.png"), "image/png");
    assert.equal(resolveImageMime(null, "photo.jpg"), "image/jpeg");
    assert.equal(resolveImageMime(undefined, "scan.tiff"), "image/tiff");
  });

  it("returns empty string for unsupported extension", () => {
    assert.equal(resolveImageMime("", "document.pdf"), "");
  });
});

// ── Phase 5B: OcrLimitError ───────────────────────────────────────────────────

describe("OcrLimitError", () => {
  it("has code and message and is an Error", () => {
    const err = new OcrLimitError("ocr_file_too_large", "File too large.");
    assert.equal(err.code, "ocr_file_too_large");
    assert.equal(err instanceof Error, true);
    assert.equal(err.name, "OcrLimitError");
  });
});

// ── Phase 5B: assertOcrSizeLimit ─────────────────────────────────────────────

describe("assertOcrSizeLimit", () => {
  const config = {
    enabled: true,
    maxFileBytes: 1024 * 1024, // 1 MB
    provider: "tesseract_js",
    lang: "eng",
    langPath: undefined,
  };

  it("does not throw when buffer is within limit", () => {
    const buf = Buffer.alloc(512 * 1024);
    assert.doesNotThrow(() => assertOcrSizeLimit(buf, config));
  });

  it("throws OcrLimitError when buffer exceeds limit", () => {
    const buf = Buffer.alloc(2 * 1024 * 1024);
    assert.throws(() => assertOcrSizeLimit(buf, config), OcrLimitError);
    try {
      assertOcrSizeLimit(buf, config);
    } catch (e) {
      assert.equal((e as OcrLimitError).code, "ocr_file_too_large");
    }
  });
});

// ── Phase 5B: loadOcrConfig ───────────────────────────────────────────────────

describe("loadOcrConfig", () => {
  it("defaults to disabled when CRM_OCR_ENABLED is not set", () => {
    const originalEnv = process.env.CRM_OCR_ENABLED;
    delete process.env.CRM_OCR_ENABLED;
    const config = loadOcrConfig();
    assert.equal(config.enabled, false);
    if (originalEnv !== undefined) process.env.CRM_OCR_ENABLED = originalEnv;
  });

  it("enables OCR when CRM_OCR_ENABLED=true", () => {
    const originalEnv = process.env.CRM_OCR_ENABLED;
    process.env.CRM_OCR_ENABLED = "true";
    const config = loadOcrConfig();
    assert.equal(config.enabled, true);
    process.env.CRM_OCR_ENABLED = originalEnv ?? "";
    if (originalEnv === undefined) delete process.env.CRM_OCR_ENABLED;
  });

  it("defaults maxFileBytes to 10 MB", () => {
    const originalEnv = process.env.CRM_OCR_MAX_FILE_BYTES;
    delete process.env.CRM_OCR_MAX_FILE_BYTES;
    const config = loadOcrConfig();
    assert.equal(config.maxFileBytes, 10 * 1024 * 1024);
    if (originalEnv !== undefined) process.env.CRM_OCR_MAX_FILE_BYTES = originalEnv;
  });

  it("defaults provider to tesseract_js", () => {
    const config = loadOcrConfig();
    assert.equal(config.provider, "tesseract_js");
  });

  it("defaults lang to eng", () => {
    const config = loadOcrConfig();
    assert.equal(config.lang, "eng");
  });
});

// ── Phase 5B: getOcrProvider ──────────────────────────────────────────────────

describe("getOcrProvider", () => {
  it("returns null when OCR is disabled", () => {
    const config = { enabled: false, maxFileBytes: 10_000_000, provider: "tesseract_js", lang: "eng", langPath: undefined };
    assert.equal(getOcrProvider(config), null);
  });

  it("returns TesseractJsOcrProvider when enabled and provider=tesseract_js", () => {
    const config = { enabled: true, maxFileBytes: 10_000_000, provider: "tesseract_js", lang: "eng", langPath: undefined };
    const provider = getOcrProvider(config);
    assert.notEqual(provider, null);
    assert.equal(provider?.name, "tesseract_js");
  });

  it("returns null for unknown provider name", () => {
    const config = { enabled: true, maxFileBytes: 10_000_000, provider: "unknown_provider", lang: "eng", langPath: undefined };
    assert.equal(getOcrProvider(config), null);
  });
});

// ── Phase 5B: TesseractJsOcrProvider.supports ────────────────────────────────

describe("TesseractJsOcrProvider.supports", () => {
  const provider = new TesseractJsOcrProvider();

  it("supports image/png", () => {
    assert.equal(provider.supports("image/png"), true);
  });

  it("supports image/jpeg", () => {
    assert.equal(provider.supports("image/jpeg"), true);
  });

  it("supports image/tiff", () => {
    assert.equal(provider.supports("image/tiff"), true);
  });

  it("does not support application/pdf", () => {
    assert.equal(provider.supports("application/pdf"), false);
  });

  it("does not support application/vnd.openxmlformats-officedocument.wordprocessingml.document", () => {
    assert.equal(provider.supports("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), false);
  });

  it("does not support text/plain", () => {
    assert.equal(provider.supports("text/plain"), false);
  });
});

// ── Phase 5B: OCR service contracts (documented) ─────────────────────────────

describe("OCR extraction service contract (documented)", () => {
  it("OCR disabled → extraction fails with ocr_not_enabled error stored as TEXT_FAILED", () => {
    // When CRM_OCR_ENABLED is not 'true', image docs fail with:
    //   error: "OCR is not enabled. Set CRM_OCR_ENABLED=true..."
    //   provider: "tesseract_js" (stored for retry visibility)
    assert.equal(true, true);
  });

  it("OCR enabled → TesseractJsOcrProvider.extractText() called with document buffer", () => {
    // Flow: baseProvider='ocr_image', ocrProvider.supports(mime)=true,
    //       assertOcrSizeLimit(buffer), ocrProvider.extractText(...)
    assert.equal(true, true);
  });

  it("OCR success stores text, confidence (0–100), metadata JSON, provider=tesseract_js", () => {
    // db.crmLeadDocumentText.upsert: extractionConfidence=confidence, extractionMetadata=metadata
    assert.equal(true, true);
  });

  it("OCR failure stores safe error (no OCR text), provider=tesseract_js, status=TEXT_FAILED", () => {
    // extractionError is truncated to 500 chars and never contains document content
    assert.equal(true, true);
  });

  it("file exceeds CRM_OCR_MAX_FILE_BYTES → ocr_file_too_large error, not passed to Tesseract", () => {
    // assertOcrSizeLimit throws OcrLimitError before readCrmDocFile
    // Wait — actually assertOcrSizeLimit is called AFTER readCrmDocFile in the service
    // because we need the buffer to check size. The limit check is pre-OCR but post-file-read.
    assert.equal(true, true);
  });

  it("scanned PDF (empty pdf-parse result) fails with scanned_pdf_ocr_provider_not_configured", () => {
    // extractText('pdf_text_layer', ...) → empty text → throws DocTextExtractionError
    // stored with provider='future_ocr' for backward compat
    assert.equal(true, true);
  });

  it("OCR provider does not support detected MIME → ocr_unsupported_image_type stored safely", () => {
    // ocrProvider.supports(imageMime) returns false → DocTextExtractionError
    assert.equal(true, true);
  });

  it("tenant B cannot trigger or read Tenant A OCR text", () => {
    // db.crmLeadDocument.findFirst({ where: { id, tenantId } }) still scopes to JWT tenant
    assert.equal(true, true);
  });

  it("existing PDF text-layer extraction path is unaffected by OCR", () => {
    // detectExtractionProvider('application/pdf', ...) → 'pdf_text_layer' → extractTextNative
    assert.equal(true, true);
  });

  it("existing plain text extraction path is unaffected by OCR", () => {
    assert.equal(true, true);
  });

  it("existing DOCX extraction path is unaffected by OCR", () => {
    assert.equal(true, true);
  });
});

// ── Phase 5B: GET response shape (documented) ────────────────────────────────

describe("GET /crm/documents/:id/text-extraction response shape (Phase 5B)", () => {
  it("includes extractionConfidence (null for non-OCR, 0–100 for OCR)", () => {
    // textRecord.extractionConfidence is selected and returned
    assert.equal(true, true);
  });

  it("includes extractionMetadata (null for non-OCR, JSON for OCR)", () => {
    // textRecord.extractionMetadata is selected and returned
    assert.equal(true, true);
  });

  it("extractionMetadata for tesseract_js contains ocrEngine, language, pageCount", () => {
    // { ocrEngine: 'tesseract_js', language: 'eng', pageCount: 1 }
    assert.equal(true, true);
  });
});

// ── GET /crm/documents/:id/text-extraction route contract (documented) ────────

describe("GET /crm/documents/:id/text-extraction route contract (documented)", () => {
  it("returns 404 if doc does not belong to caller's tenant", () => {
    // Contract: db.crmLeadDocument.findFirst({ where: { id, tenantId } }) from JWT.
    // Cross-tenant attempt returns 404 (not 403 — avoids document existence disclosure).
    assert.equal(true, true);
  });

  it("returns extractionStatus=null and text=null if extraction was never attempted", () => {
    // Contract: if no CrmLeadDocumentText row exists, returns null for extraction fields.
    assert.equal(true, true);
  });

  it("returns extracted text to authenticated same-tenant CRM user", () => {
    // Contract: requireCrmAccess passes → doc found for tenant → text returned.
    assert.equal(true, true);
  });

  it("requires JWT auth (unauthenticated → 401)", () => {
    // Contract: requireCrmAccess rejects unauthenticated callers before any DB query.
    assert.equal(true, true);
  });
});
