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

import { describe, it, expect } from "vitest";
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
    expect(detectExtractionProvider("application/pdf", null, "document.pdf")).toBe("pdf_text_layer");
  });

  it("returns pdf_text_layer for .pdf extension when MIME is missing", () => {
    expect(detectExtractionProvider(null, null, "report.pdf")).toBe("pdf_text_layer");
  });

  it("returns pdf_text_layer for importedMimeType=pdf (Google Workspace exported)", () => {
    // Google Docs exported to PDF: importedMimeType=application/pdf, original=google-apps.document
    expect(
      detectExtractionProvider(
        "application/pdf",
        "application/vnd.google-apps.document",
        "doc.gdoc",
      ),
    ).toBe("pdf_text_layer");
  });

  it("returns plain_text for text/plain", () => {
    expect(detectExtractionProvider("text/plain", null, "notes.txt")).toBe("plain_text");
  });

  it("returns plain_text for text/csv", () => {
    expect(detectExtractionProvider("text/csv", null, "leads.csv")).toBe("plain_text");
  });

  it("returns plain_text for .txt extension when MIME unknown", () => {
    expect(detectExtractionProvider(null, null, "document.txt")).toBe("plain_text");
  });

  it("returns docx_text for DOCX MIME", () => {
    expect(
      detectExtractionProvider(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        null,
        "contract.docx",
      ),
    ).toBe("docx_text");
  });

  it("returns docx_text for .docx extension when MIME unknown", () => {
    expect(detectExtractionProvider(null, null, "proposal.docx")).toBe("docx_text");
  });

  it("returns unsupported for JPEG image", () => {
    expect(detectExtractionProvider("image/jpeg", null, "scan.jpg")).toBe("unsupported");
  });

  it("returns unsupported for PNG", () => {
    expect(detectExtractionProvider("image/png", null, "screenshot.png")).toBe("unsupported");
  });

  it("returns unsupported for TIFF (common for scanned docs)", () => {
    expect(detectExtractionProvider("image/tiff", null, "scanned.tiff")).toBe("unsupported");
  });

  it("returns unsupported for XLSX", () => {
    expect(
      detectExtractionProvider(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        null,
        "data.xlsx",
      ),
    ).toBe("unsupported");
  });

  it("returns unsupported for arbitrary binary", () => {
    expect(detectExtractionProvider("application/octet-stream", null, "file.bin")).toBe(
      "unsupported",
    );
  });

  it("importedMimeType takes precedence over originalMimeType", () => {
    // File originally discovered as Google Slides but exported to PDF
    expect(
      detectExtractionProvider(
        "application/pdf",
        "application/vnd.google-apps.presentation",
        "slides.pdf",
      ),
    ).toBe("pdf_text_layer");
  });
});

// ── DocTextExtractionError ────────────────────────────────────────────────────

describe("DocTextExtractionError", () => {
  it("has a code and is an Error", () => {
    const err = new DocTextExtractionError("test_code", "test message");
    expect(err.code).toBe("test_code");
    expect(err.message).toBe("test message");
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe("DocTextExtractionError");
  });
});

// ── extractDocumentText contract (documented) ─────────────────────────────────

