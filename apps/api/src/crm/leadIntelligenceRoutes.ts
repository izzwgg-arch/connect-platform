/**
 * CRM Lead Intelligence Routes — Phase 7 / 7B
 *
 * All routes are tenant-scoped and require CRM access.
 * Advisory output only — no contact data is modified by any route here.
 *
 * Routes:
 *   POST /crm/contacts/:id/intelligence
 *     Generate (or return existing) intelligence report for a contact.
 *     Body: { force?: boolean }
 *     Response: { reportId, status, skipped?, cooldownActive?, retryAfterMs?, retryAfterMessage? }
 *     Note: CRM admin users bypass regeneration cooldown.
 *
 *   GET  /crm/contacts/:id/intelligence
 *     Retrieve the latest intelligence report for a contact.
 *     Returns null if no report exists yet.
 *
 *   POST /crm/import/batches/:batchId/intelligence
 *     Generate intelligence for up to N contacts in a batch (respects tenant limits).
 *     Body: { force?: boolean, limit?: number }
 *     Response: { contactsProcessed, complete, failed, skipped_existing, skipped_limit }
 *
 *   GET  /crm/import/batches/:batchId/intelligence-status
 *     Aggregate status counts for contacts in a batch.
 *     Response: { pending, processing, complete, failed, noReport }
 *
 * Security:
 *   - All routes require requireCrmAccess (tenant JWT).
 *   - Tenant B cannot read or generate Tenant A's reports.
 *   - No raw document text is returned in any response.
 *   - No secrets or API keys are included in responses or logs.
 *   - CRM admin role is passed to the service for cooldown bypass.
 */

import type { FastifyInstance } from "fastify";
import { requireCrmAccess, isAdminRole } from "./guard";
import { assertCrmContactAllowed } from "./crmContactAccess";
import {
  generateIntelligenceReport,
  getIntelligenceReport,
  generateBatchIntelligence,
  getBatchIntelligenceStatus,
  LeadIntelligenceError,
} from "./leadIntelligenceService";
import {
  getLeadDocumentSummary,
  LeadDocumentSummaryError,
  sanitizeSummaryForResponse,
} from "./leadDocumentSummaryService";

export async function registerCrmLeadIntelligenceRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /crm/contacts/:id/intelligence ─────────────────────────────────────
  app.post("/crm/contacts/:id/intelligence", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, role } = user;
    const { id } = req.params as { id: string };
    const body = (req.body as Record<string, unknown>) ?? {};
    const force = body.force === true;
    const adminUser = isAdminRole(role);

    try {
      const result = await generateIntelligenceReport(id, tenantId, {
        force,
        isAdmin: adminUser,
      });
      return reply.status(200).send(result);
    } catch (err: unknown) {
      if (err instanceof LeadIntelligenceError) {
        const status =
          err.code === "contact_not_found" ? 404
          : err.code === "ai_not_configured" ? 503
          : err.code === "cooldown_active" ? 429
          : err.code === "ai_disabled" ? 403
          : 422;
        const body: Record<string, unknown> = { error: err.code, detail: err.message };
        if (err.retryAfterMs !== undefined) body.retryAfterMs = err.retryAfterMs;
        return reply.status(status).send(body);
      }
      app.log.error({ contactId: id, tenantId }, "crm_intelligence_generate_error");
      return reply.status(500).send({ error: "generation_failed" });
    }
  });

  // ── GET /crm/contacts/:id/document-summary ────────────────────────────────────
  // Merged verified contact fields + document-extracted profile (SSN masked only).
  app.get("/crm/contacts/:id/document-summary", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    if (!(await assertCrmContactAllowed(user, id, reply))) return;

    try {
      const summary = await getLeadDocumentSummary(id, tenantId);
      return reply.status(200).send({ summary: sanitizeSummaryForResponse(summary) });
    } catch (err: unknown) {
      if (err instanceof LeadDocumentSummaryError) {
        const status = err.code === "contact_not_found" ? 404 : 422;
        return reply.status(status).send({ error: err.code, detail: err.message });
      }
      app.log.error({ contactId: id, tenantId }, "crm_document_summary_error");
      return reply.status(500).send({ error: "summary_fetch_failed" });
    }
  });

  // ── GET /crm/contacts/:id/intelligence ──────────────────────────────────────
  app.get("/crm/contacts/:id/intelligence", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    try {
      const report = await getIntelligenceReport(id, tenantId);
      return reply.status(200).send({ report: report ?? null });
    } catch (err: unknown) {
      if (err instanceof LeadIntelligenceError) {
        const status = err.code === "contact_not_found" ? 404 : 422;
        return reply.status(status).send({ error: err.code, detail: err.message });
      }
      return reply.status(500).send({ error: "fetch_failed" });
    }
  });

  // ── POST /crm/import/batches/:batchId/intelligence ───────────────────────────
  app.post("/crm/import/batches/:batchId/intelligence", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, role } = user;
    const { batchId } = req.params as { batchId: string };
    const body = (req.body as Record<string, unknown>) ?? {};
    const force = body.force === true;
    const limit = typeof body.limit === "number" ? body.limit : 5;
    const adminUser = isAdminRole(role);

    try {
      const result = await generateBatchIntelligence(batchId, tenantId, limit, force, adminUser);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      if (err instanceof LeadIntelligenceError) {
        const status =
          err.code === "batch_not_found" ? 404
          : err.code === "ai_not_configured" ? 503
          : err.code === "ai_disabled" ? 403
          : err.code === "batch_generation_disabled" ? 403
          : 422;
        return reply.status(status).send({ error: err.code, detail: err.message });
      }
      app.log.error({ batchId, tenantId }, "crm_intelligence_batch_error");
      return reply.status(500).send({ error: "batch_generation_failed" });
    }
  });

  // ── GET /crm/import/batches/:batchId/intelligence-status ─────────────────────
  app.get("/crm/import/batches/:batchId/intelligence-status", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { batchId } = req.params as { batchId: string };

    try {
      const status = await getBatchIntelligenceStatus(batchId, tenantId);
      return reply.status(200).send(status);
    } catch (err: unknown) {
      if (err instanceof LeadIntelligenceError) {
        const httpStatus = err.code === "batch_not_found" ? 404 : 422;
        return reply.status(httpStatus).send({ error: err.code, detail: err.message });
      }
      return reply.status(500).send({ error: "status_fetch_failed" });
    }
  });
}
