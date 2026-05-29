/**
 * CRM Document Text Extraction Routes — Phase 5 / 5B
 *
 * Tenant-scoped routes for triggering and reading document text extraction.
 * Phase 5B adds image OCR support (Tesseract.js) when CRM_OCR_ENABLED=true.
 *
 * Routes:
 *   POST /crm/documents/:id/text-extraction
 *     Trigger extraction for a single IMPORTED document.
 *     Body: { force?: boolean }
 *     Images: if CRM_OCR_ENABLED, runs Tesseract.js OCR.
 *
 *   GET  /crm/documents/:id/text-extraction
 *     Get extraction status + extracted text for a single document.
 *     Response now includes: extractionConfidence, extractionMetadata.
 *
 *   POST /crm/import/batches/:batchId/text-extraction
 *     Trigger extraction for up to 5 IMPORTED docs in a batch.
 *     Body: { limit?: number, force?: boolean }
 *
 *   GET  /crm/import/batches/:batchId/text-extraction-status
 *     Get aggregate extraction counts for a batch.
 *
 * Security:
 *   - All routes require requireCrmAccess (tenant JWT).
 *   - Extracted text is scoped to the authenticated tenant — no cross-tenant access.
 *   - Extracted text is NEVER logged.
 */

import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import { requireCrmAccess } from "./guard";
import {
  extractDocumentText,
  extractBatchDocumentText,
  getBatchTextExtractionStatus,
  DocTextExtractionError,
} from "./docTextExtractionService";

export async function registerCrmDocTextExtractionRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /crm/documents/:id/text-extraction ─────────────────────────────
  // Trigger text extraction for a single IMPORTED document.
  app.post("/crm/documents/:id/text-extraction", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };
    const body = (req.body as Record<string, unknown>) ?? {};
    const force = body.force === true;

    try {
      const result = await extractDocumentText(id, tenantId, force);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      if (err instanceof DocTextExtractionError) {
        const status = err.code === "doc_not_imported" ? 404 : 422;
        return reply.status(status).send({ error: err.code, detail: err.message });
      }
      app.log.error({ docId: id, tenantId }, "crm_doc_text_extraction_route_error");
      return reply.status(500).send({ error: "extraction_failed" });
    }
  });

  // ── GET /crm/documents/:id/text-extraction ──────────────────────────────
  // Returns extraction status and extracted text for a single document.
  // Tenant-scoped: only returns data if doc belongs to this tenant.
  app.get("/crm/documents/:id/text-extraction", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    // Verify the document belongs to this tenant first
    const doc = await db.crmLeadDocument.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        status: true,
        textExtractionStatus: true,
        textExtractionError: true,
        textExtractedAt: true,
        originalFileName: true,
      },
    });

    if (!doc) {
      return reply.status(404).send({ error: "not_found" });
    }

    // Load the extraction record if it exists
    const textRecord = await db.crmLeadDocumentText.findUnique({
      where: { documentId: id },
      select: {
        extractionStatus: true,
        extractionProvider: true,
        extractionError: true,
        extractedAt: true,
        charCount: true,
        pageCount: true,
        text: true,
        extractionConfidence: true,
        extractionMetadata: true,
      },
    });

    return reply.status(200).send({
      documentId: id,
      documentStatus: doc.status,
      originalFileName: doc.originalFileName,
      extractionStatus: textRecord?.extractionStatus ?? doc.textExtractionStatus ?? null,
      extractionProvider: textRecord?.extractionProvider ?? null,
      extractionError: textRecord?.extractionError ?? doc.textExtractionError ?? null,
      extractedAt: textRecord?.extractedAt ?? doc.textExtractedAt ?? null,
      charCount: textRecord?.charCount ?? null,
      pageCount: textRecord?.pageCount ?? null,
      // OCR-specific fields (null for non-OCR extractions)
      extractionConfidence: textRecord?.extractionConfidence ?? null,
      extractionMetadata: textRecord?.extractionMetadata ?? null,
      // Include the text — callers may use this for UI preview or search
      text: textRecord?.text ?? null,
    });
  });

  // ── POST /crm/import/batches/:batchId/text-extraction ───────────────────
  // Trigger text extraction for up to 5 IMPORTED docs in a batch.
  app.post("/crm/import/batches/:batchId/text-extraction", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { batchId } = req.params as { batchId: string };
    const body = (req.body as Record<string, unknown>) ?? {};
    const limit = typeof body.limit === "number" ? body.limit : 5;
    const force = body.force === true;

    try {
      const summary = await extractBatchDocumentText(batchId, tenantId, limit, force);
      return reply.status(200).send(summary);
    } catch (err: unknown) {
      if (err instanceof DocTextExtractionError) {
        const status = err.code === "batch_not_found" ? 404 : 422;
        return reply.status(status).send({ error: err.code, detail: err.message });
      }
      app.log.error({ batchId, tenantId }, "crm_doc_batch_text_extraction_route_error");
      return reply.status(500).send({ error: "extraction_failed" });
    }
  });

  // ── GET /crm/import/batches/:batchId/text-extraction-status ─────────────
  // Returns aggregate text extraction counts for IMPORTED docs in a batch.
  app.get("/crm/import/batches/:batchId/text-extraction-status", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { batchId } = req.params as { batchId: string };

    try {
      const status = await getBatchTextExtractionStatus(batchId, tenantId);
      return reply.status(200).send(status);
    } catch (err: unknown) {
      if (err instanceof DocTextExtractionError) {
        const httpStatus = err.code === "batch_not_found" ? 404 : 422;
        return reply.status(httpStatus).send({ error: err.code, detail: err.message });
      }
      return reply.status(500).send({ error: "status_fetch_failed" });
    }
  });
}