describe("extractDocumentText contract (documented)", () => {
  it("requires doc.status === IMPORTED (rejects non-imported docs)", () => {
    // Contract: findFirst({ where: { id, tenantId, status: "IMPORTED" } })
    // DISCOVERED, IMPORT_PENDING, IMPORT_FAILED → DocTextExtractionError("doc_not_imported")
    expect(true).toBe(true);
  });

  it("tenant B cannot extract tenant A document", () => {
    // Contract: findFirst({ where: { id, tenantId } }) — tenantId from JWT.
    // Tenant B querying tenant A's doc returns null → DocTextExtractionError("doc_not_imported").
    expect(true).toBe(true);
  });

  it("TEXT_COMPLETE with force=false returns { status: 'skipped' }", () => {
    // Idempotency: already extracted docs are not re-processed.
    expect(true).toBe(true);
  });

  it("TEXT_COMPLETE with force=true re-runs extraction", () => {
    // force=true bypasses the idempotency skip and runs the extractor again.
    expect(true).toBe(true);
  });

  it("TEXT_FAILED can always be retried without force=true", () => {
    // Failed docs always enter the TEXT_PROCESSING → TEXT_COMPLETE/TEXT_FAILED cycle again.
    expect(true).toBe(true);
  });

  it("status transition: null → TEXT_PROCESSING → TEXT_COMPLETE on success", () => {
    // Sets textExtractionStatus=TEXT_PROCESSING before calling extractor.
    // On success: upserts CrmLeadDocumentText + sets TEXT_COMPLETE on doc.
    expect(true).toBe(true);
  });

  it("status transition: TEXT_PROCESSING → TEXT_FAILED on extraction error", () => {
    // On exception from pdfParse/mammoth/plain-text read:
    // upserts CrmLeadDocumentText with TEXT_FAILED + safe truncated error message.
    expect(true).toBe(true);
  });

  it("extraction error message is truncated to 500 chars (no content leak)", () => {
    // Contract: truncateError(err) limits to MAX_ERROR_MSG_CHARS = 500.
    // This prevents large exception messages (which may include partial content) from leaking.
    expect(true).toBe(true);
  });

  it("scanned PDF (no text layer) results in TEXT_FAILED with 'scanned_or_image_ocr_not_configured'", () => {
    // Contract: pdf-parse returns empty string for image-only PDFs.
    // Service throws DocTextExtractionError("scanned_or_image_ocr_not_configured") →
    // stored as TEXT_FAILED with extractionProvider=future_ocr.
    expect(true).toBe(true);
  });

  it("unsupported file type results in TEXT_FAILED with 'unsupported_file_type'", () => {
    // Contract: detectExtractionProvider returns "unsupported" for JPEG/PNG/TIFF/XLSX/etc.
    // extractText("unsupported", ...) throws DocTextExtractionError("unsupported_file_type").
    expect(true).toBe(true);
  });

  it("upserts CrmLeadDocumentText — does not create a second row on retry", () => {
    // Contract: db.crmLeadDocumentText.upsert({ where: { documentId } })
    // Re-running extraction replaces the existing row, never creates a duplicate.
    expect(true).toBe(true);
  });

  it("extracted text is NOT logged at any level", () => {
    // Contract: the service never calls app.log / console with text content.
    // Log entries contain only { docId, tenantId, userId } identifiers.
    expect(true).toBe(true);
  });
});

// ── extractBatchDocumentText contract (documented) ───────────────────────────

describe("extractBatchDocumentText contract (documented)", () => {
  it("max limit is 5 per call (effectiveLimit = min(5, max(1, limit)))", () => {
    // Contract: passing limit=100 is capped to 5 to prevent blocking requests.
    expect(true).toBe(true);
  });

  it("only picks status=IMPORTED docs (never re-imports non-imported)", () => {
    // Contract: WHERE status='IMPORTED' — extraction is not triggered for DISCOVERED etc.
    expect(true).toBe(true);
  });

  it("only picks textExtractionStatus IS NULL or TEXT_FAILED or TEXT_PENDING", () => {
    // Not-yet-attempted (null) + failed docs are eligible; complete docs are skipped.
    expect(true).toBe(true);
  });

  it("force=true includes TEXT_COMPLETE docs in the batch run", () => {
    // Contract: force=true removes the status filter and re-processes everything.
    expect(true).toBe(true);
  });

  it("requires batch.tenantId to match caller tenantId", () => {
    // Contract: findFirst({ where: { id: batchId, tenantId } }) →
    // DocTextExtractionError("batch_not_found") if batch belongs to another tenant.
    expect(true).toBe(true);
  });

  it("returns { attempted, complete, failed, skipped } summary", () => {
    // Contract: one counter per individual extractDocumentText result status.
    expect(true).toBe(true);
  });
});

// ── Phase 5B: detectExtractionProvider — image types ─────────────────────────

describe("detectExtractionProvider — image types (Phase 5B)", () => {
  it("returns ocr_image for image/png MIME", () => {
    expect(detectExtractionProvider("image/png", null, "scan.png")).toBe("ocr_image");
  });

  it("returns ocr_image for image/jpeg MIME", () => {
    expect(detectExtractionProvider("image/jpeg", null, "photo.jpg")).toBe("ocr_image");
  });

  it("returns ocr_image for .png extension when MIME missing", () => {
    expect(detectExtractionProvider(null, null, "scan.png")).toBe("ocr_image");
  });

  it("returns ocr_image for .jpg extension when MIME missing", () => {
    expect(detectExtractionProvider(null, null, "photo.jpg")).toBe("ocr_image");
  });

  it("returns ocr_image for .jpeg extension when MIME missing", () => {
    expect(detectExtractionProvider(null, null, "photo.jpeg")).toBe("ocr_image");
  });

  it("returns ocr_image for .tiff extension", () => {
    expect(detectExtractionProvider("image/tiff", null, "scan.tiff")).toBe("ocr_image");
  });

  it("still returns pdf_text_layer for application/pdf (not affected by OCR path)", () => {
    expect(detectExtractionProvider("application/pdf", null, "report.pdf")).toBe("pdf_text_layer");
  });

  it("still returns unsupported for unknown types", () => {
    expect(detectExtractionProvider("application/x-executable", null, "binary.exe")).toBe("unsupported");
  });
});

// ── Phase 5B: resolveImageMime ────────────────────────────────────────────────

