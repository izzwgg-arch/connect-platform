/**
 * Yiddish corpus — the durable 24/7 worker.
 *
 * Design rules, each one bought with a past outage somewhere in this repo:
 *
 *  1. ⛔ LEASES, NOT AN IN-MEMORY LOOP. A job is claimed with a conditional
 *     write (`updateMany` on the row's CURRENT state), so two workers racing
 *     on the same row produce exactly one winner, and a worker that dies mid
 *     job has its lease expire and the job reclaimed. A restart never doubles
 *     a job and never loses one.
 *  2. ⛔ A BOOT RUN BEFORE THE INTERVAL. An interval timer with no boot run is
 *     starved by deploys — a container that restarts more often than the
 *     interval never runs the work at all. See the repo memory
 *     `interval-timer-with-no-boot-run-is-starved-by-deploys`.
 *  3. ⛔ AUDIO STAGES ARE *SKIPPED*, NOT FAILED, while the rights gate refuses.
 *     A refusal is a lawful outcome with a reason, not an error. The
 *     metadata-only half of the pipeline therefore runs continuously and
 *     legally today, with the audio stages sitting in the queue as SKIPPED
 *     rows that say why.
 *  4. Budgets are checked before the work, not after the spend.
 */

import { YC_STAGES, YC_AUDIO_STAGES, YC_AUDIO_BLOCKED_MESSAGE, type YcStage } from "./contracts";
import {
  discover as discoverYiddish24,
  fetchAudio as fetchYiddish24Audio,
  resolveAudioGate,
} from "./yiddish24Adapter";
import { scoreNovelty, noveltyToPriority } from "./novelty";
import { detectSegments, extractFeatures } from "./audioPipeline";
import { recordProbes, noteDiscoveryRun, alertIfBroken } from "./siteHealth";

export const YC_DEFAULT_LEASE_MS = 5 * 60_000;
export const YC_DEFAULT_INTERVAL_MS = 60_000;

/**
 * How often a source is re-walked for new material. The worker tick is cheap
 * and frequent; discovery is not, so it gets its own, much slower clock.
 * ⛔ Without this, nothing ever creates the first `discover` job — `enqueueNext`
 * deliberately never re-queues `discover`, so the engine would sit idle for
 * ever while looking healthy.
 */
export const YC_DISCOVERY_EVERY_MS = Number(process.env.YIDDISH_DISCOVERY_EVERY_MS || 30 * 60 * 1000);
export const YC_BACKOFF_BASE_MS = 30_000;
export const YC_BACKOFF_MAX_MS = 6 * 60 * 60_000;
export const YC_WORKER_HEARTBEAT_METRIC = "worker_heartbeat_ms";

/** Stages that never need audio bytes. This is the pipeline that runs today. */
export const YC_METADATA_STAGES: YcStage[] = YC_STAGES.filter(
  (s) => !YC_AUDIO_STAGES.includes(s),
) as YcStage[];

export interface YcJobRow {
  id: string;
  itemId: string | null;
  sourceKey: string;
  stage: string;
  state: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  nextRunAt: Date;
  leaseUntil: Date | null;
  leaseOwner: string | null;
  costCents: number;
  payload: any;
  error: string | null;
}

export interface StageContext {
  db: any;
  job: YcJobRow;
  item: any | null;
  budget: any | null;
  now: Date;
}

export interface StageOutcome {
  ok: boolean;
  /** A lawful refusal (rights gate, budget mode). SKIPPED, never FAILED. */
  skipped?: boolean;
  reason?: string | null;
  costCents?: number;
  transcribedMinutes?: number;
  /** Queue the next stage for this item when the handler finishes. */
  advance?: boolean;
}

export type StageHandler = (ctx: StageContext) => Promise<StageOutcome>;

// ── backoff ─────────────────────────────────────────────────────────────────

/** Exponential with a cap. Exported so the schedule is a test, not a promise. */
export function backoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(YC_BACKOFF_MAX_MS, YC_BACKOFF_BASE_MS * 2 ** (n - 1));
}

// ── budget ──────────────────────────────────────────────────────────────────

function todayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The source's own budget when it has one, otherwise the global row. */
export async function loadBudget(db: any, sourceKey: string): Promise<any | null> {
  const source = await db.ycSource.findUnique({ where: { key: sourceKey }, include: { budget: true } }).catch(() => null);
  if (source?.budget) return source.budget;
  return db.ycBudget.findFirst({ where: { scope: "global" } }).catch(() => null);
}

export interface BudgetVerdict {
  allowed: boolean;
  /** SKIP = a lawful refusal, DEFER = try again after the day rolls. */
  action: "RUN" | "SKIP" | "DEFER" | "PAUSE";
  reason: string | null;
}

/** Does this budget let this stage run right now? Reads only, decides only. */
export function budgetVerdict(budget: any | null, stage: string, now: Date): BudgetVerdict {
  if (!budget) return { allowed: true, action: "RUN", reason: null };
  if (budget.paused) return { allowed: false, action: "PAUSE", reason: "the budget for this source is paused" };

  const isAudio = YC_AUDIO_STAGES.includes(stage as YcStage);
  const mode = String(budget.mode || "METADATA_ONLY");
  if (isAudio && mode === "METADATA_ONLY") {
    return {
      allowed: false,
      action: "SKIP",
      reason: "the run mode is METADATA_ONLY, so the audio stages do not run",
    };
  }
  if (!isAudio && mode === "AUDIO_ONLY" && stage !== "discover" && stage !== "fingerprint") {
    return { allowed: false, action: "SKIP", reason: "the run mode is AUDIO_ONLY" };
  }

  const sameDay = budget.spendDate === todayKey(now);
  const spent = sameDay ? Number(budget.spentCentsToday) || 0 : 0;
  const minutes = sameDay ? Number(budget.transcribedMinutesToday) || 0 : 0;
  const centCap = Number(budget.apiCentsPerDay) || 0;
  const minCap = Number(budget.transcriptionMinutesPerDay) || 0;

  if (stage === "transcribe") {
    if (minCap <= 0) {
      return { allowed: false, action: "DEFER", reason: "no transcription minutes are budgeted for today" };
    }
    if (minutes >= minCap) {
      return { allowed: false, action: "DEFER", reason: `today's ${minCap} transcription minutes are used up` };
    }
  }
  if (centCap > 0 && spent >= centCap) {
    return { allowed: false, action: "DEFER", reason: `today's API budget of ${centCap}¢ is used up` };
  }
  return { allowed: true, action: "RUN", reason: null };
}

/** Add spend to today's counters, rolling the day over when the date changed. */
export async function chargeBudget(
  db: any,
  budget: any | null,
  spend: { costCents?: number; transcribedMinutes?: number },
  now: Date,
): Promise<void> {
  if (!budget) return;
  const cents = Math.max(0, Math.round(Number(spend.costCents) || 0));
  const mins = Math.max(0, Number(spend.transcribedMinutes) || 0);
  if (!cents && !mins) return;
  const day = todayKey(now);
  const rolled = budget.spendDate !== day;
  await db.ycBudget.update({
    where: { id: budget.id },
    data: {
      spendDate: day,
      spentCentsToday: (rolled ? 0 : Number(budget.spentCentsToday) || 0) + cents,
      transcribedMinutesToday: (rolled ? 0 : Number(budget.transcribedMinutesToday) || 0) + mins,
    },
  });
}

// ── the rights gate, asked once per job ─────────────────────────────────────

async function audioGate(db: any, sourceKey: string): Promise<{ ok: boolean; reason: string | null }> {
  // One gate, one loader (yiddish24Adapter.resolveAudioGate), and it already
  // fails closed. A gate that cannot answer REFUSES.
  const res = await resolveAudioGate(db, sourceKey);
  if (res?.ok === true) return { ok: true, reason: null };
  return { ok: false, reason: res?.reason || YC_AUDIO_BLOCKED_MESSAGE };
}

// ── enqueue ─────────────────────────────────────────────────────────────────

export interface EnqueueResult {
  queued: { stage: YcStage; jobId: string } | null;
  skipped: { stage: YcStage; reason: string }[];
  done: boolean;
}

/**
 * Queue the next stage for an item, in YC_STAGES order.
 *
 * Audio stages the gate refuses are written as SKIPPED rows with the reason —
 * visible on the queue screen, honest, and NOT an error — and the walk
 * continues to the next stage that can legally run.
 */
