-- Migration: crm_lead_doc_text_extraction
-- Phase 5 — Document text extraction model
--
-- Changes:
--   1. Create enum CrmDocTextExtractionStatus
--   2. Create enum CrmDocTextExtractionProvider
--   3. Create table CrmLeadDocumentText
--   4. Add textExtractionStatus, textExtractionError, textExtractedAt to CrmLeadDocument

-- 1. Extraction status enum
CREATE TYPE "CrmDocTextExtractionStatus" AS ENUM (
  'TEXT_PENDING',
  'TEXT_PROCESSING',
  'TEXT_COMPLETE',
  'TEXT_FAILED'
);

-- 2. Extraction provider enum
--    pdf_text_layer  – PDF with embedded text (pdf-parse)
--    plain_text      – .txt / .csv / other text MIME
--    docx_text       – DOCX via mammoth
--    unsupported     – file type not supported for text extraction
--    future_ocr      – reserved for scanned-image/OCR path (not yet implemented)
CREATE TYPE "CrmDocTextExtractionProvider" AS ENUM (
  'pdf_text_layer',
  'plain_text',
  'docx_text',
  'unsupported',
  'future_ocr'
);

-- 3. CrmLeadDocumentText table
CREATE TABLE "CrmLeadDocumentText" (
  "id"                  TEXT          NOT NULL,
  "tenantId"            TEXT          NOT NULL,
  "documentId"          TEXT          NOT NULL,
  "contactId"           TEXT,
  "importBatchId"       TEXT,
  -- Extracted text content
  "text"                TEXT          NOT NULL DEFAULT '',
  -- Page count from PDF metadata (null for non-PDF types)
  "pageCount"           INTEGER,
  -- Character count of extracted text
  "charCount"           INTEGER       NOT NULL DEFAULT 0,
  "extractionProvider"  "CrmDocTextExtractionProvider" NOT NULL,
  "extractionStatus"    "CrmDocTextExtractionStatus"   NOT NULL DEFAULT 'TEXT_PENDING',
  -- Safe error message (no content, no paths)
  "extractionError"     TEXT,
  "extractedAt"         TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CrmLeadDocumentText_pkey" PRIMARY KEY ("id")
);

-- One active text record per document (for upsert idempotency)
CREATE UNIQUE INDEX "CrmLeadDocumentText_documentId_key"
  ON "CrmLeadDocumentText"("documentId");

-- Tenant-scoped indexes
CREATE INDEX "CrmLeadDocumentText_tenantId_documentId_idx"
  ON "CrmLeadDocumentText"("tenantId", "documentId");

CREATE INDEX "CrmLeadDocumentText_tenantId_extractionStatus_idx"
  ON "CrmLeadDocumentText"("tenantId", "extractionStatus");

CREATE INDEX "CrmLeadDocumentText_contactId_idx"
  ON "CrmLeadDocumentText"("contactId");

CREATE INDEX "CrmLeadDocumentText_importBatchId_idx"
  ON "CrmLeadDocumentText"("importBatchId");

-- Foreign key: document must exist
ALTER TABLE "CrmLeadDocumentText"
  ADD CONSTRAINT "CrmLeadDocumentText_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "CrmLeadDocument"("id") ON DELETE CASCADE;

-- Foreign key: tenant must exist
ALTER TABLE "CrmLeadDocumentText"
  ADD CONSTRAINT "CrmLeadDocumentText_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;

-- 4. Add text extraction status columns to CrmLeadDocument
ALTER TABLE "CrmLeadDocument"
  ADD COLUMN "textExtractionStatus" "CrmDocTextExtractionStatus",
  ADD COLUMN "textExtractionError"  TEXT,
  ADD COLUMN "textExtractedAt"      TIMESTAMP(3);

-- Index for status-based queries (find all IMPORTED docs with extraction pending)
CREATE INDEX "CrmLeadDocument_tenantId_textExtractionStatus_idx"
  ON "CrmLeadDocument"("tenantId", "textExtractionStatus");
