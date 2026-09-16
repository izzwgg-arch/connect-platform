/**
 * Creative Studio — the job engine.
 *
 * A job row in Postgres is the truth. Everything else (the queue, the poller,
 * the page you are looking at) is a way of moving it along. That is what makes
 * closing Loopcom harmless, a restart survivable, and a second click on
 * "Render" cost nothing.
 *
 * The rules this file exists to enforce:
 *   - the same request twice is the same job (idempotencyKey), never a second charge;
 *   - a job belongs to exactly one runner at a time (claim + lease + heartbeat);
 *   - a runner that dies loses its lease and the work is picked up again, with
 *     everything it already finished intact;
 *   - money is checked BEFORE a provider is called, never after;
 *   - a refusal is final and explained; a wobble is retried, at most twice.
 */
import crypto from "crypto";
import path from "path";
import { promises as fs } from "fs";
import { ADAPTERS, chooseEngine, Capability, EngineContext, EngineOutput, planVideoSegments } from "./engines";
import { getObject, deleteObject } from "./storage";
import { saveOutputAsset } from "./assets";
import { LOCAL_CAPABILITIES, runLocalJob } from "./localJobs";
import * as media from "./media";

export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 15_000;
const MAX_VIDEO_SECONDS = 15;

export function periodOf(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}
export function dayOf(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export const DEFAULT_QUOTA = { videoSeconds: 120, images: 1000, storageGb: 20, maxConcurrent: 2, premiumEngines: false };

export async function quotaFor(db: any, tenantId: string): Promise<typeof DEFAULT_QUOTA> {
  const row = await db.creativeQuota.findUnique({ where: { tenantId } }).catch(() => null);
  return row ? { videoSeconds: row.videoSeconds, images: row.images, storageGb: row.storageGb, maxConcurrent: row.maxConcurrent, premiumEngines: row.premiumEngines } : { ...DEFAULT_QUOTA };
}

export async function usedThisPeriod(db: any, tenantId: string): Promise<{ videoSeconds: number; images: number }> {
  const rows = await db.creativeUsage.groupBy({
    by: ["measure"],
    where: { tenantId, period: periodOf() },
    _sum: { quantity: true },
  }).catch(() => [] as any[]);
  const get = (m: string) => Number(rows.find((r: any) => r.measure === m)?._sum?.quantity || 0);
  return { videoSeconds: get("video_seconds"), images: get("images") };
}

export function estimateCostMicros(capability: string, request: any, engine: any): number {
  const cost = engine?.costModel || {};
  const micros = Number(cost.micros || 0);
  if (capability === "video.generate") return micros * Math.max(1, Number(request.seconds || 4));
  if (capability === "image.generate" || capability === "image.edit") {
    const qualityMultiplier = request.quality === "high" ? 14 : request.quality === "medium" ? 3.75 : 1;
    return Math.round(micros * qualityMultiplier * Math.max(1, Number(request.count || 1)));
  }
  if (capability === "audio.speech") return Math.round(micros * String(request.text || "").length);
  if (capability === "audio.music") return Math.round((Number(request.durationMs || 15000) / 60_000) * micros);
  return micros;
}

export type QuotaVerdict = { ok: true } | { ok: false; reason: string; code: string };

/** Checked before anything is queued, so nothing is half-charged. */
export async function checkQuota(db: any, tenantId: string, capability: string, request: any): Promise<QuotaVerdict> {
  const quota = await quotaFor(db, tenantId);
  const used = await usedThisPeriod(db, tenantId);

  if (capability === "video.generate") {
    const want = Math.max(1, Number(request.seconds || 4));
    if (used.videoSeconds + want > quota.videoSeconds) {
      return {
        ok: false,
        code: "quota_video",
        reason: `That would use ${want} seconds of video and only ${Math.max(0, quota.videoSeconds - used.videoSeconds)} are left this month. Images and designs still work, and it resets on the 1st.`,
      };
    }
  }
  if (capability === "image.generate" || capability === "image.edit") {
    const want = Math.max(1, Number(request.count || 1));
    if (used.images + want > quota.images) {
      return { ok: false, code: "quota_images", reason: `That would pass this month's picture allowance (${quota.images}).` };
    }
  }

  const running = await db.creativeJob.count({ where: { tenantId, status: { in: ["queued", "claimed", "running", "evaluating", "retrying"] } } });
  if (running >= quota.maxConcurrent) {
    return { ok: false, code: "quota_concurrent", reason: `You already have ${running} jobs running. They will finish on their own — try again in a moment.` };
  }
  return { ok: true };
}

export function idempotencyKeyFor(capability: string, request: any, extra = ""): string {
  const canonical = JSON.stringify({ capability, request, extra }, Object.keys({ capability, request, extra }).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 40);
}

export interface CreateJobInput {
  tenantId: string;
  capability: Capability | string;
  request: any;
  projectId?: string | null;
  requestedByUserId?: string | null;
  turnId?: string | null;
  engineId?: string | null;
  idempotencyKey?: string;
  priority?: number;
}

/** Creates a job, or hands back the identical one already in flight. */
export async function createJob(db: any, input: CreateJobInput): Promise<{ job: any; deduped: boolean; refused?: string }> {
  const key = input.idempotencyKey || idempotencyKeyFor(input.capability, input.request, input.projectId || "");
  const existing = await db.creativeJob.findUnique({ where: { tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey: key } } }).catch(() => null);
  if (existing) return { job: existing, deduped: true };

  const local = LOCAL_CAPABILITIES.has(String(input.capability));
  const engine = local ? null : await chooseEngine(db, input.capability as Capability, input.engineId);
  if (!local && !engine) {
    return { job: null, deduped: false, refused: "No engine is switched on for that yet. An admin turns these on in the Creative Studio console." };
  }

  const job = await db.creativeJob.create({
    data: {
      tenantId: input.tenantId,
      projectId: input.projectId || null,
      capability: input.capability,
      status: "queued",
      idempotencyKey: key,
      request: input.request,
      engineId: engine ? engine.id : "loopcom.local",
      priority: input.priority ?? 100,
      requestedByUserId: input.requestedByUserId || null,
      turnId: input.turnId || null,
      costMicros: engine ? estimateCostMicros(input.capability, input.request, engine) : 0,
    },
  });
  return { job, deduped: false };
}

