/**
 * Creative Studio — the customer-facing API.
 *
 * ⛔ The company is taken from the signed-in session, never from a body, a
 * query or an argument. Every read is `findFirst({ where: { id, tenantId } })`
 * and answers "not found" when it belongs to someone else — never "forbidden",
 * which would confirm the thing exists.
 *
 * Route prefix is /creative, which no existing family owns. (LoopCom Mobile
 * had to become /mobile-service because /mobile was already the phone app's;
 * the same trap is why this one was checked first.)
 */
import crypto from "crypto";
import { z } from "zod";
import { resolveUrlSigningKey } from "../urlSigningSecret";
import { buildKey, putObject, getObjectStream, deleteObject, sniffMime, ALLOWED_UPLOAD_MIME, kindForMime, keyBelongsToTenant, tenantBytes } from "./storage";
import { listMemory, recordFeedback } from "./memory";
import { cancelJob, checkQuota, createJob, quotaFor, usedThisPeriod, periodOf } from "./jobs";
import { EXPORT_PRESETS, normaliseTimeline } from "./localJobs";
import { assembleFilm } from "./film";
import { chooseEngine } from "./engines";
import { loadBrandKit, applyOps } from "./helpers";
import { startGeneration } from "./service";

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

type Deps = {
  app: any;
  db: any;
  requireOwner: (req: any, reply: any) => Promise<any | undefined>;
  /** The platform's own action-key check, so these routes gate the same way
   *  every other route does rather than inventing a second answer. */
  hasPermission: (user: any, key: string) => Promise<boolean>;
};

export function signCreativeKey(storageKey: string, expiresInSec = 600): { exp: number; sig: string } {
  const exp = Math.floor(Date.now() / 1000) + Math.max(10, expiresInSec);
  const sig = crypto.createHmac("sha256", resolveUrlSigningKey("creative")).update(`${storageKey}:${exp}`).digest("hex");
  return { exp, sig };
}

export function verifyCreativeSignature(storageKey: string, exp: any, sig: any): { ok: boolean; reason?: string } {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };
  const given = String(sig || "");
  if (!/^[0-9a-f]{64}$/.test(given)) return { ok: false, reason: "malformed" };
  const expected = crypto.createHmac("sha256", resolveUrlSigningKey("creative")).update(`${storageKey}:${expNum}`).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(given, "hex")) ? { ok: true } : { ok: false, reason: "mismatch" };
  } catch {
    return { ok: false, reason: "mismatch" };
  }
}

export function assetUrl(asset: { storageKey: string }, expiresInSec = 600): string {
  const { exp, sig } = signCreativeKey(asset.storageKey, expiresInSec);
  return `/creative/download/${encodeURIComponent(asset.storageKey)}?exp=${exp}&sig=${sig}`;
}

export function assetSummary(a: any) {
  return {
    id: a.id,
    kind: a.kind,
    source: a.source,
    name: a.name,
    mime: a.mime,
    bytes: a.bytes,
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    favourite: a.favourite,
    projectId: a.projectId,
    createdAt: a.createdAt,
    url: assetUrl(a),
    thumbUrl: a.thumbKey ? assetUrl({ storageKey: a.thumbKey }) : null,
  };
}

export function jobSummary(j: any) {
  return {
    id: j.id,
    capability: j.capability,
    status: j.status,
    progress: j.progress,
    note: j.progressNote,
    error: j.error,
    errorCode: j.errorCode,
    costMicros: j.costMicros,
    projectId: j.projectId,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt,
  };
}

