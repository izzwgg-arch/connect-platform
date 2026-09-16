/**
 * The worker's self-start. Without `ensureDiscoveryScheduled` nothing ever
 * creates the first `discover` job (enqueueNext deliberately never re-queues
 * that stage), so the engine would sit idle for ever while looking healthy —
 * exactly the failure this file exists to prevent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ensureDiscoveryScheduled, YC_DISCOVERY_EVERY_MS } from "./jobs";

type Row = Record<string, any>;

function fakeDb(opts: { sources: Row[]; budgets?: Row[]; jobs?: Row[] }) {
  const created: Row[] = [];
  const jobs = opts.jobs ?? [];
  const budgets = opts.budgets ?? [];
  return {
    created,
    ycSource: {
      findMany: async ({ where }: any) =>
        opts.sources.filter((s) => (where?.enabled === undefined ? true : s.enabled === where.enabled)),
      findUnique: async ({ where }: any) => {
        const s = opts.sources.find((x) => x.key === where.key) ?? null;
        if (!s) return null;
        return { ...s, budget: budgets.find((b) => b.scope === `source:${s.key}`) ?? null };
      },
    },
    ycBudget: {
      findFirst: async ({ where }: any) => budgets.find((b) => b.scope === where.scope) ?? null,
    },
    ycProcessingJob: {
      count: async ({ where }: any) =>
        jobs.filter(
          (j) =>
            j.sourceKey === where.sourceKey &&
            j.stage === where.stage &&
            (where.state?.in ? where.state.in.includes(j.state) : true),
        ).length,
      create: async ({ data }: any) => {
        created.push(data);
        return { id: `job-${created.length}`, ...data };
      },
    },
  } as any;
}

const RUNNING_BUDGET = { scope: "source:yiddish24", paused: false, mode: "METADATA_ONLY", apiCentsPerDay: 0, spentCentsToday: 0 };
const adapterSource = (over: Row = {}) => ({
  key: "yiddish24",
  kind: "EXTERNAL_ADAPTER",
  adapterKey: "yiddish24",
  enabled: true,
  lastDiscoveryAt: null,
  lastRunAt: null,
  ...over,
});

test("a fresh enabled source is scheduled on the first tick", async () => {
  const db = fakeDb({ sources: [adapterSource()], budgets: [RUNNING_BUDGET] });
  const res = await ensureDiscoveryScheduled(db, { now: new Date("2026-09-16T02:00:00Z") });
  assert.deepEqual(res.scheduled, ["yiddish24"]);
  assert.equal(db.created.length, 1);
  assert.equal(db.created[0].stage, "discover");
  assert.equal(db.created[0].sourceKey, "yiddish24");
});

test("a paused budget schedules nothing, and says why", async () => {
  const db = fakeDb({
    sources: [adapterSource()],
    budgets: [{ ...RUNNING_BUDGET, paused: true }],
  });
  const res = await ensureDiscoveryScheduled(db, { now: new Date() });
  assert.deepEqual(res.scheduled, []);
  assert.equal(db.created.length, 0);
  assert.equal(res.skipped[0].key, "yiddish24");
  assert.ok(res.skipped[0].why.length > 0);
});

test("a discover job already in flight is never duplicated", async () => {
  for (const state of ["PENDING", "RUNNING"]) {
    const db = fakeDb({
      sources: [adapterSource()],
      budgets: [RUNNING_BUDGET],
      jobs: [{ sourceKey: "yiddish24", stage: "discover", state }],
    });
    const res = await ensureDiscoveryScheduled(db, { now: new Date() });
    assert.deepEqual(res.scheduled, [], `state ${state} should block a second job`);
    assert.equal(db.created.length, 0);
  }
});

test("a source walked recently waits for its next window", async () => {
  const now = new Date("2026-09-16T02:00:00Z");
  const db = fakeDb({
    sources: [adapterSource({ lastDiscoveryAt: new Date(now.getTime() - 60_000) })],
    budgets: [RUNNING_BUDGET],
  });
  const res = await ensureDiscoveryScheduled(db, { now });
  assert.deepEqual(res.scheduled, []);
  assert.match(res.skipped[0].why, /min ago/);
});

test("once the window passes it is scheduled again", async () => {
  const now = new Date("2026-09-16T02:00:00Z");
  const db = fakeDb({
    sources: [adapterSource({ lastDiscoveryAt: new Date(now.getTime() - YC_DISCOVERY_EVERY_MS - 1000) })],
    budgets: [RUNNING_BUDGET],
  });
  const res = await ensureDiscoveryScheduled(db, { now });
  assert.deepEqual(res.scheduled, ["yiddish24"]);
});

test("internal tables are never walked — they are counted by the indexer", async () => {
  const db = fakeDb({
    sources: [{ key: "voicemail", kind: "INTERNAL_TABLE", adapterKey: null, enabled: true }],
    budgets: [{ scope: "global", paused: false, mode: "METADATA_ONLY" }],
  });
  const res = await ensureDiscoveryScheduled(db, { now: new Date() });
  assert.deepEqual(res.scheduled, []);
  assert.equal(db.created.length, 0);
});

test("a disabled source is not walked even with a running budget", async () => {
  const db = fakeDb({ sources: [adapterSource({ enabled: false })], budgets: [RUNNING_BUDGET] });
  const res = await ensureDiscoveryScheduled(db, { now: new Date() });
  assert.deepEqual(res.scheduled, []);
});

// ── the two lanes ───────────────────────────────────────────────────────────
//
// A discover job walks listing pages at a ≥2 s politeness gap, so it runs for
// minutes. It used to share one in-flight guard with everything else, which
// meant the cheap local stages (fingerprint, novelty, observe) stood still
// behind it: the queue looked busy while the corpus barely moved. These tests
// pin the separation.

import { claimJobs, YC_WORK_BATCH, YC_DISCOVER_MAX_PAGES } from "./jobs";

function queueDb(rows: Row[]) {
  const store = rows.map((r, i) => ({
    id: r.id ?? `j${i}`,
    state: "PENDING",
    nextRunAt: new Date(0),
    leaseUntil: null,
    attempts: 0,
    priority: 10,
    itemId: null,
    ...r,
  }));
  return {
    store,
    ycProcessingJob: {
      findMany: async ({ where, take }: any) => {
        let out = store.filter((j) => j.state === "PENDING");
        if (where?.stage?.in) out = out.filter((j) => where.stage.in.includes(j.stage));
        if (where?.stage?.notIn) out = out.filter((j) => !where.stage.notIn.includes(j.stage));
        return out.slice(0, take ?? out.length);
      },
      updateMany: async ({ where, data }: any) => {
        const row = store.find((j) => j.id === where.id && j.state === where.state);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  } as any;
}

test("the work lane never claims a discover job", async () => {
  const db = queueDb([
    { id: "d1", stage: "discover", priority: 5 },
    { id: "f1", stage: "fingerprint" },
    { id: "n1", stage: "novelty" },
  ]);
  const claimed = await claimJobs(db, { leaseOwner: "work", limit: 10, excludeStages: ["discover"] });
  assert.deepEqual(
    claimed.map((j: any) => j.id).sort(),
    ["f1", "n1"],
    "discover must be left for its own lane",
  );
  // and it is still PENDING, not burnt by a claim-then-drop
  assert.equal(db.store.find((j: any) => j.id === "d1").state, "PENDING");
  assert.equal(db.store.find((j: any) => j.id === "d1").attempts, 0);
});

test("the discovery lane claims discover and nothing else, one at a time", async () => {
  const db = queueDb([
    { id: "d1", stage: "discover", priority: 5 },
    { id: "d2", stage: "discover", priority: 5 },
    { id: "f1", stage: "fingerprint" },
  ]);
  const claimed = await claimJobs(db, { leaseOwner: "disc", limit: 1, stages: ["discover"] });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].stage, "discover");
  assert.equal(db.store.find((j: any) => j.id === "f1").state, "PENDING", "cheap work is left alone");
});

test("the two lanes cannot both claim the same row", async () => {
  const db = queueDb([{ id: "d1", stage: "discover", priority: 5 }]);
  const [a, b] = await Promise.all([
    claimJobs(db, { leaseOwner: "disc", limit: 1, stages: ["discover"] }),
    claimJobs(db, { leaseOwner: "work", limit: 10, excludeStages: ["discover"] }),
  ]);
  assert.equal(a.length + b.length, 1, "exactly one lane may hold the job");
  assert.equal(a.length, 1, "and it is the discovery lane's");
});

test("throughput knobs are sane and bounded", () => {
  // claimJobs hard-caps at 50; a batch above that would silently do less than
  // it says, which is the kind of number that makes a dashboard lie.
  assert.ok(YC_WORK_BATCH >= 1 && YC_WORK_BATCH <= 50, `batch out of range: ${YC_WORK_BATCH}`);
  assert.ok(YC_DISCOVER_MAX_PAGES >= 1, `pages out of range: ${YC_DISCOVER_MAX_PAGES}`);
});