/* ------------------------------------------------------------------ */
/* claiming                                                            */
/* ------------------------------------------------------------------ */

export async function claimJobs(db: any, workerId: string, limit = 2): Promise<any[]> {
  const candidates = await db.creativeJob.findMany({
    where: { status: "queued" },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take: limit * 3,
  });
  const claimed: any[] = [];
  for (const c of candidates) {
    if (claimed.length >= limit) break;
    // Only one runner can win this: the update is conditional on the row still
    // being queued, and Postgres serialises it for us.
    const res = await db.creativeJob.updateMany({
      where: { id: c.id, status: "queued" },
      data: { status: "claimed", workerId, leaseExpiresAt: new Date(Date.now() + LEASE_MS), heartbeatAt: new Date(), startedAt: c.startedAt || new Date(), attempts: { increment: 1 } },
    });
    if (res.count === 1) claimed.push(await db.creativeJob.findUnique({ where: { id: c.id } }));
  }
  return claimed;
}

export async function heartbeat(db: any, jobId: string, workerId: string, progress?: number, note?: string): Promise<void> {
  await db.creativeJob.updateMany({
    where: { id: jobId, workerId },
    data: {
      heartbeatAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      ...(progress != null ? { progress: Math.max(0, Math.min(100, Math.round(progress))) } : {}),
      ...(note ? { progressNote: String(note).slice(0, 200) } : {}),
    },
  });
}

/**
 * A runner that stopped sending heartbeats loses its claim and the job goes
 * back in the queue with everything it already finished intact.
 */
