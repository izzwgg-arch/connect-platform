/**
 * Creative Studio — the platform-staff console API.
 *
 * Everything here is SUPER_ADMIN only and crosses companies by design: it is
 * how we see what the whole platform is doing. The one rule that survives that:
 * it reports counts, costs and timings — never a customer's prompt, picture or
 * project content.
 */
import { z } from "zod";
import { SEED_ENGINES, seedEngines } from "./engines";
import { periodOf, dayOf, DEFAULT_QUOTA } from "./jobs";

type Deps = { app: any; db: any; requireOwner: (req: any, reply: any) => Promise<any | undefined> };

export function registerCreativeAdminRoutes({ app, db, requireOwner }: Deps): void {
  /* ---------------------------------------------------------------- */
  /* dashboard                                                         */
  /* ---------------------------------------------------------------- */
  app.get("/admin/creative/overview", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const since = new Date(Date.now() - 24 * 3600_000);
    const monthStart = `${periodOf()}`;

    const [todayJobs, running, queued, failed, engines, workers, usageMonth, usageToday, recentFailures] = await Promise.all([
      db.creativeJob.count({ where: { createdAt: { gte: since } } }),
      db.creativeJob.count({ where: { status: { in: ["claimed", "running", "evaluating"] } } }),
      db.creativeJob.count({ where: { status: "queued" } }),
      db.creativeJob.count({ where: { status: "failed", createdAt: { gte: since } } }),
      db.creativeEngine.findMany({ orderBy: { sortOrder: "asc" } }),
      db.creativeWorker.findMany({ orderBy: { lastHeartbeatAt: "desc" }, take: 20 }),
      db.creativeUsage.aggregate({ where: { period: monthStart }, _sum: { costMicros: true } }),
      db.creativeUsage.aggregate({ where: { createdAt: { gte: since } }, _sum: { costMicros: true } }),
      db.creativeJob.findMany({ where: { status: "failed" }, orderBy: { finishedAt: "desc" }, take: 8, select: { id: true, tenantId: true, capability: true, error: true, errorCode: true, finishedAt: true } }),
    ]);

    const durations = await db.creativeGeneration.findMany({ where: { createdAt: { gte: since }, renderMs: { not: null } }, select: { renderMs: true }, take: 500 });
    const sorted = durations.map((d: any) => d.renderMs).sort((a: number, b: number) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;

    return reply.send({
      jobs: { today: todayJobs, running, queued, failedToday: failed, failureRate: todayJobs ? failed / todayJobs : 0 },
      spend: { monthMicros: usageMonth._sum.costMicros || 0, todayMicros: usageToday._sum.costMicros || 0 },
      timing: { medianMs: median, p95Ms: p95 },
      engines: engines.map((e: any) => ({ id: e.id, label: e.label, enabled: e.enabled, isDefault: e.isDefault, commercialOk: e.commercialOk, capabilities: e.capabilities, license: e.license, placement: e.placement })),
      workers: workers.map((w: any) => ({ id: w.id, pool: w.pool, kind: w.kind, status: w.status, lastHeartbeatAt: w.lastHeartbeatAt, currentJobId: w.currentJobId, version: w.version })),
      recentFailures,
    });
  });

  /* ---------------------------------------------------------------- */
  /* engines                                                           */
  /* ---------------------------------------------------------------- */
  app.get("/admin/creative/engines", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const [engines, stats] = await Promise.all([
      db.creativeEngine.findMany({ orderBy: { sortOrder: "asc" } }),
      db.creativeEngineStat.findMany({ where: { day: { gte: dayOf(new Date(Date.now() - 30 * 24 * 3600_000)) } } }),
    ]);
    const byEngine = new Map<string, { runs: number; failures: number; totalMs: number; cost: number }>();
    for (const s of stats) {
      const cur = byEngine.get(s.engineId) || { runs: 0, failures: 0, totalMs: 0, cost: 0 };
      cur.runs += s.runs; cur.failures += s.failures; cur.totalMs += s.totalMs; cur.cost += s.totalCostMicros;
      byEngine.set(s.engineId, cur);
    }
    return reply.send({
      engines: engines.map((e: any) => {
        const s = byEngine.get(e.id);
        return {
          ...e,
          stats: s ? { runs: s.runs, failures: s.failures, avgMs: s.runs ? Math.round(s.totalMs / s.runs) : 0, costMicros: s.cost } : { runs: 0, failures: 0, avgMs: 0, costMicros: 0 },
        };
      }),
      seedCount: SEED_ENGINES.length,
    });
  });

  app.patch("/admin/creative/engines/:id", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const engine = await db.creativeEngine.findUnique({ where: { id: String(req.params.id) } });
    if (!engine) return reply.code(404).send({ error: "not_found" });
    const body = z.object({ enabled: z.boolean().optional(), isDefault: z.boolean().optional(), notes: z.string().max(500).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });

    // ⛔ The licence gate. An engine we may not sell with cannot be switched
    // on, whoever is asking and whatever the UI offered.
    if (body.data.enabled === true && !engine.commercialOk) {
      return reply.code(422).send({
        error: "licence_forbids",
        reason: `${engine.label} cannot be enabled: its licence (${engine.license}) does not permit using it in work we sell to customers.`,
      });
    }
    if (body.data.isDefault) {
      await db.creativeEngine.updateMany({ where: { id: { not: engine.id }, capabilities: { hasSome: engine.capabilities } }, data: { isDefault: false } });
    }
    const updated = await db.creativeEngine.update({ where: { id: engine.id }, data: { ...body.data } });
    await db.creativeAuditEvent.create({
      data: { tenantId: null, actorType: "user", actorId: String(user.sub || ""), action: "creative.engine.updated", targetType: "CreativeEngine", targetId: engine.id, detail: body.data as any, ip: req.ip },
    }).catch(() => undefined);
    return reply.send({ engine: updated });
  });

  app.post("/admin/creative/engines/reseed", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    await seedEngines(db);
    const engines = await db.creativeEngine.findMany({ orderBy: { sortOrder: "asc" } });
    return reply.send({ ok: true, engines });
  });

  /* ---------------------------------------------------------------- */
  /* workers + queue                                                   */
  /* ---------------------------------------------------------------- */
  app.get("/admin/creative/workers", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const workers = await db.creativeWorker.findMany({ orderBy: { lastHeartbeatAt: "desc" } });
    const stale = Date.now() - 90_000;
    return reply.send({
      workers: workers.map((w: any) => ({
        ...w,
        live: w.lastHeartbeatAt ? new Date(w.lastHeartbeatAt).getTime() > stale : false,
      })),
    });
  });

  app.get("/admin/creative/jobs", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const q = (req.query || {}) as any;
    const where: any = {};
    if (q.status) where.status = String(q.status);
    if (q.tenantId) where.tenantId = String(q.tenantId);
    const [jobs, tenants] = await Promise.all([
      db.creativeJob.findMany({ where, orderBy: { createdAt: "desc" }, take: Math.min(200, Number(q.limit || 60)) }),
      db.tenant.findMany({ select: { id: true, name: true } }),
    ]);
    const nameOf = new Map(tenants.map((t: any) => [t.id, t.name]));
    return reply.send({
      jobs: jobs.map((j: any) => ({
        id: j.id, tenantId: j.tenantId, tenantName: nameOf.get(j.tenantId) || j.tenantId,
        capability: j.capability, status: j.status, progress: j.progress, note: j.progressNote,
        engineId: j.engineId, workerId: j.workerId, attempts: j.attempts, costMicros: j.costMicros,
        error: j.error, errorCode: j.errorCode, createdAt: j.createdAt, finishedAt: j.finishedAt,
      })),
    });
  });

  app.post("/admin/creative/jobs/:id/retry", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const job = await db.creativeJob.findUnique({ where: { id: String(req.params.id) } });
    if (!job) return reply.code(404).send({ error: "not_found" });
    if (!["failed", "cancelled"].includes(job.status)) return reply.code(409).send({ error: "not_finished" });
    await db.creativeJob.update({ where: { id: job.id }, data: { status: "queued", error: null, errorCode: null, attempts: 0, progress: 0, finishedAt: null, cancelledAt: null, workerId: null, leaseExpiresAt: null } });
    return reply.send({ ok: true });
  });

  /* ---------------------------------------------------------------- */
  /* usage + quotas                                                    */
  /* ---------------------------------------------------------------- */
  app.get("/admin/creative/usage", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const period = String((req.query as any)?.period || periodOf());
    const [byTenant, byCapability, byMeasure, tenants, wasted] = await Promise.all([
      db.creativeUsage.groupBy({ by: ["tenantId"], where: { period }, _sum: { costMicros: true }, _count: { _all: true } }),
      db.creativeUsage.groupBy({ by: ["capability"], where: { period }, _sum: { costMicros: true } }),
      db.creativeUsage.groupBy({ by: ["measure"], where: { period }, _sum: { quantity: true, costMicros: true } }),
      db.tenant.findMany({ select: { id: true, name: true } }),
      db.creativeUsage.aggregate({ where: { period, wasted: true }, _sum: { costMicros: true } }),
    ]);
    const nameOf = new Map(tenants.map((t: any) => [t.id, t.name]));
    return reply.send({
      period,
      byTenant: byTenant.map((r: any) => ({ tenantId: r.tenantId, tenantName: nameOf.get(r.tenantId) || r.tenantId, costMicros: r._sum.costMicros || 0, events: r._count._all })).sort((a: any, b: any) => b.costMicros - a.costMicros),
      byCapability: byCapability.map((r: any) => ({ capability: r.capability, costMicros: r._sum.costMicros || 0 })),
      byMeasure: byMeasure.map((r: any) => ({ measure: r.measure, quantity: r._sum.quantity || 0, costMicros: r._sum.costMicros || 0 })),
      wastedMicros: wasted._sum.costMicros || 0,
    });
  });

  app.get("/admin/creative/quotas", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const [quotas, tenants, usage] = await Promise.all([
      db.creativeQuota.findMany(),
      db.tenant.findMany({ select: { id: true, name: true } }),
      db.creativeUsage.groupBy({ by: ["tenantId", "measure"], where: { period: periodOf() }, _sum: { quantity: true } }),
    ]);
    const quotaOf = new Map<string, any>(quotas.map((q: any) => [String(q.tenantId), q]));
    return reply.send({
      defaults: DEFAULT_QUOTA,
      tenants: tenants.map((t: any) => {
        const q = quotaOf.get(t.id);
        const usedVideo = usage.find((u: any) => u.tenantId === t.id && u.measure === "video_seconds")?._sum?.quantity || 0;
        const usedImages = usage.find((u: any) => u.tenantId === t.id && u.measure === "images")?._sum?.quantity || 0;
        return {
          tenantId: t.id, tenantName: t.name,
          quota: q ? { videoSeconds: q.videoSeconds, images: q.images, storageGb: q.storageGb, maxConcurrent: q.maxConcurrent, premiumEngines: q.premiumEngines } : { ...DEFAULT_QUOTA, isDefault: true },
          used: { videoSeconds: usedVideo, images: usedImages },
        };
      }),
    });
  });

  app.put("/admin/creative/quotas/:tenantId", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const body = z.object({
      videoSeconds: z.number().int().min(0).max(100000),
      images: z.number().int().min(0).max(1000000),
      storageGb: z.number().int().min(1).max(10000),
      maxConcurrent: z.number().int().min(1).max(20),
      premiumEngines: z.boolean(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const tenantId = String(req.params.tenantId);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return reply.code(404).send({ error: "not_found" });
    const quota = await db.creativeQuota.upsert({ where: { tenantId }, create: { tenantId, ...body.data }, update: { ...body.data } });
    await db.creativeAuditEvent.create({
      data: { tenantId, actorType: "user", actorId: String(user.sub || ""), action: "creative.quota.updated", targetType: "CreativeQuota", targetId: tenantId, detail: body.data as any, ip: req.ip },
    }).catch(() => undefined);
    return reply.send({ quota });
  });

  /* ---------------------------------------------------------------- */
  /* audit                                                             */
  /* ---------------------------------------------------------------- */
  app.get("/admin/creative/audit", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const q = (req.query || {}) as any;
    const where: any = {};
    if (q.tenantId) where.tenantId = String(q.tenantId);
    if (q.result) where.result = String(q.result);
    if (q.action) where.action = { contains: String(q.action) };
    const [events, tenants] = await Promise.all([
      db.creativeAuditEvent.findMany({ where, orderBy: { createdAt: "desc" }, take: Math.min(300, Number(q.limit || 100)) }),
      db.tenant.findMany({ select: { id: true, name: true } }),
    ]);
    const nameOf = new Map(tenants.map((t: any) => [t.id, t.name]));
    return reply.send({
      events: events.map((e: any) => ({
        id: e.id, tenantId: e.tenantId, tenantName: e.tenantId ? nameOf.get(e.tenantId) || e.tenantId : "platform",
        actorType: e.actorType, actorId: e.actorId, action: e.action, targetType: e.targetType, targetId: e.targetId,
        result: e.result, detail: e.detail, createdAt: e.createdAt,
      })),
    });
  });
}
