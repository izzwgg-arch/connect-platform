/**
 * CRM Batch Diagnostics Routes
 *
 * GET /crm/import/batches/:batchId/diagnostics
 *   Full diagnostics view: batch overview, pipeline, document/extraction/discovery/AI counts,
 *   health score, warnings, and failures.
 *
 * GET /crm/import/batches/:batchId/diagnostics/failures
 *   Categorized failures only.
 *
 * GET /crm/import/batches/:batchId/diagnostics/timeline
 *   Step-by-step pipeline timeline from the latest run.
 *
 * GET /crm/import/batches/:batchId/diagnostics/support-bundle
 *   Safe JSON export for internal support. Never includes doc text, prompts, keys, or paths.
 *
 * All routes:
 *   - Require a valid CRM access JWT (tenant-scoped, requireCrmAccess).
 *   - Return 404 batch_not_found for unknown or cross-tenant batch IDs.
 *   - Return no sensitive data (no doc text, no storage paths, no AI prompts, no keys).
 */

import type { FastifyInstance } from "fastify";
import { requireCrmAccess } from "./guard";
import {
  getBatchDiagnostics,
  getBatchFailures,
  getBatchTimeline,
  getSupportBundle,
  DiagnosticsError,
} from "./batchDiagnosticsService";

export async function registerCrmBatchDiagnosticsRoutes(app: FastifyInstance) {
  // ── GET /crm/import/batches/:batchId/diagnostics ──────────────────────────

  app.get("/crm/import/batches/:batchId/diagnostics", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const { batchId } = req.params as { batchId: string };
    if (!batchId?.trim()) {
      return reply.status(400).send({ error: "batchId_required" });
    }

    try {
      const result = await getBatchDiagnostics(batchId, tenantId);
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof DiagnosticsError && err.code === "batch_not_found") {
        return reply.status(404).send({ error: "batch_not_found" });
      }
      throw err;
    }
  });

  // ── GET /crm/import/batches/:batchId/diagnostics/failures ─────────────────

  app.get("/crm/import/batches/:batchId/diagnostics/failures", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const { batchId } = req.params as { batchId: string };
    if (!batchId?.trim()) {
      return reply.status(400).send({ error: "batchId_required" });
    }

    try {
      const failures = await getBatchFailures(batchId, tenantId);
      return reply.status(200).send({ failures });
    } catch (err) {
      if (err instanceof DiagnosticsError && err.code === "batch_not_found") {
        return reply.status(404).send({ error: "batch_not_found" });
      }
      throw err;
    }
  });

  // ── GET /crm/import/batches/:batchId/diagnostics/timeline ─────────────────

  app.get("/crm/import/batches/:batchId/diagnostics/timeline", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const { batchId } = req.params as { batchId: string };
    if (!batchId?.trim()) {
      return reply.status(400).send({ error: "batchId_required" });
    }

    try {
      const timeline = await getBatchTimeline(batchId, tenantId);
      return reply.status(200).send(timeline);
    } catch (err) {
      if (err instanceof DiagnosticsError && err.code === "batch_not_found") {
        return reply.status(404).send({ error: "batch_not_found" });
      }
      throw err;
    }
  });

  // ── GET /crm/import/batches/:batchId/diagnostics/support-bundle ───────────

  app.get("/crm/import/batches/:batchId/diagnostics/support-bundle", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const { batchId } = req.params as { batchId: string };
    if (!batchId?.trim()) {
      return reply.status(400).send({ error: "batchId_required" });
    }

    try {
      const bundle = await getSupportBundle(batchId, tenantId);
      return reply
        .status(200)
        .header("Content-Disposition", `attachment; filename="support-bundle-${batchId}.json"`)
        .send(bundle);
    } catch (err) {
      if (err instanceof DiagnosticsError && err.code === "batch_not_found") {
        return reply.status(404).send({ error: "batch_not_found" });
      }
      throw err;
    }
  });
}
