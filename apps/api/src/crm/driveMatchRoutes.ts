/**
 * CRM Drive Match Routes — Phase 2
 *
 * API endpoints for Drive file ↔ contact matching:
 *   POST /crm/drive/match/run          — run the match engine for a batch
 *   GET  /crm/drive/match/results      — list match results (CrmLeadDocument) for a batch
 *   POST /crm/drive/match/:docId/confirm — confirm a match → IMPORT_PENDING
 *   POST /crm/drive/match/:docId/reject  — reject a match  → REJECTED
 *   GET  /crm/contacts/:id/documents    — list attached documents for a contact
 *
 * All routes require a valid tenant JWT via requireCrmAccess.
 * Strict tenant isolation enforced on every DB query.
 */

import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import { requireCrmAccess } from "./guard";
import {
  runDriveMatchForBatch,
  DriveMatchError,
} from "./driveMatchService";

export async function registerCrmDriveMatchRoutes(app: FastifyInstance) {
  // ── POST /crm/drive/match/run ─────────────────────────────────────────────
  // Triggers the Drive matching engine for the given import batch.
  // Returns a summary: files scanned, matches created, ambiguous, unmatched.
  app.post("/crm/drive/match/run", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const body = req.body as Record<string, unknown>;
    const batchId = typeof body?.batchId === "string" ? body.batchId.trim() : "";
    if (!batchId) {
      return reply.status(400).send({ error: "batchId_required" });
    }

    try {
      const result = await runDriveMatchForBatch(batchId, tenantId);
      return reply.status(200).send(result);
    } catch (err: any) {
      if (err instanceof DriveMatchError) {
        const status =
          err.code === "batch_not_found" ? 404
          : err.code === "no_drive_folder" ? 409
          : err.code === "no_audit_rows" ? 422
          : 502;
        return reply.status(status).send({ error: err.code, detail: err.message });
      }
      app.log.error(err, "Drive match run failed");
      return reply.status(500).send({ error: "match_run_failed" });
    }
  });

  // ── GET /crm/drive/match/results ──────────────────────────────────────────
  // Returns all CrmLeadDocument records for a batch, grouped by status.
  // Query params: batchId (required)
  app.get("/crm/drive/match/results", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const q = req.query as Record<string, string>;
    const batchId = q.batchId?.trim();
    if (!batchId) {
      return reply.status(400).send({ error: "batchId_required" });
    }

    // Verify batch belongs to tenant — also fetch audit health fields
    const [batch, auditRowCount] = await Promise.all([
      db.crmImportBatch.findFirst({
        where: { id: batchId, tenantId },
        select: {
          id: true,
          fileName: true,
          status: true,
          totalRows: true,
          auditErrorCount: true,
          createdAt: true,
          completedAt: true,
        },
      }),
      db.crmImportBatchRow.count({ where: { batchId, tenantId } }),
    ]);
    if (!batch) return reply.status(404).send({ error: "batch_not_found" });

    const docs = await db.crmLeadDocument.findMany({
      where: { tenantId, importBatchId: batchId },
      orderBy: { createdAt: "asc" },
      include: {
        contact: {
          select: {
            id: true,
            displayName: true,
            company: true,
          },
        },
      },
    });

    // Load unmatched companies from import rows
    const allRows = await db.crmImportBatchRow.findMany({
      where: { batchId, tenantId, companyNameNormalized: { not: null } },
      select: { contactId: true, companyName: true, action: true },
    });
    const matchedContactIds = new Set(
      docs.filter((d) => d.contactId).map((d) => d.contactId!),
    );
    const unmatchedRows = allRows.filter(
      (r) => r.contactId && !matchedContactIds.has(r.contactId),
    );

    // Audit health summary — used by the UI to show readiness warnings
    const auditHealthy = auditRowCount > 0 || batch.totalRows === 0;
    const auditWarning = !auditHealthy
      ? `Batch has ${batch.totalRows} rows but only ${auditRowCount} audit records. ` +
        "Drive matching may be incomplete. Re-import the file to recover."
      : batch.auditErrorCount > 0
        ? `${batch.auditErrorCount} audit row write(s) failed during import. ` +
          "Some companies may not appear in Drive match results."
        : null;

    return {
      batch: {
        id: batch.id,
        fileName: batch.fileName,
        status: batch.status,
        totalRows: batch.totalRows,
        auditRowCount,
        auditErrorCount: batch.auditErrorCount,
        auditWarning,
        createdAt: batch.createdAt,
        completedAt: batch.completedAt,
      },
      documents: docs.map(formatLeadDocument),
      unmatchedCompanies: unmatchedRows.map((r) => r.companyName).filter(Boolean),
    };
  });

  // ── POST /crm/drive/match/:docId/confirm ─────────────────────────────────
  // User confirms a DISCOVERED match → status becomes IMPORT_PENDING.
  // Works for both HIGH/MEDIUM and AMBIGUOUS matches.
  app.post("/crm/drive/match/:docId/confirm", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;
    const { docId } = req.params as { docId: string };

    const doc = await db.crmLeadDocument.findFirst({
      where: { id: docId, tenantId },
      select: { id: true, status: true, contactId: true },
    });
    if (!doc) return reply.status(404).send({ error: "document_not_found" });
    if (doc.status !== "DISCOVERED") {
      return reply.status(409).send({
        error: "invalid_status",
        detail: `Document is ${doc.status}, must be DISCOVERED to confirm.`,
      });
    }

    const updated = await db.crmLeadDocument.update({
      where: { id: docId },
      data: {
        status: "IMPORT_PENDING",
        reviewedByUserId: userId,
        reviewedAt: new Date(),
      },
    });

    return reply.status(200).send(formatLeadDocument(updated));
  });

  // ── POST /crm/drive/match/:docId/reject ───────────────────────────────────
  // User rejects a DISCOVERED match → status becomes REJECTED.
  app.post("/crm/drive/match/:docId/reject", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;
    const { docId } = req.params as { docId: string };

    const doc = await db.crmLeadDocument.findFirst({
      where: { id: docId, tenantId },
      select: { id: true, status: true },
    });
    if (!doc) return reply.status(404).send({ error: "document_not_found" });
    if (doc.status !== "DISCOVERED") {
      return reply.status(409).send({
        error: "invalid_status",
        detail: `Document is ${doc.status}, must be DISCOVERED to reject.`,
      });
    }

    const updated = await db.crmLeadDocument.update({
      where: { id: docId },
      data: {
        status: "REJECTED",
        reviewedByUserId: userId,
        reviewedAt: new Date(),
      },
    });

    return reply.status(200).send(formatLeadDocument(updated));
  });

  // ── GET /crm/contacts/:id/documents ──────────────────────────────────────
  // Lists all CrmLeadDocument records attached to a contact.
  // Filters to non-rejected by default; pass ?includeRejected=1 to include them.
  app.get("/crm/contacts/:id/documents", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id: contactId } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const includeRejected = q.includeRejected === "1";

    // Verify contact belongs to tenant
    const contact = await db.contact.findFirst({
      where: { id: contactId, tenantId },
      select: { id: true },
    });
    if (!contact) return reply.status(404).send({ error: "contact_not_found" });

    const docs = await db.crmLeadDocument.findMany({
      where: {
        tenantId,
        contactId,
        ...(includeRejected ? {} : { status: { not: "REJECTED" } }),
      },
      orderBy: { createdAt: "desc" },
    });

    return { documents: docs.map(formatLeadDocument) };
  });
}

// ── Formatters ────────────────────────────────────────────────────────────────

function formatLeadDocument(doc: any) {
  return {
    id: doc.id,
    contactId: doc.contactId ?? null,
    contact: doc.contact
      ? {
          id: doc.contact.id,
          displayName: doc.contact.displayName,
          company: doc.contact.company ?? null,
        }
      : undefined,
    importBatchId: doc.importBatchId ?? null,
    source: doc.source,
    googleDriveFileId: doc.googleDriveFileId ?? null,
    googleDriveFolderId: doc.googleDriveFolderId ?? null,
    originalFileName: doc.originalFileName,
    mimeType: doc.mimeType ?? null,
    sizeBytes: doc.sizeBytes != null ? Number(doc.sizeBytes) : null,
    status: doc.status,
    matchConfidence: doc.matchConfidence ?? null,
    matchReason: doc.matchReason ?? null,
    reviewedAt: doc.reviewedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    // "Open in Drive" link — safe: this is Google's own public webViewLink prefix
    driveViewUrl: doc.googleDriveFileId
      ? `https://drive.google.com/file/d/${doc.googleDriveFileId}/view`
      : null,
  };
}
