/**
 * CRM Contact Discovery Routes — Phase 6
 *
 * Tenant-scoped routes for discovering contact data (phones, emails)
 * from extracted document text and managing user review.
 *
 * Routes:
 *   POST /crm/documents/:id/discover
 *     Run discovery for a single IMPORTED + TEXT_COMPLETE document.
 *
 *   GET  /crm/contacts/:id/discoveries
 *     Get all PENDING (+ optionally ACCEPTED/REJECTED) discoveries for a contact.
 *
 *   POST /crm/discoveries/phones/:id/accept
 *     Accept a phone discovery — creates ContactPhone, marks ACCEPTED.
 *
 *   POST /crm/discoveries/phones/:id/reject
 *     Reject a phone discovery — marks REJECTED, keeps record.
 *
 *   POST /crm/discoveries/emails/:id/accept
 *     Accept an email discovery — creates ContactEmail, marks ACCEPTED.
 *
 *   POST /crm/discoveries/emails/:id/reject
 *     Reject an email discovery — marks REJECTED, keeps record.
 *
 *   POST /crm/import/batches/:batchId/discover
 *     Run discovery for up to 10 eligible docs in a batch.
 *
 *   GET  /crm/import/batches/:batchId/discovery-status
 *     Aggregate discovery counts (pending/accepted/rejected) for phones and emails.
 *
 * Security:
 *   - All routes require requireCrmAccess (tenant JWT).
 *   - Extracted document text is NEVER returned from discovery endpoints.
 *   - Source snippets (≤ 200 chars) are included — never the full text.
 *   - Tenant B cannot read or act on Tenant A's discoveries.
 */

import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import { requireCrmAccess } from "./guard";
import {
  extractDiscoveriesFromDocument,
  extractDiscoveriesForBatch,
  acceptPhoneDiscovery,
  rejectPhoneDiscovery,
  acceptEmailDiscovery,
  rejectEmailDiscovery,
  getBatchDiscoveryStatus,
  ContactDiscoveryError,
} from "./contactDiscoveryService";

export async function registerCrmContactDiscoveryRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /crm/documents/:id/discover ────────────────────────────────────────
  app.post("/crm/documents/:id/discover", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    try {
      const result = await extractDiscoveriesFromDocument(id, tenantId);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      if (err instanceof ContactDiscoveryError) {
        const status =
          err.code === "doc_not_found" || err.code === "doc_no_contact" ? 404
          : err.code === "text_not_extracted" ? 422
          : 422;
        return reply.status(status).send({ error: err.code, detail: err.message });
      }
      app.log.error({ docId: id, tenantId }, "crm_discovery_doc_route_error");
      return reply.status(500).send({ error: "discovery_failed" });
    }
  });

  // ── GET /crm/contacts/:id/discoveries ───────────────────────────────────────
  // Returns all discoveries for a contact, tenant-scoped.
  // Extracted text is NEVER returned — only source snippets (≤200 chars).
  app.get("/crm/contacts/:id/discoveries", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const includeAll = q.includeAll === "true"; // include ACCEPTED + REJECTED

    // Verify contact belongs to tenant
    const contact = await (db as any).contact.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!contact) return reply.status(404).send({ error: "not_found" });

    const statusFilter = includeAll
      ? undefined
      : { status: { in: ["PENDING"] as any } };

    const [phones, emails] = await Promise.all([
      db.crmLeadDiscoveredPhone.findMany({
        where: { contactId: id, tenantId, ...statusFilter },
        select: {
          id: true,
          phoneNumber: true,
          normalizedPhone: true,
          confidence: true,
          sourceSnippet: true,
          sourcePage: true,
          status: true,
          createdAt: true,
          document: { select: { id: true, originalFileName: true } },
        },
        orderBy: [{ confidence: "desc" }, { createdAt: "asc" }],
      }),
      db.crmLeadDiscoveredEmail.findMany({
        where: { contactId: id, tenantId, ...statusFilter },
        select: {
          id: true,
          email: true,
          confidence: true,
          sourceSnippet: true,
          sourcePage: true,
          status: true,
          createdAt: true,
          document: { select: { id: true, originalFileName: true } },
        },
        orderBy: [{ confidence: "desc" }, { createdAt: "asc" }],
      }),
    ]);

    return reply.status(200).send({ contactId: id, phones, emails });
  });

  // ── POST /crm/discoveries/phones/:id/accept ──────────────────────────────────
  app.post("/crm/discoveries/phones/:id/accept", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    try {
      const result = await acceptPhoneDiscovery(id, tenantId);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      if (err instanceof ContactDiscoveryError) {
        const status = err.code === "not_found" ? 404 : 422;
        return reply.status(status).send({ error: err.code, detail: err.message });
      }
      return reply.status(500).send({ error: "accept_failed" });
    }
  });

  // ── POST /crm/discoveries/phones/:id/reject ──────────────────────────────────
  app.post("/crm/discoveries/phones/:id/reject", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    try {
      const result = await rejectPhoneDiscovery(id, tenantId);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      if (err instanceof ContactDiscoveryError) {
        const status = err.code === "not_found" ? 404 : 422;
        return reply.status(status).send({ error: err.code, detail: err.message });
      }
      return reply.status(500).send({ error: "reject_failed" });
    }
  });

  // ── POST /crm/discoveries/emails/:id/accept ──────────────────────────────────
  app.post("/crm/discoveries/emails/:id/accept", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    try {
      const result = await acceptEmailDiscovery(id, tenantId);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      if (err instanceof ContactDiscoveryError) {
        const status = err.code === "not_found" ? 404 : 422;
        return reply.status(status).send({ error: err.code, detail: err.message });
      }
      return reply.status(500).send({ error: "accept_failed" });
    }
  });

  // ── POST /crm/discoveries/emails/:id/reject ──────────────────────────────────
  app.post("/crm/discoveries/emails/:id/reject", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    try {
      const result = await rejectEmailDiscovery(id, tenantId);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      if (err instanceof ContactDiscoveryError) {
        const status = err.code === "not_found" ? 404 : 422;
        return reply.status(status).send({ error: err.code, detail: err.message });
      }
      return reply.status(500).send({ error: "reject_failed" });
    }
  });

  // ── POST /crm/import/batches/:batchId/discover ───────────────────────────────
  app.post("/crm/import/batches/:batchId/discover", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { batchId } = req.params as { batchId: string };
    const body = (req.body as Record<string, unknown>) ?? {};
    const limit = typeof body.limit === "number" ? body.limit : 10;

    try {
      const result = await extractDiscoveriesForBatch(batchId, tenantId, limit);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      if (err instanceof ContactDiscoveryError) {
        const status = err.code === "batch_not_found" ? 404 : 422;
        return reply.status(status).send({ error: err.code, detail: err.message });
      }
      app.log.error({ batchId, tenantId }, "crm_discovery_batch_route_error");
      return reply.status(500).send({ error: "discovery_failed" });
    }
  });

  // ── GET /crm/import/batches/:batchId/discovery-status ───────────────────────
  app.get("/crm/import/batches/:batchId/discovery-status", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { batchId } = req.params as { batchId: string };

    try {
      const status = await getBatchDiscoveryStatus(batchId, tenantId);
      return reply.status(200).send(status);
    } catch (err: unknown) {
      if (err instanceof ContactDiscoveryError) {
        const httpStatus = err.code === "batch_not_found" ? 404 : 422;
        return reply.status(httpStatus).send({ error: err.code, detail: err.message });
      }
      return reply.status(500).send({ error: "status_fetch_failed" });
    }
  });
}
