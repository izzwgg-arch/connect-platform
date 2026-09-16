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
