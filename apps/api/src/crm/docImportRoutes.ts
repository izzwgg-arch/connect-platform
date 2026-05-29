/**
 * CRM Document Import Routes — Phase 3
 *
 * Tenant-scoped routes for importing Google Drive documents into local storage
 * and serving them to authenticated users via signed URLs.
 *
 * Routes:
 *   POST /crm/documents/:id/import
 *   POST /crm/import/batches/:batchId/import-documents
 *   GET  /crm/import/batches/:batchId/document-import-status
 *   GET  /crm/documents/:id/open           (signed URL generation)
 *   GET  /crm/documents/:id/open           (file streaming — unsigned with sig param)
 *
 * Security:
 * - All routes require requireCrmAccess (tenant JWT).
 * - File streaming uses HMAC-signed URLs with expiry to prevent hotlinking.
 * - Storage keys are NEVER returned to callers in plain form.
 * - File contents are NEVER logged.
 */

import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import { requireCrmAccess } from "./guard";
import {
  importSingleDocument,
  importBatchDocuments,
  getBatchDocumentImportStatus,
  DocImportError,
} from "./docImportService";
import {
  buildSignedCrmDocUrl,
  verifySignedCrmDocUrl,
  readCrmDocFile,
  contentTypeForCrmDoc,
  getCrmDocMaxBytes,
} from "./docImportStorage";

// ── Route registrar ──────────────────────────────────────────────────────────