export async function sweepLostLeases(db: any): Promise<number> {
  const lost = await db.creativeJob.findMany({
    where: { status: { in: ["claimed", "running"] }, leaseExpiresAt: { lt: new Date() } },
    take: 50,
  });
  let requeued = 0;
  for (const job of lost) {
    // A provider-side job keeps running; we go back to polling it rather than
    // paying for it twice.
    const backTo = job.providerJobId ? "running" : "queued";
    const res = await db.creativeJob.updateMany({
      where: { id: job.id, status: job.status },
      data: {
        status: job.attempts >= job.maxAttempts && backTo === "queued" ? "failed" : backTo,
        workerId: null,
        leaseExpiresAt: null,
        progressNote: job.providerJobId ? "Picked up again after a worker stopped" : "Back in the queue after a worker stopped",
        ...(job.attempts >= job.maxAttempts && backTo === "queued"
          ? { error: "The render did not finish after several attempts.", errorCode: "lease_exhausted", finishedAt: new Date() }
          : {}),
      },
    });
    if (res.count) requeued++;
  }
  return requeued;
}

/* ------------------------------------------------------------------ */
/* results                                                             */
/* ------------------------------------------------------------------ */

export async function recordUsage(db: any, tenantId: string, opts: { jobId?: string; capability: string; engineId?: string; measure: string; quantity: number; costMicros: number; wasted?: boolean }): Promise<void> {
  await db.creativeUsage.create({
    data: {
      tenantId,
      jobId: opts.jobId || null,
      capability: opts.capability,
      engineId: opts.engineId || null,
      measure: opts.measure,
      quantity: opts.quantity,
      costMicros: opts.costMicros,
      wasted: !!opts.wasted,
      period: periodOf(),
    },
  }).catch(() => undefined);
}

/** Platform-wide engine scorecard: timings, successes and cost. No content. */
export async function bumpEngineStat(db: any, engineId: string, capability: string, opts: { ms?: number; failed?: boolean; costMicros?: number }): Promise<void> {
  const day = dayOf();
  await db.creativeEngineStat.upsert({
    where: { engineId_capability_day: { engineId, capability, day } },
    create: {
      engineId, capability, day,
      runs: 1, failures: opts.failed ? 1 : 0,
      totalMs: opts.ms || 0, p95Ms: opts.ms || 0, totalCostMicros: opts.costMicros || 0,
    },
    update: {
      runs: { increment: 1 },
      failures: { increment: opts.failed ? 1 : 0 },
      totalMs: { increment: opts.ms || 0 },
      totalCostMicros: { increment: opts.costMicros || 0 },
    },
  }).catch(() => undefined);
}

export async function failJob(db: any, job: any, error: string, errorCode: string, opts: { permanent?: boolean } = {}): Promise<void> {
  const permanent = opts.permanent || errorCode === "refused" || errorCode === "no_key" || job.attempts >= job.maxAttempts;
  await db.creativeJob.update({
    where: { id: job.id },
    data: permanent
      ? { status: "failed", error: String(error).slice(0, 500), errorCode, finishedAt: new Date(), workerId: null, leaseExpiresAt: null, progressNote: null }
      : { status: "queued", error: String(error).slice(0, 500), errorCode, workerId: null, leaseExpiresAt: null, progressNote: "Trying again" },
  });
  await bumpEngineStat(db, job.engineId || "unknown", job.capability, { failed: true });
}

/* ------------------------------------------------------------------ */
/* running                                                             */
/* ------------------------------------------------------------------ */

export interface RunnerDeps {
  db: any;
  workerId: string;
  log?: (msg: string, extra?: any) => void;
}

function engineCtx(db: any, tenantId: string): EngineContext {
  return {
    db,
    readAsset: async (assetId: string) => {
      const asset = await db.creativeAsset.findFirst({ where: { id: assetId, tenantId, deletedAt: null } });
      if (!asset) return null;
      const got = await getObject(asset.storageKey);
      return { buffer: got.body, mime: asset.mime || got.contentType };
    },
  };
}

