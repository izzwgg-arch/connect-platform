/**
 * Creative Studio — what actually happens when the check says no.
 *
 * Its own file because it needs the checker replaced with one that gives a
 * known verdict: the point is the DECISION (re-render, or hand it over with
 * the verdict attached), not whether a vision model spots six fingers. The
 * real checker is exercised on production; this pins the behaviour around it,
 * which is the part that spends money and the part a refactor breaks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

/**
 * The checker and the asset writer are replaced ONCE, with a verdict each test
 * sets. Re-registering a module mock per test does not reliably beat the
 * module cache, and a half-applied mock makes a green suite that proves
 * nothing — the failure mode this file exists to catch.
 */
let verdict: any = { ok: true, checked: true, problems: [] };
let saved: any[] = [];
let assetSeq = 0;

mock.module("./evaluate", {
  namedExports: {
    evaluateOutput: async () => verdict,
    describeRetry: (e: any) => `${e.problems?.[0]?.kind || "it"} came out wrong, so I did it again`,
    retryHint: (e: any) => (e.problems?.some((p: any) => p.kind === "hands") ? "hands with exactly five fingers" : ""),
  },
});
mock.module("./assets", {
  namedExports: {
    // Storage is not what this file is about; MinIO is proven on production.
    saveOutputAsset: async (_db: any, input: any) => {
      const asset = { id: `asset${++assetSeq}`, tenantId: input.tenantId, kind: input.kind, durationMs: 4100, name: input.output?.name };
      saved.push(asset);
      return asset;
    },
  },
});

const jobsPromise = import("./jobs");

function fakeDb(job: any) {
  const state = { job: { ...job }, assets: [] as any[], generations: [] as any[], usage: [] as any[], docs: [] as any[] };
  return {
    state,
    creativeJob: {
      async update({ where, data }: any) {
        if (where.id !== state.job.id) throw new Error("wrong job");
        const flat: any = { ...data };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as any)) flat[k] = (state.job[k] || 0) + (v as any).increment;
        }
        state.job = { ...state.job, ...flat };
        return state.job;
      },
      async updateMany() { return { count: 1 }; },
      async count() { return 0; },
    },
    creativeAsset: {
      async findFirst() { return null; },
      async findMany() { return []; },
      async updateMany({ where, data }: any) {
        state.assets.push({ deleted: where.id, ...data });
        return { count: 1 };
      },
      async update() { return {}; },
    },
    creativeGeneration: {
      async create({ data }: any) { state.generations.push(data); return data; },
      async findFirst() { return null; },
    },
    creativeOperation: { async create({ data }: any) { return data; } },
    creativeDocument: { async findFirst() { return null; }, async update() { return {}; } },
    creativeUsage: { async create({ data }: any) { state.usage.push(data); return data; }, async groupBy() { return []; } },
    creativeEngineStat: { async upsert() { return {}; } },
    creativeProject: { async update() { return {}; } },
    creativeQuota: { async findUnique() { return null; } },
  } as any;
}

const aJob = (over: any = {}) => ({
  id: "j1",
  tenantId: "t1",
  projectId: "p1",
  capability: "image.generate",
  status: "running",
  attempts: 1,
  maxAttempts: 3,
  costMicros: 12000,
  engineId: "loopcom.image",
  workerId: "w1",
  requestedByUserId: "u1",
  request: { request: "a technician holding a phone", prompt: "a technician holding a phone, brand colours" },
  ...over,
});

const outputs = [{ buffer: Buffer.from("not really a png"), mime: "image/png", name: "made.png" }];

const BROKEN = { ok: false, checked: true, problems: [{ kind: "hands", detail: "six fingers on the left hand", severity: "serious" }] };
const FINE = { ok: true, checked: true, problems: [] };

test("a picture with six fingers is re-rendered, and the person is told why in plain words", async () => {
  verdict = BROKEN;
  const jobs = await jobsPromise;
  const db = fakeDb(aJob());
  const made = await jobs.completeJob({ db, workerId: "w1" }, db.state.job, outputs as any, { renderMs: 900, costMicros: 12000 });

  assert.deepEqual(made, [], "nothing is handed over");
  assert.equal(db.state.job.status, "queued", "it goes back in the queue");
  assert.match(String(db.state.job.progressNote), /came out wrong/, "and says so in words a person would use");
  assert.equal(db.state.job.request.qualityRetries, 1);
  assert.match(String(db.state.job.request.prompt), /five fingers/, "the second attempt is told what to avoid");
  assert.match(String(db.state.job.request.prompt), /a technician holding a phone/, "without losing what was asked for");

  const rejected = db.state.generations.find((g: any) => g.outcome === "rejected");
  assert.ok(rejected, "the rejected attempt is in the history, not silently dropped");
  assert.equal(rejected.evaluation.problems[0].kind, "hands");
  assert.equal(db.state.usage.length, 0, "a rejected attempt is not counted as work delivered");
});

