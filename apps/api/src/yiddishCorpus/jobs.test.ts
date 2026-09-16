/**
 * Yiddish corpus — worker, queue and source-health tests.
 *
 * ⛔ NO NETWORK, NO PRISMA. `makeDb()` is a small in-memory stand-in for the
 * handful of Prisma calls this folder makes, so the behaviours below are
 * tested for real rather than mocked away:
 *
 *   - a LEASE makes double-claiming impossible, and an EXPIRED lease is
 *     reclaimable (a worker that died must not strand its jobs);
 *   - a failing job retries on a backoff and then goes FAILED **with the error
 *     kept** — a FAILED row with no error is an outage nobody can debug;
 *   - audio stages are SKIPPED, not FAILED, while the rights gate refuses, and
 *     the metadata pipeline keeps running past them;
 *   - two consecutive empty discovery runs raise a HEALTH ALERT and pause the
 *     source, instead of reporting "nothing new".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  backoffMs,
  budgetVerdict,
  claimJobs,
  enqueueNext,
  releaseJob,
  runDueJobs,
  startYiddishWorker,
  writeHeartbeat,
  YC_METADATA_STAGES,
  YC_WORKER_HEARTBEAT_METRIC,
} from "./jobs";
import { YC_AUDIO_STAGES, YC_STAGES } from "./contracts";
import { alertIfBroken, noteDiscoveryRun, recordProbes, summarizeHealth, YC_DISCOVERY_YIELD_PROBE } from "./siteHealth";
import { noveltyToPriority, scoreNovelty } from "./novelty";

// ── a very small fake Prisma ────────────────────────────────────────────────

const COMPOSITE_KEYS = new Set(["sourceId_probeKey", "day_sourceKey_metric", "sourceId_externalId"]);

function expand(where: any): any {
  if (!where || typeof where !== "object") return where;
  const out: any = {};
  for (const [k, v] of Object.entries(where)) {
    if (COMPOSITE_KEYS.has(k) && v && typeof v === "object") Object.assign(out, v);
    else out[k] = v;
  }
  return out;
}

function matches(row: any, where: any): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(expand(where))) {
    if (k === "OR") {
      if (!(v as any[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === "AND") {
      if (!(v as any[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (k === "NOT") {
      if (matches(row, v)) return false;
      continue;
    }
    const rv = row[k];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      for (const [op, ov] of Object.entries(v as any)) {
        if (op === "lt" && !(rv < (ov as any))) return false;
        if (op === "lte" && !(rv <= (ov as any))) return false;
        if (op === "gt" && !(rv > (ov as any))) return false;
        if (op === "gte" && !(rv >= (ov as any))) return false;
        if (op === "in" && !(ov as any[]).includes(rv)) return false;
        if (op === "notIn" && (ov as any[]).includes(rv)) return false;
        if (op === "not" && rv === ov) return false;
      }
      continue;
    }
    if (rv instanceof Date && v instanceof Date) {
      if (rv.getTime() !== (v as Date).getTime()) return false;
      continue;
    }
    if ((rv ?? null) !== (v ?? null)) return false;
  }
  return true;
}

let idSeq = 0;
function table(name: string, defaults: Record<string, any> = {}) {
  const rows: any[] = [];
  // ⛔ Reads return CLONES, exactly like Prisma. Handing out live references
  // hides aliasing bugs (a claimed job's `attempts` read back already bumped).
  const clone = (r: any) => (r ? { ...r } : r);
  const api = {
    rows,
    async findMany({ where, orderBy, take }: any = {}) {
      let out = rows.filter((r) => matches(r, where)).map(clone);
      const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
      for (const o of [...orders].reverse()) {
        const [field, dir] = Object.entries(o)[0] as [string, string];
        out = out.slice().sort((a, b) => {
          const av = a[field];
          const bv = b[field];
          const c = av === bv ? 0 : av < bv ? -1 : 1;
          return dir === "desc" ? -c : c;
        });
      }
      return take ? out.slice(0, take) : out;
    },
    async findFirst({ where }: any = {}) {
      return clone(rows.find((r) => matches(r, where))) ?? null;
    },
    async findUnique({ where }: any = {}) {
      return clone(rows.find((r) => matches(r, where))) ?? null;
    },
    async count({ where }: any = {}) {
      return rows.filter((r) => matches(r, where)).length;
    },
    async create({ data }: any) {
      idSeq += 1;
      const row = { id: `${name}-${idSeq}`, ...defaults, ...data, updatedAt: new Date() };
      rows.push(row);
      return clone(row);
    },
    async update({ where, data }: any) {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error(`${name}: no row for update`);
      Object.assign(row, data, { updatedAt: new Date() });
      return clone(row);
    },
    async updateMany({ where, data }: any) {
      const hits = rows.filter((r) => matches(r, where));
      for (const r of hits) Object.assign(r, data, { updatedAt: new Date() });
      return { count: hits.length };
    },
    async upsert({ where, update, create }: any) {
      const row = rows.find((r) => matches(r, where));
      if (row) {
        Object.assign(row, update);
        return clone(row);
      }
      return api.create({ data: create });
    },
  };
  return api;
}

function makeDb(opts: { source?: any; budget?: any } = {}) {
  const ycSourceRows = table("src");
  const ycBudget = table("budget", { paused: false, mode: "METADATA_ONLY", concurrency: 2, requestsPerMinute: 30 });
  const ycSourceItem = table("item", { state: "DISCOVERED", priority: 50, metadata: {} });
  const ycProcessingJob = table("job", {
    state: "PENDING",
    priority: 50,
    attempts: 0,
    maxAttempts: 3,
    costCents: 0,
    leaseUntil: null,
    leaseOwner: null,
    error: null,
    payload: null,
    itemId: null,
  });
  const ycSourceHealth = table("health");
  const ycMetricSnapshot = table("metric");
  const ycAudioAsset = table("asset");
  const ycSegment = table("seg");

  const source = {
    id: "src1",
    key: "yiddish24",
    name: "Yiddish24",
    kind: "EXTERNAL_ADAPTER",
    governanceClass: "EXTERNAL",
    trainingExportEligibility: "UNKNOWN",
    contentAllowed: true,
    audioFetchMode: "DISABLED",
    enabled: true,
    discoveryCursor: null,
    rights: [] as any[],
    ...(opts.source || {}),
  };
  ycSourceRows.rows.push(source);
  const budget = { id: "b1", sourceId: "src1", scope: "yiddish24", paused: false, mode: "METADATA_ONLY", apiCentsPerDay: 0, transcriptionMinutesPerDay: 0, concurrency: 2, requestsPerMinute: 30, spentCentsToday: 0, transcribedMinutesToday: 0, spendDate: null, ...(opts.budget || {}) };
  ycBudget.rows.push(budget);

  // ycSource.findUnique/findMany must honour `include` the way the code uses it.
  const ycSource = {
    ...ycSourceRows,
    async findUnique({ where, include }: any) {
      const row = ycSourceRows.rows.find((r) => matches(r, where));
      if (!row) return null;
      return decorate(row, include);
    },
    async findMany({ where, include }: any = {}) {
      return ycSourceRows.rows.filter((r) => matches(r, where)).map((r) => decorate(r, include));
    },
  };
  function decorate(row: any, include: any) {
    const out: any = { ...row };
    if (include?.budget) out.budget = ycBudget.rows.find((b) => b.sourceId === row.id) ?? null;
    if (include?.health) out.health = ycSourceHealth.rows.filter((h) => h.sourceId === row.id);
    if (include?.rights) out.rights = row.rights ?? [];
    return out;
  }

  return {
    ycSource,
    ycSourceRows,
    ycBudget,
    ycSourceItem,
    ycProcessingJob,
    ycSourceHealth,
    ycMetricSnapshot,
    ycAudioAsset,
    ycSegment,
  } as any;
}

const NOW = new Date("2026-09-15T12:00:00.000Z");

async function seedJob(db: any, over: Record<string, any> = {}) {
  return db.ycProcessingJob.create({
    data: { sourceKey: "yiddish24", stage: "novelty", state: "PENDING", nextRunAt: new Date(NOW.getTime() - 1000), ...over },
  });
}

// ── 1. pure bits ────────────────────────────────────────────────────────────

test("backoff is exponential and capped", () => {
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 60_000);
  assert.equal(backoffMs(3), 120_000);
  assert.ok(backoffMs(20) <= 6 * 60 * 60_000);
  assert.equal(backoffMs(0), 30_000, "attempt 0 still waits");
});

test("the metadata pipeline is exactly the stages that need no audio", () => {
  assert.deepEqual(YC_METADATA_STAGES, ["discover", "fingerprint", "novelty", "observe", "aggregate"]);
  for (const s of YC_AUDIO_STAGES) assert.equal(YC_METADATA_STAGES.includes(s), false);
});

test("budgetVerdict: paused pauses, METADATA_ONLY skips audio, a spent budget defers", () => {
  assert.equal(budgetVerdict(null, "novelty", NOW).action, "RUN");
  assert.equal(budgetVerdict({ paused: true }, "novelty", NOW).action, "PAUSE");
  assert.equal(budgetVerdict({ mode: "METADATA_ONLY" }, "fetch_audio", NOW).action, "SKIP");
  assert.equal(budgetVerdict({ mode: "FULL" }, "fetch_audio", NOW).action, "RUN");
  const spent = { mode: "FULL", apiCentsPerDay: 100, spentCentsToday: 100, spendDate: "2026-09-15" };
  assert.equal(budgetVerdict(spent, "novelty", NOW).action, "DEFER");
  // Yesterday's spend does not hold today's budget hostage.
  assert.equal(budgetVerdict({ ...spent, spendDate: "2026-09-14" }, "novelty", NOW).action, "RUN");
  // Transcription needs its own minutes budget, and 0 means "not today".
  assert.equal(budgetVerdict({ mode: "FULL" }, "transcribe", NOW).action, "DEFER");
  assert.equal(
    budgetVerdict({ mode: "FULL", transcriptionMinutesPerDay: 60, transcribedMinutesToday: 60, spendDate: "2026-09-15" }, "transcribe", NOW).action,
    "DEFER",
  );
});

// ── 2. ⛔ leases ────────────────────────────────────────────────────────────

test("a lease makes a double-claim impossible — two workers, one winner", async () => {
  const db = makeDb();
  await seedJob(db);

  const a = await claimJobs(db, { leaseOwner: "worker-a", limit: 5, now: NOW });
  const b = await claimJobs(db, { leaseOwner: "worker-b", limit: 5, now: NOW });
  assert.equal(a.length, 1, "the first worker takes the job");
  assert.equal(b.length, 0, "the second worker finds nothing claimable");

  const row = db.ycProcessingJob.rows[0];
  assert.equal(row.state, "RUNNING");
  assert.equal(row.leaseOwner, "worker-a");
  assert.equal(row.attempts, 1, "claiming burns the attempt, so a crash loop cannot run forever");
});

test("an EXPIRED lease is reclaimable — a dead worker must not strand its jobs", async () => {
  const db = makeDb();
  await seedJob(db, { state: "RUNNING", leaseOwner: "dead-worker", leaseUntil: new Date(NOW.getTime() - 60_000) });

  const claimed = await claimJobs(db, { leaseOwner: "fresh", limit: 5, now: NOW });
  assert.equal(claimed.length, 1);
  assert.equal(db.ycProcessingJob.rows[0].leaseOwner, "fresh");

  // ...but a LIVE lease is not touched.
  const db2 = makeDb();
  await seedJob(db2, { state: "RUNNING", leaseOwner: "busy", leaseUntil: new Date(NOW.getTime() + 60_000) });
  assert.equal((await claimJobs(db2, { leaseOwner: "thief", limit: 5, now: NOW })).length, 0);
});

test("a job whose nextRunAt is in the future is not claimed", async () => {
  const db = makeDb();
  await seedJob(db, { nextRunAt: new Date(NOW.getTime() + 60_000) });
  assert.equal((await claimJobs(db, { leaseOwner: "w", limit: 5, now: NOW })).length, 0);
});

test("releaseJob hands a job back without burning the attempt", async () => {
  const db = makeDb();
  await seedJob(db);
  const [job] = await claimJobs(db, { leaseOwner: "w", limit: 1, now: NOW });
  await releaseJob(db, job, new Date(NOW.getTime() + 60_000), "budget paused");
  const row = db.ycProcessingJob.rows[0];
  assert.equal(row.state, "PENDING");
  assert.equal(row.attempts, 0);
  assert.equal(row.leaseOwner, null);
  assert.equal(row.error, "budget paused");
});

// ── 3. retry → FAILED, with the error kept ──────────────────────────────────

test("a failing job retries on a backoff and then FAILS with the error kept", async () => {
  const db = makeDb();
  const item = await db.ycSourceItem.create({ data: { sourceId: "src1", externalId: "1", fingerprint: "f1" } });
  await seedJob(db, { itemId: item.id, maxAttempts: 3 });

  const handlers = {
    novelty: async () => {
      throw new Error("the sky fell on the novelty stage");
    },
  } as any;

  // attempt 1 and 2 retry
  for (const attempt of [1, 2]) {
    const res = await runDueJobs(db, { handlers, leaseOwner: "w", now: NOW });
    assert.equal(res.retried, 1, `attempt ${attempt} should retry`);
    assert.equal(res.failed, 0);
    const row = db.ycProcessingJob.rows[0];
    assert.equal(row.state, "PENDING");
    assert.equal(row.error, "the sky fell on the novelty stage", "the error is kept between attempts");
    assert.equal(
      row.nextRunAt.getTime(),
      NOW.getTime() + backoffMs(attempt),
      "the retry is scheduled on the exponential backoff",
    );
    row.nextRunAt = new Date(NOW.getTime() - 1); // fast-forward for the next round
  }

  // attempt 3 exhausts maxAttempts
  const last = await runDueJobs(db, { handlers, leaseOwner: "w", now: NOW });
  assert.equal(last.failed, 1);
  assert.equal(last.retried, 0);
  const row = db.ycProcessingJob.rows[0];
  assert.equal(row.state, "FAILED");
  assert.equal(row.error, "the sky fell on the novelty stage", "⛔ a FAILED row without its error is undebuggable");
  assert.equal(row.leaseOwner, null, "a finished job holds no lease");
  assert.equal(db.ycSourceItem.rows[0].state, "FAILED");
  assert.equal(db.ycSourceItem.rows[0].error, "the sky fell on the novelty stage");
});

// ── 4. ⛔ audio stages are SKIPPED, never FAILED, while the gate refuses ─────

test("enqueueNext walks past every audio stage as SKIPPED while the gate refuses", async () => {
  const db = makeDb(); // audioFetchMode DISABLED, no rights records
  const item = await db.ycSourceItem.create({ data: { sourceId: "src1", externalId: "1", fingerprint: "f1" } });

  const res = await enqueueNext(db, item, { after: "fingerprint", sourceKey: "yiddish24", now: NOW });
  assert.equal(res.queued?.stage, "novelty", "the next stage that can legally run is the metadata one");

  const skippedStages = res.skipped.map((s) => s.stage);
  assert.deepEqual(skippedStages, ["fetch_audio", "segment", "features", "cluster"]);
  for (const s of res.skipped) assert.ok(s.reason.length > 20, "a skip must say why in plain English");

  // The skips are real rows, visible on the queue screen, and SKIPPED — not FAILED.
  const rows = db.ycProcessingJob.rows;
  for (const stage of skippedStages) {
    const row = rows.find((r: any) => r.stage === stage);
    assert.ok(row, `${stage} should have a queue row`);
    assert.equal(row.state, "SKIPPED");
    assert.notEqual(row.state, "FAILED");
    assert.ok(row.error, "the skip reason is kept on the row");
  }
});

test("the metadata pipeline runs end to end with no audio at all", async () => {
  const db = makeDb();
  const item = await db.ycSourceItem.create({ data: { sourceId: "src1", externalId: "1", fingerprint: "f1", seriesName: "A", durationSec: 600 } });

  let stage: string | null = "fingerprint";
  const walked: string[] = [];
  const handlers = {
    fingerprint: async () => ({ ok: true, advance: true }),
    novelty: async () => ({ ok: true, advance: true }),
    observe: async () => ({ ok: true, advance: true }),
    aggregate: async () => ({ ok: true, advance: true }),
  } as any;

  await db.ycProcessingJob.create({
    data: { itemId: item.id, sourceKey: "yiddish24", stage: "fingerprint", state: "PENDING", nextRunAt: new Date(NOW.getTime() - 1) },
  });

  for (let i = 0; i < 8 && stage; i += 1) {
    const res = await runDueJobs(db, { handlers, leaseOwner: "w", now: NOW });
    if (!res.claimed) break;
    const running = db.ycProcessingJob.rows.filter((r: any) => r.state === "DONE").map((r: any) => r.stage);
    walked.push(...running.filter((s: string) => !walked.includes(s)));
    const next = db.ycProcessingJob.rows.find((r: any) => r.state === "PENDING");
    stage = next?.stage ?? null;
    if (next) next.nextRunAt = new Date(NOW.getTime() - 1);
  }

  assert.deepEqual(walked, ["fingerprint", "novelty", "observe", "aggregate"]);
  // And every audio stage sits there as SKIPPED with a reason, not an error.
  for (const s of YC_AUDIO_STAGES) {
    const row = db.ycProcessingJob.rows.find((r: any) => r.stage === s);
    if (row) assert.equal(row.state, "SKIPPED");
  }
});

test("an audio job already in the queue is SKIPPED at run time if the gate says no", async () => {
  const db = makeDb();
  const item = await db.ycSourceItem.create({ data: { sourceId: "src1", externalId: "1", fingerprint: "f1" } });
  // Queued while the mode allowed it, then the grant was revoked.
  db.ycBudget.rows[0].mode = "FULL";
  await seedJob(db, { itemId: item.id, stage: "fetch_audio" });

  let handlerRan = false;
  const res = await runDueJobs(db, {
    leaseOwner: "w",
    now: NOW,
    handlers: { fetch_audio: async () => { handlerRan = true; return { ok: true }; } } as any,
  });
  assert.equal(handlerRan, false, "the handler must never run behind a refusing gate");
  assert.equal(res.skipped, 1);
  assert.equal(res.failed, 0);
  const row = db.ycProcessingJob.rows.find((r: any) => r.stage === "fetch_audio");
  assert.equal(row.state, "SKIPPED");
  assert.match(String(row.error), /rights grant|not fetched|not registered/i);
});

// ── 5. ⛔ two empty discovery runs are a HEALTH EVENT, not "nothing new" ─────

test("two consecutive empty discovery runs raise an alert and pause the source", async () => {
  const db = makeDb();

  const first = await noteDiscoveryRun(db, "yiddish24", { discovered: 0, pages: 4, healthy: true });
  assert.equal(first.emptyRuns, 1);
  assert.deepEqual(await alertIfBroken(db), [], "one quiet run is not yet an alert");
  assert.equal(db.ycBudget.rows[0].paused, false);
  assert.equal(
    db.ycSourceHealth.rows.find((h: any) => h.probeKey === YC_DISCOVERY_YIELD_PROBE).state,
    "DEGRADED",
  );

  const second = await noteDiscoveryRun(db, "yiddish24", { discovered: 0, pages: 4, healthy: true });
  assert.equal(second.emptyRuns, 2);

  const alerts = await alertIfBroken(db);
  assert.equal(alerts.length, 1, "the second empty run IS the alert");
  assert.equal(alerts[0].probeKey, YC_DISCOVERY_YIELD_PROBE);
  assert.equal(alerts[0].paused, true);
  assert.match(alerts[0].detail, /consecutive|health event|nothing new/i);
  assert.equal(db.ycBudget.rows[0].paused, true, "⛔ the source is PAUSED, not silently left running");

  // A run that finds something clears the counter and the probe.
  await noteDiscoveryRun(db, "yiddish24", { discovered: 7, pages: 1, healthy: true });
  assert.equal(
    db.ycSourceHealth.rows.find((h: any) => h.probeKey === YC_DISCOVERY_YIELD_PROBE).state,
    "OK",
  );
});

test("any BROKEN probe pauses the source on its own, and brokenSince does not creep", async () => {
  const db = makeDb();
  await recordProbes(db, "yiddish24", [
    { probeKey: "listing_item_attributes", state: "BROKEN", detail: "0 items on a page that should hold 10" },
    { probeKey: "series_name_base64", state: "OK", detail: "fine" },
  ]);
  const first = db.ycSourceHealth.rows.find((h: any) => h.probeKey === "listing_item_attributes").brokenSince;
  assert.ok(first instanceof Date);

  const alerts = await alertIfBroken(db);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].state, "BROKEN");
  assert.equal(db.ycBudget.rows[0].paused, true);

  // Still broken on the next check → brokenSince stays put, so "broken for N
  // days" is a real number.
  await recordProbes(db, "yiddish24", [{ probeKey: "listing_item_attributes", state: "BROKEN", detail: "still 0" }]);
  assert.equal(
    db.ycSourceHealth.rows.find((h: any) => h.probeKey === "listing_item_attributes").brokenSince.getTime(),
    first.getTime(),
  );

  // Recovered → the clock clears.
  await recordProbes(db, "yiddish24", [{ probeKey: "listing_item_attributes", state: "OK", detail: "10 items" }]);
  assert.equal(db.ycSourceHealth.rows.find((h: any) => h.probeKey === "listing_item_attributes").brokenSince, null);
});

test("summarizeHealth never overstates what it knows", () => {
  assert.match(summarizeHealth([]), /No probes have run yet/);
  assert.match(summarizeHealth([{ probeKey: "a", state: "OK" }]), /All 1 checks passed/);
  assert.match(summarizeHealth([{ probeKey: "a", state: "DEGRADED" }]), /degraded/);
  assert.match(summarizeHealth([{ probeKey: "a", state: "BROKEN" }]), /failing/);
});

// ── 6. the worker loop ──────────────────────────────────────────────────────

test("⛔ startYiddishWorker does a BOOT RUN — an interval alone is starved by deploys", async () => {
  const db = makeDb();
  await seedJob(db);
  let ticks = 0;
  const worker = startYiddishWorker(db, {
    intervalMs: 3_600_000, // an hour: only a boot run can possibly fire
    leaseOwner: "boot",
    handlers: {
      novelty: async () => {
        ticks += 1;
        return { ok: true, advance: false };
      },
    } as any,
  });
  await worker.tick();
  await worker.stop();
  assert.equal(ticks, 1, "the work ran without waiting an hour for the first interval");
  assert.equal(db.ycProcessingJob.rows[0].state, "DONE");
  assert.equal(worker.running, false);

  const beat = db.ycMetricSnapshot.rows.find((m: any) => m.metric === YC_WORKER_HEARTBEAT_METRIC);
  assert.ok(beat && beat.value > 0, "a heartbeat row is written so the dashboard can tell alive from dead");
});

test("the worker never runs two ticks at once", async () => {
  const db = makeDb();
  await seedJob(db);
  let concurrent = 0;
  let maxConcurrent = 0;
  const worker = startYiddishWorker(db, {
    intervalMs: 3_600_000,
    skipBootRun: true,
    handlers: {
      novelty: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent -= 1;
        return { ok: true, advance: false };
      },
    } as any,
  });
  await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
  await worker.stop();
  assert.equal(maxConcurrent, 1);
});

test("writeHeartbeat is an upsert — it never piles up rows", async () => {
  const db = makeDb();
  await writeHeartbeat(db, NOW);
  await writeHeartbeat(db, new Date(NOW.getTime() + 60_000));
  assert.equal(db.ycMetricSnapshot.rows.length, 1);
  assert.equal(db.ycMetricSnapshot.rows[0].value, NOW.getTime() + 60_000);
});

// ── 7. novelty orders the queue and never deletes anything ──────────────────

test("scoreNovelty rewards the unseen and only ever orders the queue", async () => {
  const db = makeDb();
  for (let i = 0; i < 30; i += 1) {
    await db.ycSourceItem.create({
      data: { sourceId: "src1", externalId: `old-${i}`, fingerprint: `f${i}`, seriesName: "Bulletin", category: "news", durationSec: 600 },
    });
  }
  const familiar = await scoreNovelty(db, { id: "x", sourceId: "src1", seriesName: "Bulletin", category: "news", durationSec: 600 });
  const brandNew = await scoreNovelty(db, { id: "y", sourceId: "src1", seriesName: "A Series Nobody Has Heard", category: "torah", durationSec: 7200 });

  assert.ok(brandNew.score > familiar.score, `${brandNew.score} should beat ${familiar.score}`);
  assert.ok(brandNew.score >= 0 && brandNew.score <= 1);
  assert.equal(brandNew.basis, "METADATA", "with no audio it must say the score is metadata-only");
  assert.ok(brandNew.reasons.some((r) => /first item/.test(r)));
  assert.ok(familiar.reasons.length > 0, "even a dull item gets a stated reason");

  // Audio features fold in without changing the shape.
  const withAudio = await scoreNovelty(
    db,
    { id: "z", sourceId: "src1", seriesName: "Bulletin", category: "news", durationSec: 600 },
    { newSpeakerCluster: true, outOfVocabularyRatio: 0.4, speechRatio: 0.9, speechRateEstimate: 6, pausesPerMinute: 30 },
  );
  assert.equal(withAudio.basis, "MIXED");
  assert.ok(withAudio.score > familiar.score);

  // ⛔ Ordering only: a low score maps to a low priority, never to a skip.
  assert.ok(noveltyToPriority(1) < noveltyToPriority(0));
  assert.ok(noveltyToPriority(0) <= 99 && noveltyToPriority(1) >= 1);
});

test("SOURCE GUARD: no novelty branch deletes, disables or excludes an item", () => {
  const src = readFileSync(path.join(__dirname, "novelty.ts"), "utf8").replace(/\r\n/g, "\n");
  const body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  for (const banned of ["delete(", "deleteMany", "SKIPPED", "enabled: false", "DUPLICATE"]) {
    assert.equal(body.includes(banned), false, `novelty.ts must not use "${banned}" — it orders the queue, nothing more`);
  }
});

test("every stage in YC_STAGES is either audio-gated or metadata — no orphans", () => {
  for (const s of YC_STAGES) {
    assert.ok(
      YC_AUDIO_STAGES.includes(s) || YC_METADATA_STAGES.includes(s),
      `${s} belongs to neither list — enqueueNext would silently step over it`,
    );
  }
});