export async function enqueueNext(
  db: any,
  item: any,
  opts: { after?: string | null; now?: Date; sourceKey?: string } = {},
): Promise<EnqueueResult> {
  const now = opts.now ?? new Date();
  const skipped: { stage: YcStage; reason: string }[] = [];
  if (!item?.id) return { queued: null, skipped, done: true };

  const sourceKey = opts.sourceKey ?? item.source?.key ?? item.sourceKey;
  if (!sourceKey) return { queued: null, skipped, done: true };

  const budget = await loadBudget(db, sourceKey);
  let gate: { ok: boolean; reason: string | null } | null = null;

  const startIdx = opts.after ? YC_STAGES.indexOf(opts.after as YcStage) + 1 : 1; // never re-queue `discover`
  for (let i = Math.max(1, startIdx); i < YC_STAGES.length; i += 1) {
    const stage = YC_STAGES[i];

    const existing = await db.ycProcessingJob.findFirst({
      where: { itemId: item.id, stage, state: { in: ["PENDING", "RUNNING", "DONE"] } },
      select: { id: true, state: true },
    });
    if (existing) {
      if (existing.state === "DONE") continue;
      return { queued: null, skipped, done: false }; // already in flight
    }

    if (YC_AUDIO_STAGES.includes(stage)) {
      const verdict = budgetVerdict(budget, stage, now);
      if (verdict.action === "SKIP") {
        await writeSkipped(db, item, sourceKey, stage, verdict.reason || "skipped by the run mode", now);
        skipped.push({ stage, reason: verdict.reason || "skipped by the run mode" });
        continue;
      }
      if (!gate) gate = await audioGate(db, sourceKey);
      if (!gate.ok) {
        await writeSkipped(db, item, sourceKey, stage, gate.reason || YC_AUDIO_BLOCKED_MESSAGE, now);
        skipped.push({ stage, reason: gate.reason || YC_AUDIO_BLOCKED_MESSAGE });
        continue;
      }
    }

    const job = await db.ycProcessingJob.create({
      data: {
        itemId: item.id,
        sourceKey,
        stage,
        state: "PENDING",
        priority: Number.isFinite(item.priority) ? item.priority : 50,
        nextRunAt: now,
      },
    });
    return { queued: { stage, jobId: job.id }, skipped, done: false };
  }

  await db.ycSourceItem
    .update({ where: { id: item.id }, data: { state: "INDEXED" } })
    .catch(() => {});
  return { queued: null, skipped, done: true };
}

async function writeSkipped(
  db: any,
  item: any,
  sourceKey: string,
  stage: string,
  reason: string,
  now: Date,
): Promise<void> {
  const existing = await db.ycProcessingJob.findFirst({ where: { itemId: item.id, stage } });
  const data = {
    state: "SKIPPED",
    error: reason,
    nextRunAt: now,
    leaseUntil: null,
    leaseOwner: null,
  };
  if (existing) await db.ycProcessingJob.update({ where: { id: existing.id }, data });
  else
    await db.ycProcessingJob.create({
      data: { ...data, itemId: item.id, sourceKey, stage, priority: 90 },
    });
}

// ── claiming ────────────────────────────────────────────────────────────────

export interface ClaimOptions {
  leaseOwner: string;
  limit?: number;
  now?: Date;
  leaseMs?: number;
}

/**
 * Take up to `limit` jobs under a lease.
 *
 * The claim is a CONDITIONAL write: `updateMany` matched on the row's current
 * state AND its current leaseUntil. Whoever's write reports `count === 1` owns
 * the job; everybody else gets 0 and moves on. That is what makes two workers,
 * or a worker plus a restarted worker, safe on the same table.
 */