test("a picture that is fine is handed over, with the verdict attached", async () => {
  verdict = FINE;
  const jobs = await jobsPromise;
  const db = fakeDb(aJob());
  await jobs.completeJob({ db, workerId: "w1" }, db.state.job, [] as any, { renderMs: 900, costMicros: 12000, existingAssetIds: [] });

  assert.equal(db.state.job.status, "succeeded");
  const kept = db.state.generations[0];
  assert.equal(kept.outcome, "kept");
});

test("the second chances run out, and the work is handed over rather than withheld", async () => {
  verdict = BROKEN;
  const jobs = await jobsPromise;
  // image.generate allows two re-renders; this job has used both.
  const db = fakeDb(aJob({ request: { request: "x", prompt: "x", qualityRetries: 2 } }));
  const made = await jobs.completeJob({ db, workerId: "w1" }, db.state.job, outputs as any, { renderMs: 900, costMicros: 12000 });

  assert.equal(db.state.job.status, "succeeded", "a flawed picture beats no picture");
  assert.equal(made.length, 1, "the picture really is saved and handed over");
  const kept = db.state.generations[0];
  assert.equal(kept.outcome, "kept");
  assert.equal(kept.evaluation.ok, false, "but the record says plainly that it was not clean");
});

test("video gets ONE second chance, not two — a shot is two provider calls", async () => {
  verdict = BROKEN;
  const jobs = await jobsPromise;
  const first = fakeDb(aJob({ capability: "video.generate", request: { request: "x", prompt: "x" } }));
  await jobs.completeJob({ db: first, workerId: "w1" }, first.state.job, outputs as any, { renderMs: 900, costMicros: 400000 });
  assert.equal(first.state.job.status, "queued", "the first bad shot is re-rendered");

  const second = fakeDb(aJob({ capability: "video.generate", request: { request: "x", prompt: "x", qualityRetries: 1 } }));
  await jobs.completeJob({ db: second, workerId: "w1" }, second.state.job, outputs as any, { renderMs: 900, costMicros: 400000 });
  assert.equal(second.state.job.status, "succeeded", "the second is handed over — a third render is not spent");
});

test("a video re-render starts from scratch, not from half a plan", async () => {
  verdict = BROKEN;
  const jobs = await jobsPromise;
  const db = fakeDb(aJob({
    capability: "video.generate",
    request: { request: "x", prompt: "x", seconds: 15, plan: { wanted: 15, segments: [{ index: 0, seconds: 12, status: "done", assetId: "a1" }, { index: 1, seconds: 4, status: "done", assetId: "a2" }] } },
  }));
  await jobs.completeJob({ db, workerId: "w1" }, db.state.job, outputs as any, { renderMs: 900, costMicros: 400000 });
  assert.equal(db.state.job.status, "queued");
  assert.equal(db.state.job.request.plan, undefined, "the old segment plan must not be reused — it is what produced the broken shot");
  assert.equal(db.state.job.request.seconds, 15, "but the length they asked for survives");
});

test("the job's own attempt cap still wins, however good the reason to retry", async () => {
  verdict = BROKEN;
  const jobs = await jobsPromise;
  const db = fakeDb(aJob({ attempts: 3, maxAttempts: 3 }));
  await jobs.completeJob({ db, workerId: "w1" }, db.state.job, outputs as any, { renderMs: 900, costMicros: 12000 });
  assert.equal(db.state.job.status, "succeeded", "a job out of attempts must not be queued again");
});

test("a checker that cannot answer never costs a re-render", async () => {
  verdict = { ok: true, checked: false, problems: [], note: "the checker could not answer" };
  const jobs = await jobsPromise;
  const db = fakeDb(aJob());
  await jobs.completeJob({ db, workerId: "w1" }, db.state.job, outputs as any, { renderMs: 900, costMicros: 12000 });
  assert.equal(db.state.job.status, "succeeded", "our own checker failing must never hold a good picture hostage");
});

test("exports and joins are never second-guessed by the checker", async () => {
  verdict = BROKEN;
  const jobs = await jobsPromise;
  for (const capability of ["export", "timeline.render", "audio.speech", "audio.music"]) {
    const db = fakeDb(aJob({ capability }));
    // eslint-disable-next-line no-await-in-loop
    await jobs.completeJob({ db, workerId: "w1" }, db.state.job, [] as any, { renderMs: 10, costMicros: 0 });
    assert.equal(db.state.job.status, "succeeded", `${capability} must not be sent to a picture checker`);
  }
});

test.after(() => mock.reset());
