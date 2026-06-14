import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createProductionStorageScannerDeps } from "./dockerDeps";
import {
  approveStorageCleanupPlan,
  executeStorageCleanupStage,
  generateCleanupPlanFromLatestScan,
  getBuildKitInvestigation,
  getLatestCleanupPlan,
  getStorageAuditHistory,
  getStorageHealthSnapshot,
  isStorageScanInProgress,
  prepareStorageCleanup,
  queuePreflightSnapshot,
  queueStorageScan,
  refuseStorageCleanupApproval,
} from "./service";
import type { CleanupStage } from "./types";

type AdminActor = { sub: string; email?: string | null };

export function registerStorageMaintenanceRoutes(
  app: FastifyInstance,
  requireSuperAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<AdminActor | null>,
): void {
  const scannerDeps = createProductionStorageScannerDeps();

  app.get("/admin/storage-health", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply);
    if (!admin) return;
    return reply.send(getStorageHealthSnapshot());
  });

  app.post("/admin/storage-health/scan", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply);
    if (!admin) return;
    const result = queueStorageScan(scannerDeps, admin.sub);
    return reply.status(202).send(result);
  });

  app.get("/admin/storage-health/history", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply);
    if (!admin) return;
    return reply.send({ scans: getStorageHealthSnapshot().previousScans });
  });

  app.get("/admin/storage-health/audit", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply);
    if (!admin) return;
    const qs = req.query as { limit?: string };
    const limit = Math.min(200, Math.max(1, Number(qs.limit) || 50));
    return reply.send({ events: getStorageAuditHistory(limit) });
  });

  app.post("/admin/storage-health/plan", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply);
    if (!admin) return;
    try {
      const plan = generateCleanupPlanFromLatestScan(admin.sub);
      return reply.send(plan);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "plan_failed";
      if (msg === "storage_scan_required") {
        return reply.status(409).send({ error: msg, detail: "Run Scan Now before generating a cleanup plan." });
      }
      return reply.status(500).send({ error: "storage_plan_failed", detail: msg });
    }
  });

  app.get("/admin/storage-health/plan", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply);
    if (!admin) return;
    const plan = getLatestCleanupPlan();
    if (!plan) return reply.status(404).send({ error: "no_cleanup_plan", detail: "Generate a plan after scanning." });
    return reply.send(plan);
  });

  app.post("/admin/storage-health/snapshot", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply);
    if (!admin) return;
    const result = queuePreflightSnapshot(admin.sub);
    if (!result.accepted) {
      return reply.status(409).send({ error: "storage_scan_required", detail: "Run Scan Now before generating a snapshot." });
    }
    return reply.status(202).send(result);
  });

  app.post("/admin/storage-health/prepare-cleanup", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply);
    if (!admin) return;
    try {
      const result = await prepareStorageCleanup(scannerDeps, admin.sub);
      return reply.status(201).send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "prepare_failed";
      const status = msg.includes("disabled") ? 403 : msg.includes("gate") ? 412 : 409;
      return reply.status(status).send({ error: msg });
    }
  });

  app.get("/admin/storage-health/investigation/buildkit", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply);
    if (!admin) return;
    try {
      const investigation = await getBuildKitInvestigation(scannerDeps);
      return reply.send(investigation);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "investigation_failed";
      return reply.status(500).send({ error: msg });
    }
  });

  app.post("/admin/storage-health/approve", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply);
    if (!admin) return;
    const body = (req.body ?? {}) as { planId?: string };
    if (!body.planId) {
      return reply.status(400).send({ error: "plan_id_required" });
    }
    try {
      const result = approveStorageCleanupPlan(scannerDeps, admin.sub, body.planId);
      return reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "approve_failed";
      if (msg === "storage_cleanup_approval_not_enabled") {
        try {
          refuseStorageCleanupApproval(admin.sub);
        } catch {
          return reply.status(501).send({ error: msg, detail: "Set STORAGE_CLEANUP_ENABLED=1 to enable Phase 5 cleanup." });
        }
      }
      return reply.status(409).send({ error: msg });
    }
  });

  app.post("/admin/storage-health/execute", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply);
    if (!admin) return;
    const body = (req.body ?? {}) as { stage?: number };
    const stage = Number(body.stage) as CleanupStage;
    if (![1, 2, 3, 4].includes(stage)) {
      return reply.status(400).send({ error: "invalid_stage", detail: "stage must be 1, 2, 3, or 4" });
    }
    if (isStorageScanInProgress()) {
      return reply.status(409).send({ error: "storage_scan_in_progress" });
    }
    try {
      const record = await executeStorageCleanupStage(scannerDeps, admin.sub, stage);
      return reply.status(200).send(record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "execute_failed";
      const status = msg.includes("disabled") ? 403 : msg.includes("stopped") || msg.includes("gate") ? 412 : 409;
      return reply.status(status).send({ error: msg, executions: getStorageHealthSnapshot().executions });
    }
  });

  app.get("/admin/storage-health/executions", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply);
    if (!admin) return;
    return reply.send({ executions: getStorageHealthSnapshot().executions });
  });
}