export async function claimJobs(db: any, opts: ClaimOptions): Promise<YcJobRow[]> {
  const now = opts.now ?? new Date();
  const leaseMs = opts.leaseMs ?? YC_DEFAULT_LEASE_MS;
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
  const leaseUntil = new Date(now.getTime() + leaseMs);

  const candidates = await db.ycProcessingJob.findMany({
    where: {
      OR: [
        { state: "PENDING", nextRunAt: { lte: now } },
        // An expired lease means the owner died. Reclaimable, by design.
        { state: "RUNNING", leaseUntil: { lt: now } },
      ],
    },
    orderBy: [{ priority: "asc" }, { nextRunAt: "asc" }],
    take: limit * 4,
  });

  const claimed: YcJobRow[] = [];
  for (const cand of candidates || []) {
    if (claimed.length >= limit) break;
    const res = await db.ycProcessingJob.updateMany({
      where: { id: cand.id, state: cand.state, leaseUntil: cand.leaseUntil ?? null },
      data: { state: "RUNNING", leaseOwner: opts.leaseOwner, leaseUntil, attempts: (Number(cand.attempts) || 0) + 1 },
    });
    if (Number(res?.count) !== 1) continue; // somebody else won this row
    claimed.push({
      ...cand,
      state: "RUNNING",
      leaseOwner: opts.leaseOwner,
      leaseUntil,
      attempts: (Number(cand.attempts) || 0) + 1,
    });
  }
  return claimed;
}

/** Give a claimed job back without burning an attempt (budget paused, etc.). */
export async function releaseJob(db: any, job: YcJobRow, nextRunAt: Date, reason: string | null): Promise<void> {
  await db.ycProcessingJob.update({
    where: { id: job.id },
    data: {
      state: "PENDING",
      leaseOwner: null,
      leaseUntil: null,
      attempts: Math.max(0, (Number(job.attempts) || 1) - 1),
      nextRunAt,
      error: reason,
    },
  });
}

// ── default stage handlers ──────────────────────────────────────────────────

export const defaultStageHandlers: Partial<Record<YcStage, StageHandler>> = {
  async discover({ db, job }) {
    const result = await discoverYiddish24(db, {
      maxPages: Number(job.payload?.maxPages) || 25,
      catIds: Array.isArray(job.payload?.catIds) ? job.payload.catIds : undefined,
      full: job.payload?.full === true,
    });
    if (result.probes.length) await recordProbes(db, job.sourceKey, result.probes);
    await noteDiscoveryRun(db, job.sourceKey, result);
    await alertIfBroken(db);
    for (const id of result.newItemIds) {
      const item = await db.ycSourceItem.findUnique({ where: { id } }).catch(() => null);
      if (item) await enqueueNext(db, item, { sourceKey: job.sourceKey }).catch(() => {});
    }
    return {
      ok: result.healthy,
      reason: result.stoppedReason,
      advance: false,
    };
  },

  async fingerprint({ db, item }) {
    if (!item) return { ok: false, reason: "no item on this job" };
    const twin = await db.ycSourceItem.findFirst({
      where: { sourceId: item.sourceId, fingerprint: item.fingerprint, NOT: { id: item.id } },
      select: { id: true },
    });
    if (twin) {
      await db.ycSourceItem.update({
        where: { id: item.id },
        data: { state: "DUPLICATE", duplicateOfId: twin.id },
      });
      return { ok: true, skipped: true, reason: "the same content is already in the corpus", advance: false };
    }
    await db.ycSourceItem.update({ where: { id: item.id }, data: { state: "QUEUED" } });
    return { ok: true, advance: true };
  },

  async fetch_audio({ db, item }) {
    if (!item) return { ok: false, reason: "no item on this job" };
    // fetchAudio is itself gated; this call cannot bypass the gate.
    const res = await fetchYiddish24Audio(db, item);
    if (!res.fetched) return { ok: true, skipped: true, reason: res.reason, advance: false };
    return { ok: true, advance: true };
  },

  async segment({ db, item }) {
    const asset = item?.id
      ? await db.ycAudioAsset.findFirst({ where: { itemId: item.id, storage: "STORED", deletedAt: null } })
      : null;
    if (!asset?.storageKey) return { ok: true, skipped: true, reason: "no stored audio for this item", advance: false };
    const res = await detectSegments(asset.storageKey);
    if (!res.available) return { ok: true, skipped: true, reason: res.reason, advance: false };
    for (const seg of res.segments || []) {
      await db.ycSegment.create({
        data: {
          assetId: asset.id,
          startMs: seg.startMs,
          endMs: seg.endMs,
          klass: seg.klass,
          klassConfidence: seg.klassConfidence,
          features: { basis: seg.basis, method: res.method } as any,
        },
      });
    }
    await db.ycSourceItem.update({
      where: { id: item.id },
      data: { state: "AUDIO_ANALYZED", speechRatio: res.speechRatio ?? null },
    });
    return { ok: true, advance: true };
  },

  async features({ db, item }) {
    const asset = item?.id
      ? await db.ycAudioAsset.findFirst({ where: { itemId: item.id, storage: "STORED", deletedAt: null } })
      : null;
    if (!asset?.storageKey) return { ok: true, skipped: true, reason: "no stored audio for this item", advance: false };
    const segments = await db.ycSegment.findMany({ where: { assetId: asset.id, klass: "SPEECH" }, take: 200 });
    for (const seg of segments || []) {
      const f = await extractFeatures(asset.storageKey, seg);
      if (!f.available) return { ok: true, skipped: true, reason: f.reason, advance: false };
      await db.ycSegment.update({
        where: { id: seg.id },
        data: {
          rmsDb: f.rmsDb ?? null,
          speechRate: f.speechRateEstimate ?? null,
          pitchMeanHz: f.pitchMeanHz ?? null,
          features: { ...f } as any,
        },
      });
    }
    return { ok: true, advance: true };
  },

  async novelty({ db, item }) {
    if (!item) return { ok: false, reason: "no item on this job" };
    const asset = await db.ycAudioAsset
      .findFirst({ where: { itemId: item.id, storage: "STORED", deletedAt: null } })
      .catch(() => null);
    const features = asset
      ? { speechRatio: item.speechRatio ?? null }
      : null;
    const res = await scoreNovelty(db, item, features);
    await db.ycSourceItem.update({
      where: { id: item.id },
      data: {
        noveltyScore: res.score,
        priority: noveltyToPriority(res.score),
        metadata: { ...(item.metadata || {}), novelty: { score: res.score, reasons: res.reasons, basis: res.basis } } as any,
      },
    });
    return { ok: true, advance: true };
  },
};