export async function registerCrmDocImportRoutes(app: FastifyInstance) {
  // ── POST /crm/documents/:id/import ─────────────────────────────────────
  // Imports a single IMPORT_PENDING (or IMPORT_FAILED for retry) document from
  // Google Drive. Synchronous — returns when the file is stored or failed.
  //
  // Body (optional): { force: boolean }  — re-import even if already IMPORTED
  app.post("/crm/documents/:id/import", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };
    const { force } = (req.body as any) ?? {};

    try {
      const result = await importSingleDocument(id, tenantId, !!force);
      return reply.status(200).send(result);
    } catch (err: any) {
      if (err instanceof DocImportError) {
        const status =
          err.code === "doc_not_found" ? 404
          : err.code === "invalid_status" ? 409
          : err.code === "no_drive_folder" ? 409
          : 422;
        return reply.status(status).send({ error: err.code, detail: err.message });
      }
      app.log.error({ docId: id, err: err?.message }, "crm_doc_import_unexpected_error");
      return reply.status(500).send({ error: "import_failed" });
    }
  });

  // ── POST /crm/import/batches/:batchId/import-documents ─────────────────
  // Imports up to `limit` (max 20) IMPORT_PENDING documents for a batch.
  // Call repeatedly until `attempted === 0` to import all docs in large batches.
  //
  // Body (optional): { limit: number }  — defaults to 20 (max 20)
  app.post("/crm/import/batches/:batchId/import-documents", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { batchId } = req.params as { batchId: string };
    const { limit } = (req.body as any) ?? {};
    const effectiveLimit = Math.min(20, Math.max(1, parseInt(limit ?? "20", 10)));

    try {
      const result = await importBatchDocuments(batchId, tenantId, effectiveLimit);
      return reply.status(200).send(result);
    } catch (err: any) {
      if (err instanceof DocImportError) {
        const status = err.code === "batch_not_found" ? 404 : 422;
        return reply.status(status).send({ error: err.code, detail: err.message });
      }
      app.log.error({ batchId, err: err?.message }, "crm_batch_import_unexpected_error");
      return reply.status(500).send({ error: "batch_import_failed" });
    }
  });

  // ── GET /crm/import/batches/:batchId/document-import-status ────────────
  // Returns counts of documents per status for the batch, plus a per-doc list.
  app.get("/crm/import/batches/:batchId/document-import-status", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { batchId } = req.params as { batchId: string };

    try {
      const summary = await getBatchDocumentImportStatus(batchId, tenantId);

      // Also return the per-doc list so the UI can render individual statuses
      const docs = await db.crmLeadDocument.findMany({
        where: { tenantId, importBatchId: batchId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          originalFileName: true,
          status: true,
          importedAt: true,
          importError: true,
          importedMimeType: true,
          matchConfidence: true,
          contact: { select: { id: true, displayName: true, company: true } },
        },
      });

      return reply.status(200).send({
        ...summary,
        docs: docs.map((d) => ({
          id: d.id,
          originalFileName: d.originalFileName,
          status: d.status,
          importedAt: d.importedAt ?? null,
          importError: d.importError ?? null,
          importedMimeType: d.importedMimeType ?? null,
          matchConfidence: d.matchConfidence ?? null,
          contact: d.contact ?? null,
        })),
      });
    } catch (err: any) {
      if (err instanceof DocImportError) {
        const status = err.code === "batch_not_found" ? 404 : 422;
        return reply.status(status).send({ error: err.code, detail: err.message });
      }
      return reply.status(500).send({ error: "status_fetch_failed" });
    }
  });

  // ── GET /crm/documents/:id/open-url ────────────────────────────────────
  // Returns a short-lived signed URL for opening/downloading an imported document.
  // The signature binds docId + tenantId + userId + expiry (v2).
  // The caller must subsequently fetch the URL with their Bearer token —
  // the /open route requires BOTH auth AND a valid signature.
  app.get("/crm/documents/:id/open-url", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;
    const { id } = req.params as { id: string };

    const doc = await db.crmLeadDocument.findFirst({
      where: { id, tenantId, status: "IMPORTED" },
      select: { storageKey: true },
    });

    if (!doc?.storageKey) {
      return reply.status(404).send({ error: "doc_not_imported", detail: "Document has not been imported yet." });
    }

    const publicBase = process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || "http://localhost:3001";
    // Pass tenantId and userId so the signature is bound to this specific user+tenant.
    const signedUrl = buildSignedCrmDocUrl(publicBase, id, tenantId, userId);

    return { signedUrl };
  });

  // ── GET /crm/documents/:id/open ────────────────────────────────────────
  // Streams an imported document.
  //
  // DUAL GATE — BOTH must pass:
  //   Gate 1: Valid CRM auth JWT (requireCrmAccess) → identifies tenantId + userId
  //   Gate 2: Valid HMAC signature bound to docId + tenantId + userId + expiry (v2)
  //
  // A leaked URL is useless without a matching valid JWT for the same
  // tenant and user. A stolen JWT is useless without a fresh valid signature.
  //
  // Audit events logged (no content, no storage paths, no tokens):
  //   document_opened        — successful stream
  //   document_open_denied   — auth passed but HMAC check failed
  //   expired_link           — signature has expired
  //   invalid_signature      — HMAC mismatch (tampered, wrong tenant/user, or v1 sig)
  //   cross_tenant_attempt   — JWT tenantId does not match document tenantId
  app.get("/crm/documents/:id/open", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return; // 401/403 already sent
    const { tenantId, sub: userId } = user;
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const { exp, sig } = q;

    // Load document — scoped to tenant from JWT (first security gate)
    const doc = await db.crmLeadDocument.findFirst({
      where: { id, tenantId, status: "IMPORTED" },
      select: {
        id: true,
        tenantId: true,
        storageKey: true,
        importedMimeType: true,
        mimeType: true,
        originalFileName: true,
      },
    });

    // If doc not found, it could be not imported, wrong tenant, or non-existent.
    // Check whether the docId exists at all (different tenant) for targeted audit logging.
    if (!doc?.storageKey) {
      // Peek at whether the doc exists for another tenant (cross-tenant detection)
      const otherTenantDoc = await db.crmLeadDocument.findFirst({
        where: { id, status: "IMPORTED" },
        select: { tenantId: true },
      });
      if (otherTenantDoc && otherTenantDoc.tenantId !== tenantId) {
        app.log.warn(
          { docId: id, callerTenantId: tenantId, docTenantId: otherTenantDoc.tenantId },
          "crm_doc_cross_tenant_attempt",
        );
        return reply.status(403).send({ error: "cross_tenant_attempt" });
      }
      return reply.status(404).send({ error: "not_found" });
    }

    // Gate 2: Verify HMAC — bound to docId + tenantId + userId + expiry
    const verified = verifySignedCrmDocUrl(id, tenantId, userId, exp, sig);
    if (!verified.ok) {
      const event = verified.reason === "expired" ? "expired_link" : "invalid_signature";
      const auditCode = verified.reason === "expired" ? "crm_doc_link_expired" : "crm_doc_invalid_signature";
      app.log.warn(
        { docId: id, tenantId, userId, event },
        auditCode,
      );
      return reply.status(verified.reason === "expired" ? 410 : 403).send({
        error: event,
      });
    }

    // Read file from disk
    let buffer: Buffer;
    try {
      buffer = await readCrmDocFile(doc.storageKey);
    } catch {
      app.log.error(
        { docId: id, tenantId, userId },
        "crm_doc_file_not_on_disk",
      );
      return reply.status(404).send({ error: "file_not_found_on_disk" });
    }

    // Structured audit event (no content, no storage path, no tokens)
    app.log.info(
      { docId: id, tenantId, userId, bytes: buffer.length },
      "crm_doc_opened",
    );

    const contentType = contentTypeForCrmDoc(doc.importedMimeType, doc.mimeType, doc.storageKey);
    const safeName = encodeURIComponent(doc.originalFileName || "document");

    reply
      .header("Content-Type", contentType)
      .header("Content-Disposition", `inline; filename="${safeName}"`)
      .header("Content-Length", String(buffer.length))
      .header("Cache-Control", "private, no-store")
      // Prevent MIME-type sniffing attacks
      .header("X-Content-Type-Options", "nosniff")
      .send(buffer);
  });

  // ── GET /crm/documents/:id/status ──────────────────────────────────────
  // Returns the current import status + safe metadata for a single document.
  // Used by the UI to poll after triggering an import.
  app.get("/crm/documents/:id/status", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const doc = await db.crmLeadDocument.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        status: true,
        originalFileName: true,
        mimeType: true,
        importedMimeType: true,
        importedAt: true,
        importError: true,
        sizeBytes: true,
        matchConfidence: true,
        googleDriveFileId: true,
      },
    });

    if (!doc) return reply.status(404).send({ error: "not_found" });

    return {
      id: doc.id,
      status: doc.status,
      originalFileName: doc.originalFileName,
      mimeType: doc.mimeType ?? null,
      importedMimeType: doc.importedMimeType ?? null,
      importedAt: doc.importedAt ?? null,
      importError: doc.importError ?? null,
      sizeBytes: doc.sizeBytes != null ? doc.sizeBytes.toString() : null,
      matchConfidence: doc.matchConfidence ?? null,
      maxImportBytes: getCrmDocMaxBytes(),
    };
  });
}