export function projectSummary(p: any) {
  return {
    id: p.id, title: p.title, kind: p.kind, status: p.status, brief: p.brief,
    visibility: p.visibility, ownerUserId: p.ownerUserId, spentMicros: p.spentMicros,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

export function registerCreativeStudioRoutes({ app, db, requireOwner, hasPermission }: Deps): void {
  /** 403 with a plain reason when the person lacks an action key. */
  const needs = async (req: any, reply: any, key: string, what: string): Promise<boolean> => {
    const ok = await hasPermission(req.user, key).catch(() => false);
    if (!ok) {
      reply.code(403).send({ error: "forbidden", key, reason: `You do not have permission to ${what}. An admin at your company can turn that on.` });
      return false;
    }
    return true;
  };

  const tenantUser = (req: any, reply: any) => {
    const u = req.user as { sub?: string; tenantId?: string; role?: string } | undefined;
    if (!u?.tenantId || !u?.sub) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return { sub: String(u.sub), tenantId: String(u.tenantId), role: String(u.role || "USER") };
  };

  const audit = async (opts: { tenantId?: string | null; actorType: string; actorId?: string | null; action: string; targetType?: string; targetId?: string; result?: string; detail?: any; ip?: string }) => {
    await db.creativeAuditEvent.create({
      data: {
        tenantId: opts.tenantId || null,
        actorType: opts.actorType,
        actorId: opts.actorId || null,
        action: opts.action,
        targetType: opts.targetType || null,
        targetId: opts.targetId || null,
        result: opts.result || "ok",
        detail: opts.detail ?? undefined,
        ip: opts.ip || null,
      },
    }).catch(() => undefined);
  };

  /* ---------------------------------------------------------------- */
  /* download — signature is the only authentication, like MOH audio    */
  /* ---------------------------------------------------------------- */
  app.get("/creative/download/*", async (req: any, reply: any) => {
    const storageKey = decodeURIComponent(String((req.params as any)["*"] || ""));
    const q = (req.query || {}) as any;
    const verified = verifyCreativeSignature(storageKey, q.exp, q.sig);
    if (!verified.ok) return reply.code(401).send({ error: "bad_signature", reason: verified.reason });
    try {
      const got = await getObjectStream(storageKey);
      reply.header("content-type", got.contentType);
      if (got.bytes) reply.header("content-length", String(got.bytes));
      reply.header("cache-control", "private, max-age=300");
      return reply.send(got.stream);
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
  });

  /* ---------------------------------------------------------------- */
  /* overview                                                          */
  /* ---------------------------------------------------------------- */
  app.get("/creative/overview", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const [projects, generations, quota, used, brandKit, engines] = await Promise.all([
      db.creativeProject.findMany({ where: { tenantId: u.tenantId, deletedAt: null }, orderBy: { updatedAt: "desc" }, take: 8 }),
      db.creativeAsset.findMany({ where: { tenantId: u.tenantId, deletedAt: null, source: "generated" }, orderBy: { createdAt: "desc" }, take: 12 }),
      quotaFor(db, u.tenantId),
      usedThisPeriod(db, u.tenantId),
      db.creativeBrandKit.findFirst({ where: { tenantId: u.tenantId }, include: { items: true } }),
      db.creativeEngine.findMany({ where: { enabled: true, commercialOk: true } }),
    ]);
    return reply.send({
      projects: projects.map(projectSummary),
      recent: generations.map(assetSummary),
      quota: { ...quota, used, period: periodOf() },
      brandKit: brandKit ? { id: brandKit.id, name: brandKit.name, itemCount: brandKit.items.length } : null,
      capabilities: {
        image: engines.some((e: any) => e.capabilities.includes("image.generate")),
        video: engines.some((e: any) => e.capabilities.includes("video.generate")),
        speech: engines.some((e: any) => e.capabilities.includes("audio.speech")),
        music: engines.some((e: any) => e.capabilities.includes("audio.music")),
      },
    });
  });

  /* ---------------------------------------------------------------- */
  /* projects                                                          */
  /* ---------------------------------------------------------------- */
  const projectBody = z.object({
    title: z.string().min(1).max(160),
    kind: z.string().min(1).max(40).default("image"),
    brief: z.string().max(4000).optional(),
    visibility: z.enum(["private", "company"]).default("company"),
  });

  app.post("/creative/projects", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const body = projectBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const kit = await db.creativeBrandKit.findFirst({ where: { tenantId: u.tenantId, isDefault: true } });
    const project = await db.creativeProject.create({
      data: { tenantId: u.tenantId, title: body.data.title, kind: body.data.kind, brief: body.data.brief || null, visibility: body.data.visibility, ownerUserId: u.sub, brandKitId: kit?.id || null },
    });
    await audit({ tenantId: u.tenantId, actorType: "user", actorId: u.sub, action: "creative.project.created", targetType: "CreativeProject", targetId: project.id, ip: req.ip });
    return reply.send({ project: projectSummary(project) });
  });

  app.get("/creative/projects", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const q = (req.query || {}) as any;
    const where: any = { tenantId: u.tenantId, deletedAt: null };
    if (q.kind) where.kind = String(q.kind);
    if (q.mine === "1") where.ownerUserId = u.sub;
    // Without the company-projects key you see your own work and anything
    // explicitly shared with the company.
    const seesAll = await hasPermission(req.user, "can_view_company_creative_projects").catch(() => false);
    if (!seesAll) where.OR = [{ ownerUserId: u.sub }, { visibility: "company" }];
    const rows = await db.creativeProject.findMany({ where, orderBy: { updatedAt: "desc" }, take: Math.min(100, Number(q.limit || 50)) });
    return reply.send({ projects: rows.map(projectSummary) });
  });

  app.get("/creative/projects/:id", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const project = await db.creativeProject.findFirst({
      where: { id: String(req.params.id), tenantId: u.tenantId, deletedAt: null },
      include: {
        documents: true,
        assets: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 60 },
        jobs: { orderBy: { createdAt: "desc" }, take: 20 },
        versions: { orderBy: { number: "desc" }, take: 30 },
        generations: { orderBy: { createdAt: "desc" }, take: 30 },
      },
    });
    if (!project) return reply.code(404).send({ error: "not_found" });
    await db.creativeProject.update({ where: { id: project.id }, data: { lastOpenedAt: new Date() } }).catch(() => undefined);
    return reply.send({
      project: projectSummary(project),
      documents: project.documents.map((d: any) => ({ id: d.id, type: d.type, revision: d.revision, doc: d.doc, updatedAt: d.updatedAt, updatedByType: d.updatedByType })),
      assets: project.assets.map(assetSummary),
      jobs: project.jobs.map(jobSummary),
      versions: project.versions.map((v: any) => ({ id: v.id, number: v.number, label: v.label, actorType: v.actorType, actorUserId: v.actorUserId, summary: v.summary, createdAt: v.createdAt })),
      generations: project.generations.map((g: any) => ({
        id: g.id, capability: g.capability, request: g.request, engineId: g.engineId, seed: g.seed,
        renderMs: g.renderMs, costMicros: g.costMicros, outcome: g.outcome, outputAssetIds: g.outputAssetIds,
        evaluation: g.evaluation, createdAt: g.createdAt, builtPrompt: g.builtPrompt,
      })),
    });
  });

  app.patch("/creative/projects/:id", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const existing = await db.creativeProject.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId, deletedAt: null } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const body = projectBody.partial().safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const project = await db.creativeProject.update({ where: { id: existing.id }, data: { ...body.data } });
    return reply.send({ project: projectSummary(project) });
  });

  app.delete("/creative/projects/:id", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    if (!(await needs(req, reply, "can_delete_creative_projects", "delete projects"))) return;
    const existing = await db.creativeProject.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId, deletedAt: null } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    await db.creativeProject.update({ where: { id: existing.id }, data: { deletedAt: new Date(), status: "archived" } });
    await audit({ tenantId: u.tenantId, actorType: "user", actorId: u.sub, action: "creative.project.deleted", targetType: "CreativeProject", targetId: existing.id, ip: req.ip });
    return reply.send({ ok: true });
  });

  /* ---------------------------------------------------------------- */
  /* documents + operations (the shared edit model)                    */
  /* ---------------------------------------------------------------- */
  app.put("/creative/projects/:id/documents/:type", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const project = await db.creativeProject.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId, deletedAt: null } });
    if (!project) return reply.code(404).send({ error: "not_found" });
    const type = String(req.params.type);
    if (!["canvas", "timeline", "storyboard"].includes(type)) return reply.code(400).send({ error: "bad_type" });
    const doc = (req.body as any)?.doc;
    if (!doc || typeof doc !== "object") return reply.code(400).send({ error: "invalid_body" });

    const existing = await db.creativeDocument.findFirst({ where: { projectId: project.id, type } });
    const saved = existing
      ? await db.creativeDocument.update({ where: { id: existing.id }, data: { doc, revision: { increment: 1 }, updatedByType: "user", updatedByUserId: u.sub } })
      : await db.creativeDocument.create({ data: { tenantId: u.tenantId, projectId: project.id, type, doc, revision: 1, updatedByType: "user", updatedByUserId: u.sub } });
    return reply.send({ document: { id: saved.id, type: saved.type, revision: saved.revision, doc: saved.doc } });
  });

  const opsBody = z.object({
    baseRevision: z.number().int().nonnegative(),
    actorType: z.enum(["user", "coworker"]).default("user"),
    ops: z.array(z.object({
      op: z.enum(["add", "set", "move", "resize", "replace", "reorder", "delete", "split", "trim"]),
      target: z.string().max(120).optional(),
      payload: z.any(),
      summary: z.string().max(200).optional(),
    })).min(1).max(100),
  });

  /**
   * The one door both a person and the Coworker edit through. A write against
   * a revision that has moved on is refused with the current document, so the
   * caller re-reads instead of overwriting somebody.
   */
  app.post("/creative/documents/:id/ops", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const body = opsBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const document = await db.creativeDocument.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId } });
    if (!document) return reply.code(404).send({ error: "not_found" });

    if (document.revision !== body.data.baseRevision) {
      return reply.code(409).send({
        error: "stale_revision",
        message: "Somebody changed this while you were working. Read it again and re-apply.",
        revision: document.revision,
        doc: document.doc,
      });
    }

    const doc = applyOps(document.doc as any, body.data.ops);
    const saved = await db.creativeDocument.update({
      where: { id: document.id },
      data: { doc, revision: { increment: 1 }, updatedByType: body.data.actorType, updatedByUserId: u.sub },
    });
    for (const op of body.data.ops) {
      await db.creativeOperation.create({
        data: {
          tenantId: u.tenantId, documentId: document.id, revision: saved.revision,
          actorType: body.data.actorType, actorUserId: u.sub, op: op.op,
          payload: { target: op.target, ...(op.payload ?? {}) } as any,
          summary: op.summary || null,
        },
      }).catch(() => undefined);
    }
    return reply.send({ revision: saved.revision, doc: saved.doc });
  });

  app.get("/creative/documents/:id", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const document = await db.creativeDocument.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId } });
    if (!document) return reply.code(404).send({ error: "not_found" });
    return reply.send({ id: document.id, type: document.type, revision: document.revision, doc: document.doc });
  });

  app.get("/creative/documents/:id/operations", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const document = await db.creativeDocument.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId } });
    if (!document) return reply.code(404).send({ error: "not_found" });
    const ops = await db.creativeOperation.findMany({ where: { documentId: document.id }, orderBy: { createdAt: "desc" }, take: 100 });
    return reply.send({ operations: ops.map((o: any) => ({ id: o.id, revision: o.revision, actorType: o.actorType, op: o.op, payload: o.payload, summary: o.summary, createdAt: o.createdAt })) });
  });

  /* ---------------------------------------------------------------- */
  /* versions                                                          */
  /* ---------------------------------------------------------------- */
  app.post("/creative/projects/:id/versions", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const project = await db.creativeProject.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId, deletedAt: null }, include: { documents: true } });
    if (!project) return reply.code(404).send({ error: "not_found" });
    const last = await db.creativeVersion.findFirst({ where: { projectId: project.id }, orderBy: { number: "desc" } });
    const version = await db.creativeVersion.create({
      data: {
        tenantId: u.tenantId, projectId: project.id,
        number: (last?.number || 0) + 1,
        label: String((req.body as any)?.label || `v${(last?.number || 0) + 1}`).slice(0, 120),
        summary: String((req.body as any)?.summary || "").slice(0, 400) || null,
        actorType: String((req.body as any)?.actorType || "user"),
        actorUserId: u.sub,
        parentVersionId: last?.id || null,
        snapshot: { documents: project.documents.map((d: any) => ({ type: d.type, revision: d.revision, doc: d.doc })) } as any,
      },
    });
    return reply.send({ version: { id: version.id, number: version.number, label: version.label } });
  });

  app.post("/creative/projects/:id/versions/:versionId/restore", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const version = await db.creativeVersion.findFirst({ where: { id: String(req.params.versionId), projectId: String(req.params.id), tenantId: u.tenantId } });
    if (!version) return reply.code(404).send({ error: "not_found" });
    const snapshot = (version.snapshot as any)?.documents || [];
    for (const d of snapshot) {
      const doc = await db.creativeDocument.findFirst({ where: { projectId: version.projectId, type: d.type } });
      if (doc) await db.creativeDocument.update({ where: { id: doc.id }, data: { doc: d.doc, revision: { increment: 1 }, updatedByType: "user", updatedByUserId: u.sub } });
    }
    await audit({ tenantId: u.tenantId, actorType: "user", actorId: u.sub, action: "creative.version.restored", targetType: "CreativeVersion", targetId: version.id, ip: req.ip });
    return reply.send({ ok: true, restored: version.number });
  });

  /* ---------------------------------------------------------------- */
  /* jobs — generation                                                 */
  /* ---------------------------------------------------------------- */
  const generateBody = z.object({
    capability: z.enum(["image.generate", "image.edit", "video.generate", "audio.speech", "audio.music"]),
    projectId: z.string().max(40).optional(),
    request: z.string().max(4000).optional(),
    prompt: z.string().max(4000).optional(),
    ratio: z.string().max(12).optional(),
    quality: z.enum(["low", "medium", "high"]).optional(),
    count: z.number().int().min(1).max(4).optional(),
    seconds: z.number().int().min(1).max(15).optional(),
    hd: z.boolean().optional(),
    styleHint: z.string().max(200).optional(),
    negativeExtra: z.string().max(400).optional(),
    referenceAssetIds: z.array(z.string().max(40)).max(4).optional(),
    maskAssetId: z.string().max(40).optional(),
    firstFrameAssetId: z.string().max(40).optional(),
    text: z.string().max(5000).optional(),
    voiceId: z.string().max(80).optional(),
    durationMs: z.number().int().min(1000).max(120000).optional(),
    engineId: z.string().max(80).optional(),
    seed: z.string().max(40).optional(),
    shotId: z.string().max(60).optional(),
    turnId: z.string().max(80).optional(),
  });

  app.post("/creative/jobs", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const parsed = generateBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const b = parsed.data;

    const needKey =
      b.capability === "video.generate" ? "can_creative_generate_video"
      : b.capability.startsWith("audio") ? "can_creative_generate_video"
      : "can_creative_generate_image";
    const needWhat = b.capability === "video.generate" ? "make videos" : b.capability.startsWith("audio") ? "make voiceovers and music" : "make images";
    if (!(await needs(req, reply, needKey, needWhat))) return;

    if (b.projectId) {
      const project = await db.creativeProject.findFirst({ where: { id: b.projectId, tenantId: u.tenantId, deletedAt: null } });
      if (!project) return reply.code(404).send({ error: "not_found" });
    }

    // One implementation for both doors: the browser and the Coworker take the
    // same safety check, the same quota check and the same prompt building.
    const outcome = await startGeneration(db, {
      tenantId: u.tenantId,
      userId: u.sub,
      capability: b.capability,
      request: String(b.request || b.prompt || b.text || ""),
      projectId: b.projectId || null,
      ratio: b.ratio,
      quality: b.quality,
      count: b.count,
      seconds: b.seconds,
      hd: b.hd,
      styleHint: b.styleHint,
      negativeExtra: b.negativeExtra,
      referenceAssetIds: b.referenceAssetIds,
      maskAssetId: b.maskAssetId,
      firstFrameAssetId: b.firstFrameAssetId,
      text: b.text,
      voiceId: b.voiceId,
      durationMs: b.durationMs,
      engineId: b.engineId,
      seed: b.seed,
      shotId: b.shotId || null,
      turnId: b.turnId || null,
    });

    if (!outcome.ok) {
      const status = outcome.code === "quota" ? 429 : outcome.code === "refused" ? 422 : outcome.code === "no_engine" ? 503 : 400;
      await audit({
        tenantId: u.tenantId, actorType: b.turnId ? "coworker" : "user", actorId: u.sub,
        action: outcome.code === "quota" ? "creative.quota.blocked" : "creative.request.refused",
        result: "denied", detail: { code: outcome.code, kind: (outcome as any).kind }, ip: req.ip,
      });
      return reply.code(status).send({ error: outcome.code === "quota" ? "quota_blocked" : outcome.code, reason: outcome.reason, kind: (outcome as any).kind });
    }

    const { job, deduped, label, appliedMemory, estimate } = outcome;
    await audit({
      tenantId: u.tenantId, actorType: b.turnId ? "coworker" : "user", actorId: u.sub,
      action: "creative.job.created", targetType: "CreativeJob", targetId: job.id,
      detail: { capability: b.capability, deduped, estimateMicros: job.costMicros }, ip: req.ip,
    });

    return reply.send({ job: jobSummary(job), deduped, label, appliedMemory, estimate });
  });

  app.get("/creative/jobs/:id", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const job = await db.creativeJob.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId } });
    if (!job) return reply.code(404).send({ error: "not_found" });
    let assets: any[] = [];
    if (job.status === "succeeded") {
      const gen = await db.creativeGeneration.findFirst({ where: { jobId: job.id, tenantId: u.tenantId }, orderBy: { createdAt: "desc" } });
      if (gen?.outputAssetIds?.length) {
        const rows = await db.creativeAsset.findMany({ where: { id: { in: gen.outputAssetIds }, tenantId: u.tenantId, deletedAt: null } });
        assets = rows.map(assetSummary);
      }
    }
    return reply.send({ job: jobSummary(job), assets });
  });

  app.get("/creative/jobs", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const q = (req.query || {}) as any;
    const where: any = { tenantId: u.tenantId };
    if (q.projectId) where.projectId = String(q.projectId);
    if (q.active === "1") where.status = { in: ["queued", "claimed", "running", "evaluating", "retrying"] };
    const rows = await db.creativeJob.findMany({ where, orderBy: { createdAt: "desc" }, take: Math.min(50, Number(q.limit || 20)) });
    return reply.send({ jobs: rows.map(jobSummary) });
  });

  app.post("/creative/jobs/:id/cancel", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const res = await cancelJob(db, u.tenantId, String(req.params.id));
    if (!res.ok && res.reason === "not_found") return reply.code(404).send({ error: "not_found" });
    await audit({ tenantId: u.tenantId, actorType: "user", actorId: u.sub, action: "creative.job.cancelled", targetType: "CreativeJob", targetId: String(req.params.id), result: res.ok ? "ok" : "failed", ip: req.ip });
    return reply.send(res);
  });

  /* ---------------------------------------------------------------- */
  /* the cut, and the sizes it goes out in                             */
  /* ---------------------------------------------------------------- */

  /**
   * Turn the storyboard into a cut. Same implementation the Coworker uses, so
   * asking it to "put the film together" and pressing the button here give the
   * same timeline rather than two that drift apart.
   */
  app.post("/creative/projects/:id/assemble", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const project = await db.creativeProject.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId, deletedAt: null } });
    if (!project) return reply.code(404).send({ error: "not_found" });

    const res = await assembleFilm(db, { tenantId: u.tenantId, projectId: project.id, userId: u.sub, actorType: "user" });
    if (!res.ok) return reply.code(400).send({ error: res.code, reason: res.reason });
    return reply.send({ documentId: res.documentId, revision: res.revision, clips: res.clips, skipped: res.skipped });
  });

  /**
   * Render the timeline into one film. This runs on our own machines with
   * FFmpeg — the customer's finished cut never passes through a third party to
   * be joined — so it costs nothing per run and no engine is chosen.
   */
  app.post("/creative/projects/:id/render", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    if (!(await needs(req, reply, "can_creative_generate_video", "render a film"))) return;

    const project = await db.creativeProject.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId, deletedAt: null } });
    if (!project) return reply.code(404).send({ error: "not_found" });

    const document = await db.creativeDocument.findFirst({ where: { projectId: project.id, tenantId: u.tenantId, type: "timeline" } });
    const timeline = normaliseTimeline(document?.doc);
    if (!timeline?.clips?.length) {
      return reply.code(400).send({ error: "empty_timeline", reason: "There are no shots on the timeline yet." });
    }

    const quota = await checkQuota(db, u.tenantId, "timeline.render", {});
    if (!quota.ok) return reply.code(429).send({ error: "quota_blocked", reason: quota.reason });

    const { job, deduped } = await createJob(db, {
      tenantId: u.tenantId,
      capability: "timeline.render",
      projectId: project.id,
      requestedByUserId: u.sub,
      // The revision is part of the key, so re-rendering an UNCHANGED timeline
      // returns the same job instead of doing the work twice — but one edit
      // makes it a new render.
      idempotencyKey: `render:${project.id}:${document?.revision ?? 0}`,
      request: { timeline },
      priority: 50,
    });
    if (!job) return reply.code(503).send({ error: "no_engine" });

    await audit({ tenantId: u.tenantId, actorType: "user", actorId: u.sub, action: "creative.render.started", targetType: "CreativeJob", targetId: job.id, detail: { projectId: project.id, clips: timeline.clips.length }, ip: req.ip });
    return reply.send({ job: jobSummary(job), deduped });
  });

  /**
   * The voices a voiceover can be read in. Borrowed from the platform's own
   * ElevenLabs helper rather than a second list, so the studio and the IVR
   * never disagree about what exists. A list we cannot fetch is an empty list,
   * not an error — the default voice still works.
   */
  app.get("/creative/voices", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    try {
      const { resolveCreativeSecret } = await import("./engines");
      const key = await resolveCreativeSecret(db, "elevenlabs_api_key");
      if (!key) return reply.send({ voices: [] });
      const { listElevenLabsVoices } = await import("../voice/elevenLabs");
      const voices = await listElevenLabsVoices(key);
      return reply.send({ voices: (voices || []).slice(0, 60) });
    } catch {
      return reply.send({ voices: [] });
    }
  });

  app.get("/creative/export-presets", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    return reply.send({ presets: Object.entries(EXPORT_PRESETS).map(([id, p]) => ({ id, ...p })) });
  });

  app.post("/creative/export", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    if (!(await needs(req, reply, "can_creative_export", "export finished work"))) return;

    const body = z.object({
      assetId: z.string().max(40),
      presets: z.array(z.string().max(40)).min(1).max(9),
      projectId: z.string().max(40).optional(),
      format: z.enum(["png", "jpg", "webp"]).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const asset = await db.creativeAsset.findFirst({ where: { id: body.data.assetId, tenantId: u.tenantId, deletedAt: null } });
    if (!asset) return reply.code(404).send({ error: "not_found" });

    const unknown = body.data.presets.filter((p) => !EXPORT_PRESETS[p]);
    if (unknown.length) return reply.code(400).send({ error: "unknown_preset", detail: unknown });

    const jobs: any[] = [];
    for (const preset of body.data.presets) {
      const { job } = await createJob(db, {
        tenantId: u.tenantId,
        capability: "export",
        projectId: body.data.projectId || asset.projectId || null,
        requestedByUserId: u.sub,
        idempotencyKey: `export:${asset.id}:${preset}:${body.data.format || "png"}`,
        request: { assetId: asset.id, preset, format: body.data.format },
        priority: 40,
      });
      if (job) jobs.push(jobSummary(job));
    }

    await audit({ tenantId: u.tenantId, actorType: "user", actorId: u.sub, action: "creative.export.started", targetType: "CreativeAsset", targetId: asset.id, detail: { presets: body.data.presets }, ip: req.ip });
    return reply.send({ jobs });
  });

  /* ---------------------------------------------------------------- */
  /* assets                                                            */
  /* ---------------------------------------------------------------- */
  app.get("/creative/assets", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const q = (req.query || {}) as any;
    const where: any = { tenantId: u.tenantId, deletedAt: null };
    if (q.kind) where.kind = String(q.kind);
    if (q.source) where.source = String(q.source);
    if (q.projectId) where.projectId = String(q.projectId);
    if (q.favourite === "1") where.favourite = true;
    const rows = await db.creativeAsset.findMany({ where, orderBy: { createdAt: "desc" }, take: Math.min(200, Number(q.limit || 60)) });
    return reply.send({ assets: rows.map(assetSummary) });
  });

  app.post("/creative/uploads", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    if (!req.isMultipart?.()) return reply.code(400).send({ error: "expected_multipart" });
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
    if (!file) return reply.code(400).send({ error: "no_file" });

    const buffer = await file.toBuffer();
    if (!buffer.length) return reply.code(400).send({ error: "empty_file" });

    // What it really is, from its own bytes. A file that lies is refused.
    const sniffed = sniffMime(buffer);
    if (!sniffed || !ALLOWED_UPLOAD_MIME.has(sniffed)) {
      await audit({ tenantId: u.tenantId, actorType: "user", actorId: u.sub, action: "creative.upload.rejected", result: "denied", detail: { claimed: file.mimetype, sniffed }, ip: req.ip });
      return reply.code(415).send({ error: "unsupported_type", reason: "That kind of file cannot be used here.", sniffed });
    }

    const kind = kindForMime(sniffed);
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const key = buildKey({ tenantId: u.tenantId, kind, assetId: id, name: String(file.filename || "upload") });
    const stored = await putObject(key, buffer, sniffed);
    const asset = await db.creativeAsset.create({
      data: {
        tenantId: u.tenantId,
        projectId: (req.query as any)?.projectId ? String((req.query as any).projectId) : null,
        kind, source: "uploaded", name: String(file.filename || "upload").slice(0, 160),
        storageKey: stored.key, mime: sniffed, bytes: stored.bytes, sha256: stored.sha256,
        scanStatus: "clean",
        license: { source: "uploaded", declaredBy: u.sub, commercialUse: true },
        createdByUserId: u.sub,
      },
    });
    await audit({ tenantId: u.tenantId, actorType: "user", actorId: u.sub, action: "creative.upload", targetType: "CreativeAsset", targetId: asset.id, detail: { bytes: stored.bytes, mime: sniffed }, ip: req.ip });
    return reply.send({ asset: assetSummary(asset) });
  });

  app.patch("/creative/assets/:id", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const asset = await db.creativeAsset.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId, deletedAt: null } });
    if (!asset) return reply.code(404).send({ error: "not_found" });
    const body = z.object({ favourite: z.boolean().optional(), name: z.string().max(160).optional(), projectId: z.string().max(40).nullable().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const updated = await db.creativeAsset.update({ where: { id: asset.id }, data: { ...body.data } });
    return reply.send({ asset: assetSummary(updated) });
  });

  app.delete("/creative/assets/:id", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const asset = await db.creativeAsset.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId, deletedAt: null } });
    if (!asset) return reply.code(404).send({ error: "not_found" });
    if (!keyBelongsToTenant(asset.storageKey, u.tenantId)) return reply.code(404).send({ error: "not_found" });
    await deleteObject(asset.storageKey).catch(() => undefined);
    if (asset.thumbKey) await deleteObject(asset.thumbKey).catch(() => undefined);
    await db.creativeAsset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } });
    await audit({ tenantId: u.tenantId, actorType: "user", actorId: u.sub, action: "creative.asset.deleted", targetType: "CreativeAsset", targetId: asset.id, ip: req.ip });
    return reply.send({ ok: true });
  });

  app.get("/creative/storage", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const [bytes, quota] = await Promise.all([tenantBytes(u.tenantId).catch(() => 0), quotaFor(db, u.tenantId)]);
    return reply.send({ bytes, limitGb: quota.storageGb });
  });

  /* ---------------------------------------------------------------- */
  /* brand kit                                                         */
  /* ---------------------------------------------------------------- */
  app.get("/creative/brand-kit", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    let kit = await db.creativeBrandKit.findFirst({ where: { tenantId: u.tenantId, isDefault: true }, include: { items: { orderBy: { sortOrder: "asc" } } } });
    if (!kit) {
      kit = await db.creativeBrandKit.create({ data: { tenantId: u.tenantId, name: "Our brand", isDefault: true, guidance: {} as any }, include: { items: true } });
    }
    return reply.send({ brandKit: { id: kit.id, name: kit.name, guidance: kit.guidance, items: kit.items.map((i: any) => ({ id: i.id, type: i.type, label: i.label, value: i.value, assetId: i.assetId, sortOrder: i.sortOrder })) } });
  });

  app.put("/creative/brand-kit", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    if (!(await needs(req, reply, "can_manage_creative_brand_kit", "change the brand kit"))) return;
    const body = z.object({
      name: z.string().max(120).optional(),
      guidance: z.object({ voice: z.string().max(2000).optional(), prohibitions: z.array(z.string().max(160)).max(30).optional(), claims: z.array(z.string().max(200)).max(30).optional(), ctas: z.array(z.string().max(80)).max(20).optional(), legal: z.string().max(1000).optional() }).optional(),
      items: z.array(z.object({
        type: z.enum(["color", "font", "logo", "image", "template", "claim", "cta", "disclaimer", "prohibition"]),
        label: z.string().max(120),
        value: z.any(),
        assetId: z.string().max(40).optional(),
      })).max(200).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    let kit = await db.creativeBrandKit.findFirst({ where: { tenantId: u.tenantId, isDefault: true } });
    if (!kit) kit = await db.creativeBrandKit.create({ data: { tenantId: u.tenantId, name: body.data.name || "Our brand", isDefault: true } });
    kit = await db.creativeBrandKit.update({ where: { id: kit.id }, data: { name: body.data.name ?? kit.name, guidance: (body.data.guidance ?? kit.guidance) as any } });

    if (body.data.items) {
      await db.creativeBrandKitItem.deleteMany({ where: { brandKitId: kit.id } });
      for (const [i, item] of body.data.items.entries()) {
        await db.creativeBrandKitItem.create({ data: { tenantId: u.tenantId, brandKitId: kit.id, type: item.type, label: item.label, value: item.value as any, assetId: item.assetId || null, sortOrder: i } });
      }
    }
    await audit({ tenantId: u.tenantId, actorType: "user", actorId: u.sub, action: "creative.brandkit.saved", targetType: "CreativeBrandKit", targetId: kit.id, ip: req.ip });
    const fresh = await db.creativeBrandKit.findFirst({ where: { id: kit.id }, include: { items: { orderBy: { sortOrder: "asc" } } } });
    return reply.send({ brandKit: { id: fresh.id, name: fresh.name, guidance: fresh.guidance, items: fresh.items } });
  });

  /* ---------------------------------------------------------------- */
  /* memory + feedback                                                 */
  /* ---------------------------------------------------------------- */
  app.get("/creative/memory", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const items = await listMemory(db, u.tenantId, u.sub);
    return reply.send({
      items: items.map((m: any) => ({
        id: m.id, scope: m.scope, dimension: m.dimension, statement: m.statement,
        value: (m.value as any)?.text ?? m.value, status: m.status, evidenceCount: m.evidenceCount,
        confidence: m.confidence, lastEvidenceAt: m.lastEvidenceAt,
        evidence: (m.evidence || []).map((e: any) => ({ id: e.id, note: e.note, createdAt: e.createdAt })),
      })),
    });
  });

  app.patch("/creative/memory/:id", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const item = await db.creativeMemoryItem.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId } });
    if (!item) return reply.code(404).send({ error: "not_found" });
    const body = z.object({ status: z.enum(["active", "pinned", "disabled", "suggested"]).optional(), statement: z.string().max(300).optional(), value: z.string().max(500).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    // A company-wide rule is an admin's call; an ordinary user may only change
    // their own preferences.
    if (item.scope === "company" && u.role !== "TENANT_ADMIN" && u.role !== "SUPER_ADMIN") {
      return reply.code(403).send({ error: "admin_only", reason: "A company-wide rule can only be changed by an admin." });
    }
    const updated = await db.creativeMemoryItem.update({
      where: { id: item.id },
      data: {
        ...(body.data.status ? { status: body.data.status, origin: "manual" } : {}),
        ...(body.data.statement ? { statement: body.data.statement } : {}),
        ...(body.data.value ? { value: { text: body.data.value } as any } : {}),
      },
    });
    await audit({ tenantId: u.tenantId, actorType: "user", actorId: u.sub, action: "creative.memory.updated", targetType: "CreativeMemoryItem", targetId: item.id, detail: { status: updated.status }, ip: req.ip });
    return reply.send({ ok: true, item: { id: updated.id, status: updated.status, statement: updated.statement } });
  });

  app.delete("/creative/memory/:id", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const item = await db.creativeMemoryItem.findFirst({ where: { id: String(req.params.id), tenantId: u.tenantId } });
    if (!item) return reply.code(404).send({ error: "not_found" });
    if (item.scope === "company" && u.role !== "TENANT_ADMIN" && u.role !== "SUPER_ADMIN") return reply.code(403).send({ error: "admin_only" });
    await db.creativeMemoryItem.delete({ where: { id: item.id } });
    return reply.send({ ok: true });
  });

  app.post("/creative/memory/reset", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const body = z.object({ scopes: z.array(z.enum(["user", "company", "workflow", "project"])).min(1) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    if (body.data.scopes.includes("company") && u.role !== "TENANT_ADMIN" && u.role !== "SUPER_ADMIN") return reply.code(403).send({ error: "admin_only" });
    const where: any = { tenantId: u.tenantId, scope: { in: body.data.scopes } };
    if (body.data.scopes.includes("user") && body.data.scopes.length === 1) where.userId = u.sub;
    const res = await db.creativeMemoryItem.deleteMany({ where });
    await audit({ tenantId: u.tenantId, actorType: "user", actorId: u.sub, action: "creative.memory.reset", detail: { scopes: body.data.scopes, removed: res.count }, ip: req.ip });
    return reply.send({ ok: true, removed: res.count });
  });

  app.post("/creative/feedback", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const body = z.object({
      subjectType: z.string().max(40),
      subjectId: z.string().max(40).optional(),
      projectId: z.string().max(40).optional(),
      signal: z.enum(["accept", "reject", "regenerate", "edit", "export", "favourite"]),
      reasonCodes: z.array(z.string().max(40)).max(10).optional(),
      detail: z.any().optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const res = await recordFeedback(db, { tenantId: u.tenantId, userId: u.sub, ...body.data });

    if (body.data.subjectType === "generation" && body.data.subjectId) {
      await db.creativeGeneration.updateMany({
        where: { id: body.data.subjectId, tenantId: u.tenantId },
        data: { outcome: body.data.signal === "reject" ? "rejected" : body.data.signal === "accept" || body.data.signal === "favourite" ? "kept" : undefined },
      }).catch(() => undefined);
    }
    return reply.send({ ok: true, learned: res.learned });
  });

  /* ---------------------------------------------------------------- */
  /* engines a customer may pick from                                  */
  /* ---------------------------------------------------------------- */
  app.get("/creative/engines", async (req: any, reply: any) => {
    const u = tenantUser(req, reply);
    if (!u) return;
    const quota = await quotaFor(db, u.tenantId);
    const rows = await db.creativeEngine.findMany({ where: { enabled: true, commercialOk: true }, orderBy: { sortOrder: "asc" } });
    return reply.send({
      engines: rows.map((e: any) => ({ id: e.id, label: e.label, capabilities: e.capabilities, limits: e.limits, isDefault: e.isDefault, placement: e.placement, notes: e.notes })),
      premiumAllowed: quota.premiumEngines,
    });
  });
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export { loadBrandKit, applyOps };