// ── the run loop ────────────────────────────────────────────────────────────

export interface RunDueJobsDeps {
  leaseOwner?: string;
  limit?: number;
  now?: Date;
  leaseMs?: number;
  handlers?: Partial<Record<YcStage, StageHandler>>;
}

export interface RunDueJobsResult {
  claimed: number;
  done: number;
  skipped: number;
  failed: number;
  retried: number;
  released: number;
  errors: { jobId: string; stage: string; error: string }[];
}

export async function runDueJobs(db: any, deps: RunDueJobsDeps = {}): Promise<RunDueJobsResult> {
  const now = deps.now ?? new Date();
  const leaseOwner = deps.leaseOwner || `yc-worker-${process.pid}`;
  const handlers = { ...defaultStageHandlers, ...(deps.handlers || {}) };
  const out: RunDueJobsResult = { claimed: 0, done: 0, skipped: 0, failed: 0, retried: 0, released: 0, errors: [] };

  const jobs = await claimJobs(db, { leaseOwner, limit: deps.limit ?? 5, now, leaseMs: deps.leaseMs });
  out.claimed = jobs.length;

  for (const job of jobs) {
    const budget = await loadBudget(db, job.sourceKey);
    const item = job.itemId ? await db.ycSourceItem.findUnique({ where: { id: job.itemId } }).catch(() => null) : null;

    const verdict = budgetVerdict(budget, job.stage, now);
    if (verdict.action === "PAUSE") {
      await releaseJob(db, job, new Date(now.getTime() + YC_DEFAULT_INTERVAL_MS), verdict.reason);
      out.released += 1;
      continue;
    }
    if (verdict.action === "DEFER") {
      // Tomorrow, not never. The reason is kept so the queue screen is honest.
      const tomorrow = new Date(now.getTime() + 60 * 60_000);
      await releaseJob(db, job, tomorrow, verdict.reason);
      out.released += 1;
      continue;
    }
    if (verdict.action === "SKIP") {
      await finishJob(db, job, { state: "SKIPPED", error: verdict.reason }, now);
      out.skipped += 1;
      if (item) await enqueueNext(db, item, { after: job.stage, now, sourceKey: job.sourceKey }).catch(() => {});
      continue;
    }

    // ⛔ A second, independent check right before an audio stage runs: the
    // gate can have been revoked since the job was queued.
    if (YC_AUDIO_STAGES.includes(job.stage as YcStage)) {
      const gate = await audioGate(db, job.sourceKey);
      if (!gate.ok) {
        await finishJob(db, job, { state: "SKIPPED", error: gate.reason }, now);
        out.skipped += 1;
        if (item) await enqueueNext(db, item, { after: job.stage, now, sourceKey: job.sourceKey }).catch(() => {});
        continue;
      }
    }

    const handler = handlers[job.stage as YcStage];
    if (!handler) {
      await finishJob(db, job, { state: "SKIPPED", error: `no handler for stage "${job.stage}"` }, now);
      out.skipped += 1;
      if (item) await enqueueNext(db, item, { after: job.stage, now, sourceKey: job.sourceKey }).catch(() => {});
      continue;
    }

    try {
      const res = await handler({ db, job, item, budget, now });
      await chargeBudget(db, budget, res, now);
      if (res.skipped) {
        await finishJob(db, job, { state: "SKIPPED", error: res.reason ?? null, costCents: res.costCents }, now);
        out.skipped += 1;
      } else if (res.ok) {
        await finishJob(db, job, { state: "DONE", error: res.reason ?? null, costCents: res.costCents }, now);
        out.done += 1;
      } else {
        throw new Error(res.reason || `stage "${job.stage}" reported failure`);
      }
      if (item && res.advance !== false) {
        await enqueueNext(db, item, { after: job.stage, now, sourceKey: job.sourceKey }).catch(() => {});
      }
    } catch (err: any) {
      const message = String(err?.message || err).slice(0, 500);
      out.errors.push({ jobId: job.id, stage: job.stage, error: message });
      const attempts = Number(job.attempts) || 1;
      const maxAttempts = Number(job.maxAttempts) || 5;
      if (attempts >= maxAttempts) {
        // ⛔ The error is KEPT on the row. A FAILED job with no error is an
        // outage you cannot debug.
        await finishJob(db, job, { state: "FAILED", error: message }, now);
        out.failed += 1;
        if (job.itemId) {
          await db.ycSourceItem.update({ where: { id: job.itemId }, data: { state: "FAILED", error: message } }).catch(() => {});
        }
      } else {
        await db.ycProcessingJob.update({
          where: { id: job.id },
          data: {
            state: "PENDING",
            leaseOwner: null,
            leaseUntil: null,
            error: message,
            nextRunAt: new Date(now.getTime() + backoffMs(attempts)),
          },
        });
        out.retried += 1;
      }
    }
  }
  return out;
}