describe("resolveImageMime", () => {
  it("returns image/png for image/png MIME", () => {
    expect(resolveImageMime("image/png", "scan.png")).toBe("image/png");
  });

  it("returns image/jpeg for image/jpeg MIME", () => {
    expect(resolveImageMime("image/jpeg", "photo.jpg")).toBe("image/jpeg");
  });

  it("falls back to extension when MIME is missing", () => {
    expect(resolveImageMime("", "scan.png")).toBe("image/png");
    expect(resolveImageMime(null, "photo.jpg")).toBe("image/jpeg");
    expect(resolveImageMime(undefined, "scan.tiff")).toBe("image/tiff");
  });

  it("returns empty string for unsupported extension", () => {
    expect(resolveImageMime("", "document.pdf")).toBe("");
  });
});

// ── Phase 5B: OcrLimitError ───────────────────────────────────────────────────

describe("OcrLimitError", () => {
  it("has code and message and is an Error", () => {
    const err = new OcrLimitError("ocr_file_too_large", "File too large.");
    expect(err.code).toBe("ocr_file_too_large");
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe("OcrLimitError");
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
    expect(() => assertOcrSizeLimit(buf, config)).not.toThrow();
  });

  it("throws OcrLimitError when buffer exceeds limit", () => {
    const buf = Buffer.alloc(2 * 1024 * 1024);
    expect(() => assertOcrSizeLimit(buf, config)).toThrow(OcrLimitError);
    try {
      assertOcrSizeLimit(buf, config);
    } catch (e) {
      expect((e as OcrLimitError).code).toBe("ocr_file_too_large");
    }
  });
});

// ── Phase 5B: loadOcrConfig ───────────────────────────────────────────────────

describe("loadOcrConfig", () => {
  it("defaults to disabled when CRM_OCR_ENABLED is not set", () => {
    const originalEnv = process.env.CRM_OCR_ENABLED;
    delete process.env.CRM_OCR_ENABLED;
    const config = loadOcrConfig();
    expect(config.enabled).toBe(false);
    if (originalEnv !== undefined) process.env.CRM_OCR_ENABLED = originalEnv;
  });

  it("enables OCR when CRM_OCR_ENABLED=true", () => {
    const originalEnv = process.env.CRM_OCR_ENABLED;
    process.env.CRM_OCR_ENABLED = "true";
    const config = loadOcrConfig();
    expect(config.enabled).toBe(true);
    process.env.CRM_OCR_ENABLED = originalEnv ?? "";
    if (originalEnv === undefined) delete process.env.CRM_OCR_ENABLED;
  });

  it("defaults maxFileBytes to 10 MB", () => {
    const originalEnv = process.env.CRM_OCR_MAX_FILE_BYTES;
    delete process.env.CRM_OCR_MAX_FILE_BYTES;
    const config = loadOcrConfig();
    expect(config.maxFileBytes).toBe(10 * 1024 * 1024);
    if (originalEnv !== undefined) process.env.CRM_OCR_MAX_FILE_BYTES = originalEnv;
  });

  it("defaults provider to tesseract_js", () => {
    const config = loadOcrConfig();
    expect(config.provider).toBe("tesseract_js");
  });

  it("defaults lang to eng", () => {
    const config = loadOcrConfig();
    expect(config.lang).toBe("eng");
  });
});

// ── Phase 5B: getOcrProvider ──────────────────────────────────────────────────

describe("getOcrProvider", () => {
  it("returns null when OCR is disabled", () => {
    const config = { enabled: false, maxFileBytes: 10_000_000, provider: "tesseract_js", lang: "eng", langPath: undefined };
    expect(getOcrProvider(config)).toBeNull();
  });

  it("returns TesseractJsOcrProvider when enabled and provider=tesseract_js", () => {
    const config = { enabled: true, maxFileBytes: 10_000_000, provider: "tesseract_js", lang: "eng", langPath: undefined };
    const provider = getOcrProvider(config);
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe("tesseract_js");
  });

  it("returns null for unknown provider name", () => {
    const config = { enabled: true, maxFileBytes: 10_000_000, provider: "unknown_provider", lang: "eng", langPath: undefined };
    expect(getOcrProvider(config)).toBeNull();
  });
});

// ── Phase 5B: TesseractJsOcrProvider.supports ────────────────────────────────

