import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createProductionStorageScannerDeps } from "./dockerDeps";
import {
  generateCleanupPlanFromLatestScan,
  getLatestCleanupPlan,
  getStorageAuditHistory,
  getStorageHealthSnapshot,
  queueStorageScan,
  refuseStorageCleanupApproval,
  refuseStorageCleanupExecution,
} from "./service";

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

  app.post("/admin/storage-health/approve", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply);
    if (!admin) return;
    try {
      refuseStorageCleanupApproval(admin.sub);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "not_implemented";
      return reply.status(501).send({
        error: msg,
        detail: "Phase 2 only. Cleanup approval is not enabled in Phase 1 (read-only).",
      });
    }
  });

  app.post("/admin/storage-health/execute", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply);
    if (!admin) return;
    try {
      refuseStorageCleanupExecution(admin.sub);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "forbidden";
      return reply.status(403).send({
        error: msg,
        detail: "Phase 1 is read-only. No cleanup execution is permitted.",
      });
    }
  });

  app.get("/admin/storage-health/executions", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply);
    if (!admin) return;
    return reply.send({ executions: [] });
  });
}