/**
 * One pass over a claimed job. Image and audio jobs finish inside this call;
 * video jobs hand back a provider id and are polled afterwards, because a
 * render takes minutes and nothing may hold an HTTP request open for that.
 */
export async function runJob(deps: RunnerDeps, job: any): Promise<void> {
  const { db } = deps;

  // Joining, exporting and re-framing run on our own machines with FFmpeg.
  if (LOCAL_CAPABILITIES.has(String(job.capability))) {
    const started = Date.now();
    await db.creativeJob.update({ where: { id: job.id }, data: { status: "running", progress: 10, progressNote: "Working on it" } });
    try {
      const res = await runLocalJob({ db, workerId: deps.workerId }, job);
      await completeJob(deps, job, [], { renderMs: Date.now() - started, costMicros: 0, existingAssetIds: res.assetIds });
    } catch (e: any) {
      await failJob(db, job, String(e?.message || e).slice(0, 400), "render_failed");
    }
    return;
  }

  const engine = await db.creativeEngine.findUnique({ where: { id: job.engineId } });
  const adapter = engine ? ADAPTERS[engine.id] : null;
  if (!engine || !adapter) {
    await failJob(db, job, "That engine is no longer available.", "engine_missing", { permanent: true });
    return;
  }

  const started = Date.now();
  await db.creativeJob.update({ where: { id: job.id }, data: { status: "running", progress: 5, progressNote: "Starting" } });

  const request = { ...(job.request as any) };
  const ctx = engineCtx(db, job.tenantId);

  // A shot longer than the engine's native clip becomes several segments that
  // continue from each other. The customer asked for one shot.
  if (job.capability === "video.generate") {
    const wanted = Math.max(1, Math.min(MAX_VIDEO_SECONDS, Number(request.seconds || 4)));
    const plan = (request.plan as any) || { segments: planVideoSegments(wanted).map((s, i) => ({ index: i, seconds: s, status: "pending" })), wanted };
    request.plan = plan;
    const next = plan.segments.find((s: any) => s.status === "pending");
    if (!next) {
      await finishVideoJob(deps, job, plan);
      return;
    }
    const segRequest = {
      ...request,
      seconds: next.seconds,
      firstFrameAssetId: next.fromFrameAssetId || request.firstFrameAssetId,
    };
    const res = await adapter.start(segRequest, ctx);
    if (res.status === "failed") {
      await failJob(db, job, res.error || "The engine refused.", res.errorCode || "engine_error");
      return;
    }
    next.status = "running";
    next.providerJobId = res.providerJobId;
    await db.creativeJob.update({
      where: { id: job.id },
      data: {
        status: "running",
        providerJobId: res.providerJobId || null,
        request: request as any,
        progress: Math.max(5, Math.round((plan.segments.filter((s: any) => s.status === "done").length / plan.segments.length) * 90)),
        progressNote: plan.segments.length > 1 ? `Part ${next.index + 1} of ${plan.segments.length}` : "Rendering",
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      },
    });
    return;
  }

  // Everything else finishes here.
  const res = await adapter.start(request, ctx);
  if (res.status === "failed") {
    await failJob(db, job, res.error || "The engine refused.", res.errorCode || "engine_error");
    return;
  }
  if (res.status === "running") {
    await db.creativeJob.update({ where: { id: job.id }, data: { status: "running", providerJobId: res.providerJobId || null, progress: res.progress || 10 } });
    return;
  }
  await completeJob(deps, job, res.outputs || [], { renderMs: Date.now() - started, costMicros: res.costMicros || job.costMicros, meta: res.meta });
}