async function finishJob(
  db: any,
  job: YcJobRow,
  patch: { state: string; error?: string | null; costCents?: number },
  now: Date,
): Promise<void> {
  await db.ycProcessingJob.update({
    where: { id: job.id },
    data: {
      state: patch.state,
      error: patch.error ?? null,
      leaseOwner: null,
      leaseUntil: null,
      costCents: (Number(job.costCents) || 0) + (Math.max(0, Math.round(Number(patch.costCents) || 0))),
      nextRunAt: now,
    },
  });
}

// ── heartbeat + the worker ──────────────────────────────────────────────────

/** One row the dashboard reads to say whether the worker is alive. */
export async function writeHeartbeat(db: any, now: Date = new Date()): Promise<void> {
  const day = todayKey(now);
  await db.ycMetricSnapshot
    .upsert({
      where: { day_sourceKey_metric: { day, sourceKey: "__all__", metric: YC_WORKER_HEARTBEAT_METRIC } },
      update: { value: now.getTime() },
      create: { day, sourceKey: "__all__", metric: YC_WORKER_HEARTBEAT_METRIC, value: now.getTime() },
    })
    .catch(() => {});
}

export interface YiddishWorkerOptions extends RunDueJobsDeps {
  intervalMs?: number;
  /** Skip the boot run. Only tests should ever pass this. */
  skipBootRun?: boolean;
  onError?: (err: unknown) => void;
  /** How often each source is re-walked. Defaults to YC_DISCOVERY_EVERY_MS. */
  discoveryIntervalMs?: number;
}

export interface YiddishWorkerHandle {
  tick: () => Promise<RunDueJobsResult | null>;
  stop: () => Promise<void>;
  readonly running: boolean;
}

