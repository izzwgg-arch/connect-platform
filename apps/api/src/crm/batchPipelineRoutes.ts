/**
 * CRM Import Batch Pipeline Routes — Phase 8 (hardened)
 *
 * POST /crm/import/batches/:batchId/pipeline/start
 *   Start a new pipeline run. Recovers stale runs first. Returns 409 if already running.
 *
 * POST /crm/import/batches/:batchId/pipeline/continue
 *   Continue the most recent PARTIAL/RUNNING run (or start fresh if none).
 *
 * GET  /crm/import/batches/:batchId/pipeline/status
 *   Get the latest pipeline run status. Returns { run: PipelineRunResult | null }.
 *
 * GET  /crm/import/batches/:batchId/pipeline/runs/:runId
 *   Get a specific pipeline run by id.
 *
 * POST /crm/import/batches/:batchId/pipeline/cancel
 *   Cancel PENDING, RUNNING, or PARTIAL run. No-op on COMPLETE/FAILED/CANCELLED.
 *
 * GET  /crm/import/batches/:batchId/pipeline/health
 *   Health check: stale detection, active run count, hasMore. No sensitive data.
 *
 * All routes require a valid CRM access JWT (tenant-scoped).
 */

import type { FastifyInstance } from "fastify";
import { requireCrmAccess } from "./guard";
import {
  startBatchPipeline,
  continueBatchPipeline,
  getBatchPipelineStatus,
  getPipelineRun,
  cancelBatchPipeline,
  getBatchPipelineHealth,
  PipelineError,
} from "./batchPipelineService";

export async function registerCrmBatchPipelineRoutes(app: FastifyInstance) {
  // ── POST /crm/import/batches/:batchId/pipeline/start ─────────────────────

  app.post("/crm/import/batches/:batchId/pipeline/start", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;

    const { batchId } = req.params as { batchId: string };
    if (!batchId?.trim()) {
      return reply.status(400).send({ error: "batchId_required" });
    }

    try {
      const result = await startBatchPipeline(batchId, tenantId, userId);
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof PipelineError) {
        const status =
          err.code === "batch_not_found"
            ? 404
            : err.code === "already_running"
              ? 409
              : 400;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // ── POST /crm/import/batches/:batchId/pipeline/continue ───────────────────

  app.post("/crm/import/batches/:batchId/pipeline/continue", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;

    const { batchId } = req.params as { batchId: string };
    if (!batchId?.trim()) {
      return reply.status(400).send({ error: "batchId_required" });
    }

    try {
      const result = await continueBatchPipeline(batchId, tenantId, userId);
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof PipelineError) {
        const status = err.code === "batch_not_found" ? 404 : 400;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // ── GET /crm/import/batches/:batchId/pipeline/status ─────────────────────

  app.get("/crm/import/batches/:batchId/pipeline/status", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const { batchId } = req.params as { batchId: string };
    if (!batchId?.trim()) {
      return reply.status(400).send({ error: "batchId_required" });
    }

    try {
      const result = await getBatchPipelineStatus(batchId, tenantId);
      return reply.status(200).send({ run: result });
    } catch (err) {
      if (err instanceof PipelineError && err.code === "batch_not_found") {
        return reply.status(404).send({ error: "batch_not_found" });
      }
      throw err;
    }
  });

  // ── GET /crm/import/batches/:batchId/pipeline/runs/:runId ─────────────────

  app.get("/crm/import/batches/:batchId/pipeline/runs/:runId", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const { batchId, runId } = req.params as { batchId: string; runId: string };
    if (!batchId?.trim() || !runId?.trim()) {
      return reply.status(400).send({ error: "batchId_and_runId_required" });
    }

    try {
      const result = await getPipelineRun(runId, batchId, tenantId);
      if (!result) {
        return reply.status(404).send({ error: "run_not_found" });
      }
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof PipelineError && err.code === "batch_not_found") {
        return reply.status(404).send({ error: "batch_not_found" });
      }
      throw err;
    }
  });

  // ── POST /crm/import/batches/:batchId/pipeline/cancel ────────────────────
  // Cancels PENDING, RUNNING, or PARTIAL runs.
  // Returns { cancelled: false, reason: "no_cancellable_run" } when nothing to cancel.

  app.post("/crm/import/batches/:batchId/pipeline/cancel", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const { batchId } = req.params as { batchId: string };
    if (!batchId?.trim()) {
      return reply.status(400).send({ error: "batchId_required" });
    }

    try {
      const result = await cancelBatchPipeline(batchId, tenantId);
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof PipelineError && err.code === "batch_not_found") {
        return reply.status(404).send({ error: "batch_not_found" });
      }
      throw err;
    }
  });

  // ── GET /crm/import/batches/:batchId/pipeline/health ─────────────────────
  // Returns pipeline health indicators. No sensitive data (no doc text, no keys).

  app.get("/crm/import/batches/:batchId/pipeline/health", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const { batchId } = req.params as { batchId: string };
    if (!batchId?.trim()) {
      return reply.status(400).send({ error: "batchId_required" });
    }

    try {
      const result = await getBatchPipelineHealth(batchId, tenantId);
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof PipelineError && err.code === "batch_not_found") {
        return reply.status(404).send({ error: "batch_not_found" });
      }
      throw err;
    }
  });
}
