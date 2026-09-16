/**
 * Creative Studio — the Coworker's door.
 *
 * The agent process calls these server-to-server with the shared internal
 * secret, exactly like the hold-music upload door it already uses. Two rules
 * make this safe:
 *
 *   1. ⛔ The company is whatever the agent passes, and the agent only ever
 *      passes the tenantId it verified from the portal JWT — but we still
 *      check that the tenant EXISTS and scope every read to it, so a bug in
 *      the agent cannot become a cross-company read here.
 *   2. Everything goes through the same service functions the browser uses, so
 *      safety, quota and the brand kit cannot be skipped by asking the agent
 *      instead of clicking.
 */
import { z } from "zod";
import { startGeneration } from "./service";
import { cancelJob, checkQuota, createJob, quotaFor, usedThisPeriod } from "./jobs";
import { EXPORT_PRESETS, normaliseTimeline } from "./localJobs";
import { assembleFilm, mergeStoryboard, storyboardDoc } from "./film";
import { assetSummary, jobSummary, projectSummary } from "./routes";
import { applyOps, loadBrandKit } from "./helpers";
import { activeMemoryFor, recordFeedback } from "./memory";

type Deps = { app: any; db: any };

export function registerCreativeInternalRoutes({ app, db }: Deps): void {
  const guard = (req: any, reply: any): boolean => {
    const secret = process.env.AGENT_INTERNAL_SECRET;
    if (!secret || req.headers["x-agent-internal-secret"] !== secret) {
      reply.code(403).send({ error: "forbidden" });
      return false;
    }
    return true;
  };

  /** The tenant must exist; everything downstream is scoped to it. */
  const tenantOf = async (req: any, reply: any): Promise<{ tenantId: string; userId: string | null } | null> => {
    const tenantId = String((req.body as any)?.tenantId || (req.query as any)?.tenantId || "").trim();
    if (!tenantId) {
      reply.code(400).send({ error: "tenant_required" });
      return null;
    }
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) {
      reply.code(404).send({ error: "not_found" });
      return null;
    }
    const userId = String((req.body as any)?.userId || (req.query as any)?.userId || "").trim() || null;
    return { tenantId, userId };
  };

  app.post("/internal/agent/creative/generate", async (req: any, reply: any) => {
    if (!guard(req, reply)) return;
    const who = await tenantOf(req, reply);
    if (!who) return;
    const body = z.object({
      capability: z.enum(["image.generate", "image.edit", "video.generate", "audio.speech", "audio.music"]),
      request: z.string().max(4000),
      projectId: z.string().max(40).optional(),
      ratio: z.string().max(12).optional(),
      quality: z.enum(["low", "medium", "high"]).optional(),
      count: z.number().int().min(1).max(4).optional(),
      seconds: z.number().int().min(1).max(15).optional(),
      styleHint: z.string().max(200).optional(),
      referenceAssetIds: z.array(z.string().max(40)).max(4).optional(),
      firstFrameAssetId: z.string().max(40).optional(),
      voiceId: z.string().max(80).optional(),
      durationMs: z.number().int().min(1000).max(120000).optional(),
      shotId: z.string().max(60).optional(),
      turnId: z.string().max(80).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const res = await startGeneration(db, { ...body.data, tenantId: who.tenantId, userId: who.userId, text: body.data.request });
    if (!res.ok) {
      await db.creativeAuditEvent.create({
        data: { tenantId: who.tenantId, actorType: "coworker", actorId: who.userId, action: "creative.request.refused", result: "denied", detail: { code: res.code, kind: (res as any).kind } as any },
      }).catch(() => undefined);
      return reply.code(res.code === "quota" ? 429 : res.code === "refused" ? 422 : 400).send({ error: res.code, reason: res.reason });
    }
    await db.creativeAuditEvent.create({
      data: { tenantId: who.tenantId, actorType: "coworker", actorId: who.userId, action: "creative.job.created", targetType: "CreativeJob", targetId: res.job.id, detail: { capability: body.data.capability, viaAgent: true } as any },
    }).catch(() => undefined);
    return reply.send({ job: jobSummary(res.job), label: res.label, appliedMemory: res.appliedMemory, estimate: res.estimate, deduped: res.deduped });
  });

  app.get("/internal/agent/creative/job", async (req: any, reply: any) => {
    if (!guard(req, reply)) return;
    const who = await tenantOf(req, reply);
    if (!who) return;
    const id = String((req.query as any)?.jobId || "");
    let job = await db.creativeJob.findFirst({ where: { id, tenantId: who.tenantId } });
    if (!job) return reply.code(404).send({ error: "not_found" });

    // ⛔ Wait here rather than making the model poll. A chat turn has a small
    // number of tool calls in it; an image takes ~15s, so without this the
    // model spends its whole budget asking "is it done yet?" and runs out
    // before it can answer the person. Bounded well under the request timeout.
    const waitMs = Math.max(0, Math.min(25_000, Number((req.query as any)?.waitMs || 0)));
    if (waitMs && !["succeeded", "failed", "cancelled"].includes(job.status)) {
      const until = Date.now() + waitMs;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1500));
        job = await db.creativeJob.findFirst({ where: { id, tenantId: who.tenantId } });
        if (!job || ["succeeded", "failed", "cancelled"].includes(job.status)) break;
      }
      if (!job) return reply.code(404).send({ error: "not_found" });
    }
    let assets: any[] = [];
    if (job.status === "succeeded") {
      const gen = await db.creativeGeneration.findFirst({ where: { jobId: job.id, tenantId: who.tenantId }, orderBy: { createdAt: "desc" } });
      if (gen?.outputAssetIds?.length) {
        const rows = await db.creativeAsset.findMany({ where: { id: { in: gen.outputAssetIds }, tenantId: who.tenantId, deletedAt: null } });
        assets = rows.map(assetSummary);
      }
    }
    return reply.send({ job: jobSummary(job), assets });
  });

  app.post("/internal/agent/creative/job/cancel", async (req: any, reply: any) => {
    if (!guard(req, reply)) return;
    const who = await tenantOf(req, reply);
    if (!who) return;
    const res = await cancelJob(db, who.tenantId, String((req.body as any)?.jobId || ""));
    return reply.send(res);
  });

  app.post("/internal/agent/creative/project", async (req: any, reply: any) => {
    if (!guard(req, reply)) return;
    const who = await tenantOf(req, reply);
    if (!who) return;
    const body = z.object({ title: z.string().min(1).max(160), kind: z.string().max(40).default("image"), brief: z.string().max(4000).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const kit = await db.creativeBrandKit.findFirst({ where: { tenantId: who.tenantId, isDefault: true } });
    const project = await db.creativeProject.create({
      data: { tenantId: who.tenantId, title: body.data.title, kind: body.data.kind, brief: body.data.brief || null, ownerUserId: who.userId, brandKitId: kit?.id || null, status: "working" },
    });
    return reply.send({ project: projectSummary(project) });
  });

  app.get("/internal/agent/creative/project", async (req: any, reply: any) => {
    if (!guard(req, reply)) return;
    const who = await tenantOf(req, reply);
    if (!who) return;
    const id = String((req.query as any)?.projectId || "");
    const project = await db.creativeProject.findFirst({
      where: { id, tenantId: who.tenantId, deletedAt: null },
      include: { documents: true, assets: { where: { deletedAt: null, source: { not: "segment" } }, orderBy: { createdAt: "desc" }, take: 30 }, jobs: { orderBy: { createdAt: "desc" }, take: 10 } },
    });
    if (!project) return reply.code(404).send({ error: "not_found" });
    return reply.send({
      project: projectSummary(project),
      documents: project.documents.map((d: any) => ({ id: d.id, type: d.type, revision: d.revision, doc: d.doc })),
      assets: project.assets.map(assetSummary),
      jobs: project.jobs.map(jobSummary),
    });
  });

  /** Read the design exactly as it stands, with the revision to write against. */
  app.get("/internal/agent/creative/canvas", async (req: any, reply: any) => {
    if (!guard(req, reply)) return;
    const who = await tenantOf(req, reply);
    if (!who) return;
    const projectId = String((req.query as any)?.projectId || "");
    const type = String((req.query as any)?.type || "canvas");
    const doc = await db.creativeDocument.findFirst({ where: { projectId, tenantId: who.tenantId, type } });
    if (!doc) return reply.code(404).send({ error: "not_found" });
    return reply.send({ documentId: doc.id, revision: doc.revision, doc: doc.doc });
  });

  /** Write against the revision just read; a stale write is refused, not merged. */
  app.post("/internal/agent/creative/canvas/ops", async (req: any, reply: any) => {
    if (!guard(req, reply)) return;
    const who = await tenantOf(req, reply);
    if (!who) return;
    const body = z.object({
      documentId: z.string().max(40),
      baseRevision: z.number().int().nonnegative(),
      ops: z.array(z.object({ op: z.string().max(20), target: z.string().max(120).optional(), payload: z.any(), summary: z.string().max(200).optional() })).min(1).max(50),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });

    const doc = await db.creativeDocument.findFirst({ where: { id: body.data.documentId, tenantId: who.tenantId } });
    if (!doc) return reply.code(404).send({ error: "not_found" });
    if (doc.revision !== body.data.baseRevision) {
      return reply.code(409).send({ error: "stale_revision", revision: doc.revision, doc: doc.doc, message: "Somebody changed this while you were working. Read it again before writing." });
    }
    const next = applyOps(doc.doc as any, body.data.ops as any);
    const saved = await db.creativeDocument.update({ where: { id: doc.id }, data: { doc: next, revision: { increment: 1 }, updatedByType: "coworker", updatedByUserId: who.userId } });
    for (const op of body.data.ops) {
      await db.creativeOperation.create({
        data: { tenantId: who.tenantId, documentId: doc.id, revision: saved.revision, actorType: "coworker", actorUserId: who.userId, op: op.op, payload: { target: op.target, ...(op.payload ?? {}) } as any, summary: op.summary || null },
      }).catch(() => undefined);
    }
    return reply.send({ revision: saved.revision, doc: saved.doc });
  });

  /* ---------------------------------------------------------------- */
  /* the film: storyboard → assemble → render → export                 */
  /* ---------------------------------------------------------------- */

  /**
   * Write the storyboard. The agent hands over the shots it wrote; the SPLIT —
   * how many seconds each shot gets — is worked out here by `storyboardDoc`,
   * the same code the browser uses, so the model cannot talk itself past the
   * 15-second ceiling.
   */
  app.post("/internal/agent/creative/storyboard", async (req: any, reply: any) => {
    if (!guard(req, reply)) return;
    const who = await tenantOf(req, reply);
    if (!who) return;
    const body = z.object({
      projectId: z.string().max(40),
      totalSeconds: z.number().int().min(1).max(600).optional(),
      ratio: z.string().max(12).optional(),
      shots: z.array(z.object({
        title: z.string().max(120).optional(),
        prompt: z.string().min(1).max(2000),
        seconds: z.number().int().min(1).max(15).optional(),
      })).min(1).max(24),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const project = await db.creativeProject.findFirst({ where: { id: body.data.projectId, tenantId: who.tenantId, deletedAt: null } });
    if (!project) return reply.code(404).send({ error: "not_found" });

    const rebuilt = storyboardDoc(body.data.shots, body.data.totalSeconds || 0, body.data.ratio || "16:9");
    const existing = await db.creativeDocument.findFirst({ where: { projectId: project.id, tenantId: who.tenantId, type: "storyboard" } });
    // ⛔ Re-writing must not orphan clips that have already been paid for.
    const merged = mergeStoryboard(existing?.doc, rebuilt);
    const doc = merged.doc;
    const saved = existing
      ? await db.creativeDocument.update({ where: { id: existing.id }, data: { doc, revision: { increment: 1 }, updatedByType: "coworker", updatedByUserId: who.userId } })
      : await db.creativeDocument.create({ data: { tenantId: who.tenantId, projectId: project.id, type: "storyboard", doc, revision: 1, updatedByType: "coworker", updatedByUserId: who.userId } });

    return reply.send({
      documentId: saved.id,
      revision: saved.revision,
      shots: doc.objects.map((o: any) => ({ id: o.id, title: o.title, seconds: o.seconds, prompt: o.prompt, rendered: !!o.assetId })),
      totalSeconds: doc.objects.reduce((n: number, o: any) => n + Number(o.seconds || 0), 0),
      keptClips: merged.kept,
      droppedClips: merged.dropped,
    });
  });

  /** Put the rendered shots together into a cut — the same call the button makes. */
  app.post("/internal/agent/creative/assemble", async (req: any, reply: any) => {
    if (!guard(req, reply)) return;
    const who = await tenantOf(req, reply);
    if (!who) return;
    const projectId = String((req.body as any)?.projectId || "");
    const project = await db.creativeProject.findFirst({ where: { id: projectId, tenantId: who.tenantId, deletedAt: null } });
    if (!project) return reply.code(404).send({ error: "not_found" });
    const res = await assembleFilm(db, { tenantId: who.tenantId, projectId: project.id, userId: who.userId, actorType: "coworker" });
    if (!res.ok) return reply.code(400).send({ error: res.code, reason: res.reason });
    return reply.send({ documentId: res.documentId, revision: res.revision, clips: res.clips, skipped: res.skipped });
  });

  /** Render the cut. Ours, with FFmpeg — no engine, no per-run cost. */
  app.post("/internal/agent/creative/render", async (req: any, reply: any) => {
    if (!guard(req, reply)) return;
    const who = await tenantOf(req, reply);
    if (!who) return;
    const projectId = String((req.body as any)?.projectId || "");
    const project = await db.creativeProject.findFirst({ where: { id: projectId, tenantId: who.tenantId, deletedAt: null } });
    if (!project) return reply.code(404).send({ error: "not_found" });

    const document = await db.creativeDocument.findFirst({ where: { projectId: project.id, tenantId: who.tenantId, type: "timeline" } });
    const timeline = normaliseTimeline(document?.doc);
    if (!timeline?.clips?.length) return reply.code(400).send({ error: "empty_timeline", reason: "There are no shots on the timeline yet." });

    const quota = await checkQuota(db, who.tenantId, "timeline.render", {});
    if (!quota.ok) return reply.code(429).send({ error: "quota_blocked", reason: quota.reason });

    const { job, deduped } = await createJob(db, {
      tenantId: who.tenantId,
      capability: "timeline.render",
      projectId: project.id,
      requestedByUserId: who.userId,
      idempotencyKey: `render:${project.id}:${document?.revision ?? 0}`,
      request: { timeline },
      priority: 50,
    });
    if (!job) return reply.code(503).send({ error: "no_engine" });
    return reply.send({ job: jobSummary(job), deduped });
  });

  /** Make the files for the places it is going. ⛔ Never posts them anywhere. */
  app.post("/internal/agent/creative/export", async (req: any, reply: any) => {
    if (!guard(req, reply)) return;
    const who = await tenantOf(req, reply);
    if (!who) return;
    const body = z.object({
      assetId: z.string().max(40),
      presets: z.array(z.string().max(40)).min(1).max(9),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });

    const asset = await db.creativeAsset.findFirst({ where: { id: body.data.assetId, tenantId: who.tenantId, deletedAt: null } });
    if (!asset) return reply.code(404).send({ error: "not_found" });
    const unknown = body.data.presets.filter((p) => !EXPORT_PRESETS[p]);
    if (unknown.length) return reply.code(400).send({ error: "unknown_preset", detail: unknown, known: Object.keys(EXPORT_PRESETS) });

    const jobs: any[] = [];
    for (const preset of body.data.presets) {
      const { job } = await createJob(db, {
        tenantId: who.tenantId,
        capability: "export",
        projectId: asset.projectId || null,
        requestedByUserId: who.userId,
        idempotencyKey: `export:${asset.id}:${preset}:png`,
        request: { assetId: asset.id, preset },
        priority: 40,
      });
      if (job) jobs.push(jobSummary(job));
    }
    return reply.send({ jobs });
  });

  app.get("/internal/agent/creative/context", async (req: any, reply: any) => {
    if (!guard(req, reply)) return;
    const who = await tenantOf(req, reply);
    if (!who) return;
    const [kit, memory, quota, used, engines, projects] = await Promise.all([
      loadBrandKit(db, who.tenantId),
      activeMemoryFor(db, who.tenantId, who.userId),
      quotaFor(db, who.tenantId),
      usedThisPeriod(db, who.tenantId),
      db.creativeEngine.findMany({ where: { enabled: true, commercialOk: true } }),
      db.creativeProject.findMany({ where: { tenantId: who.tenantId, deletedAt: null }, orderBy: { updatedAt: "desc" }, take: 5 }),
    ]);
    return reply.send({
      brandKit: kit,
      memory: memory.map((m) => m.statement),
      quota: { ...quota, used },
      canMake: {
        image: engines.some((e: any) => e.capabilities.includes("image.generate")),
        video: engines.some((e: any) => e.capabilities.includes("video.generate")),
        speech: engines.some((e: any) => e.capabilities.includes("audio.speech")),
        music: engines.some((e: any) => e.capabilities.includes("audio.music")),
      },
      recentProjects: projects.map(projectSummary),
    });
  });

  app.get("/internal/agent/creative/assets", async (req: any, reply: any) => {
    if (!guard(req, reply)) return;
    const who = await tenantOf(req, reply);
    if (!who) return;
    const q = (req.query || {}) as any;
    // The Coworker sees the same library the person does — intermediates are
    // not in it, so the model cannot offer somebody a raw segment as "your video".
    const where: any = { tenantId: who.tenantId, deletedAt: null, source: { not: "segment" } };
    if (q.kind) where.kind = String(q.kind);
    if (q.projectId) where.projectId = String(q.projectId);
    const rows = await db.creativeAsset.findMany({ where, orderBy: { createdAt: "desc" }, take: Math.min(40, Number(q.limit || 12)) });
    return reply.send({ assets: rows.map(assetSummary) });
  });

  app.post("/internal/agent/creative/feedback", async (req: any, reply: any) => {
    if (!guard(req, reply)) return;
    const who = await tenantOf(req, reply);
    if (!who) return;
    const body = z.object({
      subjectType: z.string().max(40),
      subjectId: z.string().max(40).optional(),
      projectId: z.string().max(40).optional(),
      signal: z.enum(["accept", "reject", "regenerate", "edit", "export", "favourite"]),
      reasonCodes: z.array(z.string().max(40)).max(10).optional(),
      detail: z.any().optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const res = await recordFeedback(db, { tenantId: who.tenantId, userId: who.userId, ...body.data });
    return reply.send({ ok: true, learned: res.learned });
  });
}
