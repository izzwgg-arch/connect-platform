-- Migration: crm_doc_ocr
-- Phase 5B — OCR provider support for image documents
--
-- Changes:
--   1. Add 'tesseract_js' value to CrmDocTextExtractionProvider enum
--   2. Add extractionConfidence and extractionMetadata to CrmLeadDocumentText

-- 1. New enum value for Tesseract.js OCR provider.
--    PostgreSQL ALTER TYPE ADD VALUE cannot run inside a transaction
--    and must come before any usage of the new value.
ALTER TYPE "CrmDocTextExtractionProvider" ADD VALUE IF NOT EXISTS 'tesseract_js';

-- 2. New metadata columns on CrmLeadDocumentText.
--    Both nullable — existing rows are unaffected.
ALTER TABLE "CrmLeadDocumentText"
  -- OCR confidence score (0–100). Null for non-OCR extractions.
  ADD COLUMN IF NOT EXISTS "extractionConfidence" DOUBLE PRECISION,
  -- JSON metadata about the extraction run.
  -- OCR example: { "ocrEngine": "tesseract_js", "language": "eng", "pageCount": 1 }
  ADD COLUMN IF NOT EXISTS "extractionMetadata"   JSONB;