/**
 * The 24/7 loop.
 *
 * ⛔ THE BOOT RUN IS NOT OPTIONAL. Deploys restart this container more often
 * than any sensible interval, so a plain `setInterval` would be starved and
 * the queue would simply never drain. The first tick fires immediately.
 *
 * Re-entrancy is guarded: a tick that outruns the interval is not started
 * twice, and `stop()` waits for the tick in flight so a shutdown never leaves
 * a lease held by a process that is gone.
 */
/**
 * Keep every enabled adapter source walking. Called on each worker tick.
 *
 * A source is scheduled only when ALL of these hold, so this can never become a
 * runaway or spend money by itself:
 *   - the source is enabled and has an adapter,
 *   - its budget (or the global one) is not paused and allows `discover`,
 *   - it has no discover job already PENDING or RUNNING,
 *   - its last discovery is older than YC_DISCOVERY_EVERY_MS.
 */
export async function ensureDiscoveryScheduled(
  db: any,
  opts: { now?: Date; discoveryIntervalMs?: number } = {},
): Promise<{ scheduled: string[]; skipped: { key: string; why: string }[] }> {
  const now = opts.now ?? new Date();
  const every = opts.discoveryIntervalMs ?? YC_DISCOVERY_EVERY_MS;
  const scheduled: string[] = [];
  const skipped: { key: string; why: string }[] = [];

  const sources = await db.ycSource.findMany({ where: { enabled: true } }).catch(() => []);
  for (const source of sources || []) {
    const key = String(source.key);
    const isAdapter = String(source.kind) === "EXTERNAL_ADAPTER" || !!source.adapterKey;
    if (!isAdapter) continue; // internal tables are counted by the indexer, not walked

    const budget = await loadBudget(db, key);
    const verdict = budgetVerdict(budget, "discover", now);
    if (!verdict.allowed) {
      skipped.push({ key, why: verdict.reason || "the budget refuses discovery" });
      continue;
    }

    const inFlight = await db.ycProcessingJob
      .count({ where: { sourceKey: key, stage: "discover", state: { in: ["PENDING", "RUNNING"] } } })
      .catch(() => 0);
    if (inFlight > 0) {
      skipped.push({ key, why: "a discover job is already queued or running" });
      continue;
    }

    const lastAt = source.lastDiscoveryAt ?? source.lastRunAt;
    const age = lastAt ? now.getTime() - new Date(lastAt).getTime() : Number.POSITIVE_INFINITY;
    if (age < every) {
      skipped.push({ key, why: `walked ${Math.round(age / 60000)} min ago` });
      continue;
    }

    await db.ycProcessingJob.create({
      data: { sourceKey: key, stage: "discover", priority: 5, nextRunAt: now, payload: { scheduledBy: "worker" } },
    });
    scheduled.push(key);
  }
  return { scheduled, skipped };
}

export function startYiddishWorker(db: any, opts: YiddishWorkerOptions = {}): YiddishWorkerHandle {
  const intervalMs = Math.max(5_000, opts.intervalMs ?? YC_DEFAULT_INTERVAL_MS);
  const leaseOwner = opts.leaseOwner || `yc-worker-${process.pid}`;
  let inFlight: Promise<RunDueJobsResult | null> | null = null;
  let stopped = false;

  const tick = async (): Promise<RunDueJobsResult | null> => {
    if (stopped) return null;
    if (inFlight) return inFlight; // never two ticks at once
    inFlight = (async () => {
      try {
        await writeHeartbeat(db);
        // Schedule before running, so a fresh install starts walking on its
        // first tick instead of waiting for someone to queue a job by hand.
        await ensureDiscoveryScheduled(db, { discoveryIntervalMs: opts.discoveryIntervalMs }).catch((err) => {
          if (opts.onError) opts.onError(err);
        });
        return await runDueJobs(db, { ...opts, leaseOwner });
      } catch (err) {
        if (opts.onError) opts.onError(err);
        else console.error("yiddish worker tick failed", String((err as any)?.message || err).slice(0, 200));
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  // ⛔ BOOT RUN FIRST, then the interval.
  if (!opts.skipBootRun) void tick();

  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();

  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight.catch(() => null);
    },
    get running() {
      return !stopped;
    },
  };
}