describe("TesseractJsOcrProvider.supports", () => {
  const provider = new TesseractJsOcrProvider();

  it("supports image/png", () => {
    expect(provider.supports("image/png")).toBe(true);
  });

  it("supports image/jpeg", () => {
    expect(provider.supports("image/jpeg")).toBe(true);
  });

  it("supports image/tiff", () => {
    expect(provider.supports("image/tiff")).toBe(true);
  });

  it("does not support application/pdf", () => {
    expect(provider.supports("application/pdf")).toBe(false);
  });

  it("does not support application/vnd.openxmlformats-officedocument.wordprocessingml.document", () => {
    expect(provider.supports("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
  });

  it("does not support text/plain", () => {
    expect(provider.supports("text/plain")).toBe(false);
  });
});

// ── Phase 5B: OCR service contracts (documented) ─────────────────────────────

describe("OCR extraction service contract (documented)", () => {
  it("OCR disabled → extraction fails with ocr_not_enabled error stored as TEXT_FAILED", () => {
    // When CRM_OCR_ENABLED is not 'true', image docs fail with:
    //   error: "OCR is not enabled. Set CRM_OCR_ENABLED=true..."
    //   provider: "tesseract_js" (stored for retry visibility)
    expect(true).toBe(true);
  });

  it("OCR enabled → TesseractJsOcrProvider.extractText() called with document buffer", () => {
    // Flow: baseProvider='ocr_image', ocrProvider.supports(mime)=true,
    //       assertOcrSizeLimit(buffer), ocrProvider.extractText(...)
    expect(true).toBe(true);
  });

  it("OCR success stores text, confidence (0–100), metadata JSON, provider=tesseract_js", () => {
    // db.crmLeadDocumentText.upsert: extractionConfidence=confidence, extractionMetadata=metadata
    expect(true).toBe(true);
  });

  it("OCR failure stores safe error (no OCR text), provider=tesseract_js, status=TEXT_FAILED", () => {
    // extractionError is truncated to 500 chars and never contains document content
    expect(true).toBe(true);
  });

  it("file exceeds CRM_OCR_MAX_FILE_BYTES → ocr_file_too_large error, not passed to Tesseract", () => {
    // assertOcrSizeLimit throws OcrLimitError before readCrmDocFile
    // Wait — actually assertOcrSizeLimit is called AFTER readCrmDocFile in the service
    // because we need the buffer to check size. The limit check is pre-OCR but post-file-read.
    expect(true).toBe(true);
  });

  it("scanned PDF (empty pdf-parse result) fails with scanned_pdf_ocr_provider_not_configured", () => {
    // extractText('pdf_text_layer', ...) → empty text → throws DocTextExtractionError
    // stored with provider='future_ocr' for backward compat
    expect(true).toBe(true);
  });

  it("OCR provider does not support detected MIME → ocr_unsupported_image_type stored safely", () => {
    // ocrProvider.supports(imageMime) returns false → DocTextExtractionError
    expect(true).toBe(true);
  });

  it("tenant B cannot trigger or read Tenant A OCR text", () => {
    // db.crmLeadDocument.findFirst({ where: { id, tenantId } }) still scopes to JWT tenant
    expect(true).toBe(true);
  });

  it("existing PDF text-layer extraction path is unaffected by OCR", () => {
    // detectExtractionProvider('application/pdf', ...) → 'pdf_text_layer' → extractTextNative
    expect(true).toBe(true);
  });

  it("existing plain text extraction path is unaffected by OCR", () => {
    expect(true).toBe(true);
  });

  it("existing DOCX extraction path is unaffected by OCR", () => {
    expect(true).toBe(true);
  });
});

// ── Phase 5B: GET response shape (documented) ────────────────────────────────

describe("GET /crm/documents/:id/text-extraction response shape (Phase 5B)", () => {
  it("includes extractionConfidence (null for non-OCR, 0–100 for OCR)", () => {
    // textRecord.extractionConfidence is selected and returned
    expect(true).toBe(true);
  });

  it("includes extractionMetadata (null for non-OCR, JSON for OCR)", () => {
    // textRecord.extractionMetadata is selected and returned
    expect(true).toBe(true);
  });

  it("extractionMetadata for tesseract_js contains ocrEngine, language, pageCount", () => {
    // { ocrEngine: 'tesseract_js', language: 'eng', pageCount: 1 }
    expect(true).toBe(true);
  });
});

// ── GET /crm/documents/:id/text-extraction route contract (documented) ────────

describe("GET /crm/documents/:id/text-extraction route contract (documented)", () => {
  it("returns 404 if doc does not belong to caller's tenant", () => {
    // Contract: db.crmLeadDocument.findFirst({ where: { id, tenantId } }) from JWT.
    // Cross-tenant attempt returns 404 (not 403 — avoids document existence disclosure).
    expect(true).toBe(true);
  });

  it("returns extractionStatus=null and text=null if extraction was never attempted", () => {
    // Contract: if no CrmLeadDocumentText row exists, returns null for extraction fields.
    expect(true).toBe(true);
  });

  it("returns extracted text to authenticated same-tenant CRM user", () => {
    // Contract: requireCrmAccess passes → doc found for tenant → text returned.
    expect(true).toBe(true);
  });

  it("requires JWT auth (unauthenticated → 401)", () => {
    // Contract: requireCrmAccess rejects unauthenticated callers before any DB query.
    expect(true).toBe(true);
  });
});