/** Poll provider-side jobs. Called on a timer; never holds a request open. */
export async function pollRunningJobs(deps: RunnerDeps, limit = 6): Promise<number> {
  const { db } = deps;
  const rows = await db.creativeJob.findMany({
    where: { status: "running", providerJobId: { not: null } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let advanced = 0;
  for (const job of rows) {
    const engine = await db.creativeEngine.findUnique({ where: { id: job.engineId } });
    const adapter = engine ? ADAPTERS[engine.id] : null;
    if (!adapter?.poll) continue;
    const ctx = engineCtx(db, job.tenantId);
    let res;
    try {
      res = await adapter.poll(job.providerJobId, ctx);
    } catch (e: any) {
      await heartbeat(db, job.id, job.workerId || deps.workerId, undefined, "Waiting for the engine");
      continue;
    }
    if (res.status === "running") {
      await db.creativeJob.update({
        where: { id: job.id },
        data: { progress: Math.max(job.progress, Math.min(95, Number(res.progress || job.progress))), heartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
      });
      continue;
    }
    advanced++;
    if (res.status === "failed") {
      await failJob(db, job, res.error || "The engine could not finish it.", res.errorCode || "engine_error");
      continue;
    }

    if (job.capability === "video.generate") {
      await absorbVideoSegment(deps, job, res.outputs || []);
      continue;
    }
    await completeJob(deps, job, res.outputs || [], { renderMs: Date.now() - new Date(job.startedAt || job.createdAt).getTime(), costMicros: job.costMicros, meta: res.meta });
  }
  return advanced;
}

/** One finished segment: store it, then either start the next or join them. */
async function absorbVideoSegment(deps: RunnerDeps, job: any, outputs: EngineOutput[]): Promise<void> {
  const { db } = deps;
  const request = { ...(job.request as any) };
  const plan = request.plan;
  const seg = plan?.segments?.find((s: any) => s.status === "running") || plan?.segments?.[0];
  if (!plan || !seg) {
    await completeJob(deps, job, outputs, { renderMs: 0, costMicros: job.costMicros });
    return;
  }

  const output = outputs[0];
  if (!output) {
    await failJob(db, job, "The engine finished but produced no video.", "empty_result");
    return;
  }

  // Segments are intermediates: kept a week, not forever.
  const asset = await saveOutputAsset(db, {
    tenantId: job.tenantId,
    projectId: job.projectId,
    kind: "video",
    source: "generated",
    output,
    createdByUserId: job.requestedByUserId,
    expiresAt: plan.segments.length > 1 ? new Date(Date.now() + 7 * 24 * 3600_000) : null,
  });
  seg.status = "done";
  seg.assetId = asset.id;

  const nextPending = plan.segments.find((s: any) => s.status === "pending");
  if (nextPending) {
    // The next piece continues from this one's last frame.
    try {
      const frameAsset = await media.withTempDir(async (dir) => {
        const src = path.join(dir, media.tempName("mp4"));
        await fs.writeFile(src, output.buffer);
        const frame = path.join(dir, media.tempName("png"));
        await media.lastFrame(src, frame);
        const bytes = await fs.readFile(frame);
        return saveOutputAsset(db, {
          tenantId: job.tenantId,
          projectId: job.projectId,
          kind: "image",
          source: "generated",
          output: { buffer: bytes, mime: "image/png", name: "continuation-frame.png" },
          createdByUserId: job.requestedByUserId,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000),
        });
      });
      nextPending.fromFrameAssetId = frameAsset.id;
    } catch {
      // Without a continuation frame the next piece still renders; it just
      // starts fresh instead of continuing. Better than failing the whole shot.
    }
    await db.creativeJob.update({
      where: { id: job.id },
      data: { status: "queued", providerJobId: null, request: request as any, progress: Math.round((plan.segments.filter((s: any) => s.status === "done").length / plan.segments.length) * 85), progressNote: `Part ${nextPending.index + 1} of ${plan.segments.length}`, workerId: null, leaseExpiresAt: null },
    });
    return;
  }

  await db.creativeJob.update({ where: { id: job.id }, data: { request: request as any, status: "running", progressNote: "Joining the parts", progress: 90 } });
  await finishVideoJob(deps, { ...job, request }, plan);
}

/** All segments done: join them, trim to what was asked, store the result. */
async function finishVideoJob(deps: RunnerDeps, job: any, plan: any): Promise<void> {
  const { db } = deps;
  const segmentAssets: any[] = [];
  for (const seg of plan.segments) {
    if (!seg.assetId) continue;
    const a = await db.creativeAsset.findFirst({ where: { id: seg.assetId, tenantId: job.tenantId } });
    if (a) segmentAssets.push(a);
  }
  if (!segmentAssets.length) {
    await failJob(db, job, "The parts of that shot went missing before they could be joined.", "segments_missing", { permanent: true });
    return;
  }

  if (segmentAssets.length === 1 && Number(plan.wanted || 0) >= (segmentAssets[0].durationMs || 0) / 1000) {
    const only = segmentAssets[0];
    await completeJob(deps, job, [], { renderMs: 0, costMicros: job.costMicros, existingAssetIds: [only.id] });
    return;
  }

  const finalAsset = await media.withTempDir(async (dir) => {
    const files: string[] = [];
    for (const [i, a] of segmentAssets.entries()) {
      const got = await getObject(a.storageKey);
      const f = path.join(dir, `seg-${i}.mp4`);
      await fs.writeFile(f, got.body);
      files.push(f);
    }
    const joined = path.join(dir, "joined.mp4");
    await media.concat(files, joined, { width: segmentAssets[0].width || 1280, height: segmentAssets[0].height || 720 });
    let out = joined;
    const wanted = Number(plan.wanted || 0);
    const info = await media.probe(joined);
    if (wanted && info.durationMs > wanted * 1000 + 250) {
      const trimmed = path.join(dir, "trimmed.mp4");
      await media.trimTo(joined, trimmed, wanted);
      out = trimmed;
    }
    const buffer = await fs.readFile(out);
    return saveOutputAsset(db, {
      tenantId: job.tenantId,
      projectId: job.projectId,
      kind: "video",
      source: "generated",
      output: { buffer, mime: "video/mp4", name: "shot.mp4" },
      createdByUserId: job.requestedByUserId,
    });
  });

  await completeJob(deps, job, [], { renderMs: 0, costMicros: job.costMicros, existingAssetIds: [finalAsset.id] });
}

export async function completeJob(
  deps: RunnerDeps,
  job: any,
  outputs: EngineOutput[],
  opts: { renderMs: number; costMicros: number; meta?: any; existingAssetIds?: string[] },
): Promise<any[]> {
  const { db } = deps;
  const kind = job.capability.startsWith("video") ? "video" : job.capability.startsWith("audio") ? "audio" : "image";

  const assets: any[] = [];
  for (const id of opts.existingAssetIds || []) {
    const a = await db.creativeAsset.findFirst({ where: { id, tenantId: job.tenantId } });
    if (a) assets.push(a);
  }
  for (const output of outputs) {
    assets.push(await saveOutputAsset(db, {
      tenantId: job.tenantId,
      projectId: job.projectId,
      kind,
      source: "generated",
      output,
      createdByUserId: job.requestedByUserId,
    }));
  }

  const request: any = job.request || {};
  await db.creativeGeneration.create({
    data: {
      tenantId: job.tenantId,
      projectId: job.projectId,
      jobId: job.id,
      capability: job.capability,
      request: String(request.request || request.prompt || "").slice(0, 2000),
      builtPrompt: String(request.prompt || "").slice(0, 4000),
      negative: request.negative ? String(request.negative).slice(0, 1000) : null,
      engineId: job.engineId || "unknown",
      engineVersion: opts.meta?.model || null,
      params: { ...request, plan: undefined } as any,
      seed: request.seed ? String(request.seed) : null,
      referenceIds: (request.referenceAssetIds || []).map((r: any) => String(r)),
      outputAssetIds: assets.map((a) => a.id),
      workerId: job.workerId || deps.workerId,
      renderMs: opts.renderMs || null,
      costMicros: opts.costMicros || 0,
    },
  }).catch(() => undefined);

  await db.creativeJob.update({
    where: { id: job.id },
    data: { status: "succeeded", progress: 100, progressNote: null, finishedAt: new Date(), costMicros: opts.costMicros || job.costMicros, error: null, errorCode: null, workerId: null, leaseExpiresAt: null },
  });

  if (job.projectId) {
    await db.creativeProject.update({ where: { id: job.projectId }, data: { spentMicros: { increment: opts.costMicros || 0 }, updatedAt: new Date() } }).catch(() => undefined);
  }

  const measure = kind === "video" ? "video_seconds" : kind === "image" ? "images" : "audio_seconds";
  const quantity = kind === "video"
    ? Math.round((assets.reduce((n, a) => Math.max(n, a.durationMs || 0), 0) || Number(request.seconds || 0) * 1000) / 1000)
    : kind === "image" ? assets.length
    : Math.round((assets.reduce((n, a) => Math.max(n, a.durationMs || 0), 0)) / 1000);
  await recordUsage(db, job.tenantId, { jobId: job.id, capability: job.capability, engineId: job.engineId, measure, quantity, costMicros: opts.costMicros || 0 });
  await bumpEngineStat(db, job.engineId || "unknown", job.capability, { ms: opts.renderMs || 0, costMicros: opts.costMicros || 0 });

  return assets;
}

export async function cancelJob(db: any, tenantId: string, jobId: string): Promise<{ ok: boolean; reason?: string }> {
  const job = await db.creativeJob.findFirst({ where: { id: jobId, tenantId } });
  if (!job) return { ok: false, reason: "not_found" };
  if (["succeeded", "failed", "cancelled"].includes(job.status)) return { ok: false, reason: "already_finished" };

  // Read what we need BEFORE the update: depending on the client, `job` may be
  // the very row the update mutates, and "was it running?" must mean what it
  // meant when we looked.
  const wasRunning = job.status === "running";
  const spentMicros = Number(job.costMicros || 0);

  if (job.providerJobId) {
    const engine = await db.creativeEngine.findUnique({ where: { id: job.engineId } });
    const adapter = engine ? ADAPTERS[engine.id] : null;
    // Cancelling must reach the provider, or we keep paying for work nobody wants.
    if (adapter?.cancel) await adapter.cancel(job.providerJobId, { db }).catch(() => undefined);
  }
  await db.creativeJob.update({
    where: { id: job.id },
    data: { status: "cancelled", cancelledAt: new Date(), finishedAt: new Date(), workerId: null, leaseExpiresAt: null, progressNote: null },
  });
  // Work the provider already did is still charged: say so rather than hide it.
  if (wasRunning && spentMicros) {
    await recordUsage(db, tenantId, { jobId: job.id, capability: job.capability, engineId: job.engineId, measure: "retry", quantity: 1, costMicros: Math.round(spentMicros * 0.5), wasted: true });
  }
  return { ok: true };
}

/** Delete the assets whose keep-until date has passed. */
export async function sweepExpiredAssets(db: any, limit = 100): Promise<number> {
  const rows = await db.creativeAsset.findMany({ where: { expiresAt: { lt: new Date() }, deletedAt: null }, take: limit });
  let removed = 0;
  for (const a of rows) {
    await deleteObject(a.storageKey).catch(() => undefined);
    if (a.thumbKey) await deleteObject(a.thumbKey).catch(() => undefined);
    await db.creativeAsset.update({ where: { id: a.id }, data: { deletedAt: new Date() } }).catch(() => undefined);
    removed++;
  }
  return removed;
}

/** One pass of everything: claim, run, poll, sweep. Called on a timer. */
export async function runCreativeCycle(deps: RunnerDeps): Promise<{ claimed: number; advanced: number; requeued: number }> {
  const requeued = await sweepLostLeases(deps.db);
  const claimed = await claimJobs(deps.db, deps.workerId, 2);
  for (const job of claimed) {
    try {
      await runJob(deps, job);
    } catch (e: any) {
      await failJob(deps.db, job, String(e?.message || e).slice(0, 400), "runner_error");
    }
  }
  const advanced = await pollRunningJobs(deps);
  return { claimed: claimed.length, advanced, requeued };
}
