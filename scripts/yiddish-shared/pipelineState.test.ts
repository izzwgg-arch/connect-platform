import test from "node:test";
import assert from "node:assert/strict";

import { _resetPipelineStateWarnings, pctOf, progressOf, reportPipelineState } from "./pipelineState";

// ── pctOf ────────────────────────────────────────────────────────────────────

test("pctOf: normal fraction rounds to nearest integer", () => {
  assert.equal(pctOf(1, 4), 25);
  assert.equal(pctOf(1, 3), 33);
  assert.equal(pctOf(2, 3), 67);
  assert.equal(pctOf(10, 10), 100);
  assert.equal(pctOf(0, 10), 0);
});

test("pctOf: total <= 0 is 0, never NaN/Infinity", () => {
  assert.equal(pctOf(5, 0), 0);
  assert.equal(pctOf(5, -1), 0);
  assert.equal(pctOf(0, 0), 0);
});

test("pctOf: current > total clamps to 100", () => {
  assert.equal(pctOf(120, 100), 100);
});

test("pctOf: current < 0 clamps to 0", () => {
  assert.equal(pctOf(-5, 100), 0);
});

test("pctOf: non-finite inputs never throw and are always treated as 0, never NaN", () => {
  assert.equal(pctOf(NaN, 100), 0);
  assert.equal(pctOf(Infinity, 100), 0);
  assert.equal(pctOf(5, NaN), 0);
  assert.equal(pctOf(5, Infinity), 0);
  assert.equal(Number.isNaN(pctOf(Infinity, Infinity)), false);
});

test("progressOf: builds the full shape with pct computed", () => {
  assert.deepEqual(progressOf(3, 12, "items"), { current: 3, total: 12, unit: "items", pct: 25 });
});

// ── reportPipelineState: fake db ─────────────────────────────────────────────

function fakeDb(upsertImpl: (args: any) => Promise<unknown>) {
  const calls: any[] = [];
  return {
    db: {
      ycPipelineState: {
        upsert: async (args: any) => {
          calls.push(args);
          return upsertImpl(args);
        },
      },
    },
    calls,
  };
}

test("reportPipelineState: upserts by key with create+update payloads", async () => {
  const { db, calls } = fakeDb(async () => ({}));
  const ok = await reportPipelineState(db, {
    key: "labelling.orchestrator",
    kind: "labelling",
    status: "running",
    headline: "Packing batch 2026-09-18-a (12.4h, 42 files)",
    progress: progressOf(3, 10, "batches"),
    detail: { batchId: "2026-09-18-a" },
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].where.key, "labelling.orchestrator");
  assert.equal(calls[0].create.status, "running");
  assert.equal(calls[0].create.headline, "Packing batch 2026-09-18-a (12.4h, 42 files)");
  assert.equal(calls[0].create.progress.pct, 30);
  assert.equal(calls[0].update.status, "running");
  assert.deepEqual(calls[0].update.detail, { batchId: "2026-09-18-a" });
});

test("reportPipelineState: startedAt defaults on create, passed through on update only when given", async () => {
  const { db, calls } = fakeDb(async () => ({}));
  await reportPipelineState(db, { key: "k1", kind: "dataset", status: "running", headline: "x" });
  assert.equal(typeof calls[0].create.startedAt, "string");
  assert.equal("startedAt" in calls[0].update, false);

  await reportPipelineState(db, { key: "k1", kind: "dataset", status: "running", headline: "x", startedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(calls[1].update.startedAt, "2026-01-01T00:00:00.000Z");
});

test("reportPipelineState: never throws when db.ycPipelineState is missing", async () => {
  _resetPipelineStateWarnings();
  const ok = await reportPipelineState({}, { key: "no-model", kind: "runner", status: "idle", headline: "x" });
  assert.equal(ok, false);
});

test("reportPipelineState: never throws when db is null/undefined", async () => {
  _resetPipelineStateWarnings();
  assert.equal(await reportPipelineState(null, { key: "null-db", kind: "runner", status: "idle", headline: "x" }), false);
  assert.equal(await reportPipelineState(undefined, { key: "undef-db", kind: "runner", status: "idle", headline: "x" }), false);
});

test("reportPipelineState: never throws when the upsert rejects", async () => {
  _resetPipelineStateWarnings();
  const { db } = fakeDb(async () => {
    throw new Error("connection reset");
  });
  const ok = await reportPipelineState(db, { key: "rejecting", kind: "training", status: "error", headline: "x" });
  assert.equal(ok, false);
});

test("reportPipelineState: logs the failure at most once per key across many calls", async () => {
  _resetPipelineStateWarnings();
  const { db } = fakeDb(async () => {
    throw new Error("boom");
  });
  const originalError = console.error;
  let errorCalls = 0;
  console.error = () => {
    errorCalls += 1;
  };
  try {
    for (let i = 0; i < 25; i++) {
      // eslint-disable-next-line no-await-in-loop
      await reportPipelineState(db, { key: "spammy", kind: "labelling", status: "running", headline: `tick ${i}` });
    }
  } finally {
    console.error = originalError;
  }
  assert.equal(errorCalls, 1);
});

test("reportPipelineState: a different key still gets its own single warning", async () => {
  _resetPipelineStateWarnings();
  const { db } = fakeDb(async () => {
    throw new Error("boom");
  });
  const originalError = console.error;
  let errorCalls = 0;
  console.error = () => {
    errorCalls += 1;
  };
  try {
    await reportPipelineState(db, { key: "key-a", kind: "labelling", status: "running", headline: "x" });
    await reportPipelineState(db, { key: "key-a", kind: "labelling", status: "running", headline: "x" });
    await reportPipelineState(db, { key: "key-b", kind: "dataset", status: "running", headline: "x" });
  } finally {
    console.error = originalError;
  }
  assert.equal(errorCalls, 2);
});
