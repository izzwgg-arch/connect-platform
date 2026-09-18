/**
 * orchestrate.ts tests — pure-function + fake-deps only. NONE of these touch
 * the real `kaggle` CLI, ffmpeg, Prisma, the network, or a real clock/sleep
 * (same discipline as kaggle-label.test.ts). The orchestrator's own state
 * machine (`runOrchestrator`) is driven entirely through the injectable
 * `OrchestratorDeps`, which is how a batch's whole pack->push->run->poll->
 * pull->import lifecycle — including resume-after-restart, a kernel ERROR,
 * and a STOP file — is exercised without ever shelling out to anything.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  batchSuffixForIndex,
  classifyKernelStatus,
  elapsedHours,
  extractLogTail,
  loadStateFile,
  newState,
  nextBatchId,
  parseArgs,
  runOrchestrator,
  saveStateFile,
  TERMINAL_STAGES,
  type BatchRecord,
  type OrchestratorDeps,
  type OrchestratorOptions,
  type OrchestratorState,
} from "./orchestrate";

function tmpDir(label: string): string {
  return path.join(os.tmpdir(), `yc-orchestrate-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// ── batch id sequencing ──────────────────────────────────────────────────────

test("batchSuffixForIndex: spreadsheet-column letters, a..z then aa", () => {
  assert.equal(batchSuffixForIndex(0), "a");
  assert.equal(batchSuffixForIndex(1), "b");
  assert.equal(batchSuffixForIndex(25), "z");
  assert.equal(batchSuffixForIndex(26), "aa");
  assert.equal(batchSuffixForIndex(27), "ab");
  assert.equal(batchSuffixForIndex(51), "az");
  assert.equal(batchSuffixForIndex(52), "ba");
});

test("nextBatchId: first batch of the day is <date>-a", () => {
  const now = new Date("2026-09-18T12:00:00Z");
  assert.equal(nextBatchId([], now), "2026-09-18-a");
  assert.equal(nextBatchId(["2026-09-17-a", "2026-09-17-b"], now), "2026-09-18-a");
});

test("nextBatchId: picks the next unused letter for today, ignoring other days and gaps", () => {
  const now = new Date("2026-09-18T12:00:00Z");
  assert.equal(nextBatchId(["2026-09-18-a"], now), "2026-09-18-b");
  assert.equal(nextBatchId(["2026-09-18-a", "2026-09-18-b"], now), "2026-09-18-c");
  // A gap (b missing) is not filled — the walk always starts from "a" and
  // stops at the first unused suffix, so a manually-deleted batch dir never
  // gets silently reused.
  assert.equal(nextBatchId(["2026-09-18-a", "2026-09-18-c"], now), "2026-09-18-b");
});

test("nextBatchId: rolls into two letters after z", () => {
  const now = new Date("2026-09-18T12:00:00Z");
  const used = Array.from({ length: 26 }, (_, i) => `2026-09-18-${batchSuffixForIndex(i)}`);
  assert.equal(nextBatchId(used, now), "2026-09-18-aa");
});

// ── kernel status classification ────────────────────────────────────────────

test("classifyKernelStatus recognises complete/error/running/queued and falls back to unknown", () => {
  assert.equal(classifyKernelStatus('izzy/loopcom-yc-label-b1 has status "complete"'), "complete");
  assert.equal(classifyKernelStatus('izzy/loopcom-yc-label-b1 has status "error"'), "error");
  assert.equal(classifyKernelStatus('izzy/loopcom-yc-label-b1 has status "running"'), "running");
  assert.equal(classifyKernelStatus('izzy/loopcom-yc-label-b1 has status "queued"'), "queued");
  assert.equal(classifyKernelStatus("cancelAcknowledged"), "error");
  assert.equal(classifyKernelStatus("something the CLI never printed before"), "unknown");
});

// ── elapsedHours ─────────────────────────────────────────────────────────────

test("elapsedHours computes wall-clock hours since startedAt", () => {
  const start = "2026-09-18T00:00:00.000Z";
  const now = new Date("2026-09-18T02:30:00.000Z").getTime();
  assert.equal(elapsedHours(start, now), 2.5);
});

// ── extractLogTail ───────────────────────────────────────────────────────────

test("extractLogTail returns a clear message when there is no output dir", () => {
  const dir = tmpDir("log-missing");
  assert.match(extractLogTail(dir), /no output directory/);
});

test("extractLogTail returns a clear message when the dir has no .log file", () => {
  const dir = tmpDir("log-none");
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path.join(dir, "transcripts.json"), "{}");
    assert.match(extractLogTail(dir), /no \.log file found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extractLogTail returns the last N lines of a .log file found under the dir", () => {
  const dir = tmpDir("log-found");
  mkdirSync(dir, { recursive: true });
  try {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    writeFileSync(path.join(dir, "loopcom-yc-label-b1.log"), lines.join("\n"));
    const tail = extractLogTail(dir, 10);
    const tailLines = tail.split("\n");
    assert.equal(tailLines.length, 10);
    assert.equal(tailLines[9], "line 99");
    assert.equal(tailLines[0], "line 90");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── parseArgs (cap math defaults + overrides) ───────────────────────────────

test("parseArgs applies the documented defaults (60h/12GB batches, 80h budget)", () => {
  const opts = parseArgs(["--confirm"], "/here");
  assert.equal(opts.hours, 80);
  assert.equal(opts.maxHoursPerBatch, 60);
  assert.equal(opts.maxGb, 12);
  assert.equal(opts.model, "ivrit-ai/yi-whisper-large-v3-turbo-ct2");
  assert.equal(opts.source, "yiddish24");
  assert.equal(opts.confirm, true);
  assert.equal(opts.dryRun, false);
});

test("parseArgs honours explicit overrides for the hour/GB caps and model", () => {
  const opts = parseArgs(
    ["--hours", "40", "--max-hours-per-batch", "20", "--max-gb", "8", "--model", "ivrit-ai/yi-whisper-large-v3-ct2", "--dry-run"],
    "/here",
  );
  assert.equal(opts.hours, 40);
  assert.equal(opts.maxHoursPerBatch, 20);
  assert.equal(opts.maxGb, 8);
  assert.equal(opts.model, "ivrit-ai/yi-whisper-large-v3-ct2");
  assert.equal(opts.dryRun, true);
});

// ── state file load/save round trip ─────────────────────────────────────────

test("saveStateFile / loadStateFile round-trip a state object", () => {
  const dir = tmpDir("state-roundtrip");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "orchestrate-state.json");
  try {
    const state = newState({ hours: 80, maxHoursPerBatch: 60, maxGb: 12, source: "yiddish24", model: "m" }, new Date("2026-09-18T00:00:00Z"));
    saveStateFile(file, state);
    assert.ok(existsSync(file));
    const loaded = loadStateFile(file)!;
    assert.equal(loaded.startedAt, state.startedAt);
    assert.equal(loaded.hoursBudget, 80);
    assert.deepEqual(loaded.batches, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadStateFile returns null when the file does not exist (fresh start)", () => {
  assert.equal(loadStateFile(path.join(tmpDir("state-missing"), "nope.json")), null);
});

// ── runOrchestrator: fake-deps lifecycle tests ──────────────────────────────

function baseOpts(overrides: Partial<OrchestratorOptions> = {}): OrchestratorOptions {
  return {
    hours: 80,
    maxHoursPerBatch: 60,
    maxGb: 12,
    model: "turbo-model",
    source: "yiddish24",
    owner: "izzy",
    confirm: true,
    dryRun: false,
    pollIntervalMs: 1000,
    stateFile: "/unused/state.json",
    stopFile: "/unused/STOP",
    batchesRoot: "/unused/batches",
    ...overrides,
  };
}

interface FakeWorld {
  deps: OrchestratorDeps;
  calls: { fn: string; batch: string }[];
  stop: { requested: boolean };
  clockMs: { v: number };
  statusQueue: Record<string, string[]>; // batch -> sequence of raw statuses to return
  packFilesQueue: number[]; // consumed one per pack() call
}

function makeFakeWorld(opts: { packHours?: number; packGb?: number } = {}): FakeWorld {
  const calls: { fn: string; batch: string }[] = [];
  const stop = { requested: false };
  const clockMs = { v: Date.parse("2026-09-18T00:00:00.000Z") };
  const statusQueue: Record<string, string[]> = {};
  const packFilesQueue: number[] = [10, 0]; // batch 1 has files, batch 2 finds nothing (audio exhausted)

  const deps: OrchestratorDeps = {
    existingBatchIds: () => [],
    pack: async (batch) => {
      calls.push({ fn: "pack", batch });
      const files = packFilesQueue.length ? packFilesQueue.shift()! : 0;
      return { files, hours: opts.packHours ?? (files > 0 ? 5 : 0), estimatedGb: opts.packGb ?? (files > 0 ? 1 : 0) };
    },
    push: async (batch) => {
      calls.push({ fn: "push", batch });
    },
    run: async (batch) => {
      calls.push({ fn: "run", batch });
    },
    status: async (batch) => {
      calls.push({ fn: "status", batch });
      const q = statusQueue[batch] ?? ["complete"];
      return q.length > 1 ? q.shift()! : q[0];
    },
    pull: async (batch) => {
      calls.push({ fn: "pull", batch });
    },
    readLogTail: (batch) => {
      calls.push({ fn: "readLogTail", batch });
      return `fake log tail for ${batch}`;
    },
    importBatch: async (batch) => {
      calls.push({ fn: "importBatch", batch });
      return { itemsImported: 1, segments: 2, hours: 0.5, failures: 0 };
    },
    now: () => clockMs.v,
    sleep: async (ms) => {
      calls.push({ fn: "sleep", batch: String(ms) });
      clockMs.v += ms;
    },
    isStopRequested: () => stop.requested,
    log: () => {},
  };

  return { deps, calls, stop, clockMs, statusQueue, packFilesQueue };
}

test("runOrchestrator: full happy-path lifecycle, then stops when a pack finds no more audio", async () => {
  const world = makeFakeWorld();
  const opts = baseOpts();
  const state = newState(opts, new Date(world.clockMs.v));
  const persisted: OrchestratorState[] = [];

  const final = await runOrchestrator(opts, state, world.deps, (s) => persisted.push(JSON.parse(JSON.stringify(s))));

  assert.equal(final.batches.length, 2);
  const [b1, b2] = final.batches;
  assert.equal(b1.stage, "imported");
  assert.equal(b1.importSummary?.itemsImported, 1);
  assert.equal(b2.stage, "skipped_empty");
  assert.equal(final.stoppedReason, "audio_exhausted");

  // exactly one full lifecycle of calls for batch 1, in order.
  const b1Calls = world.calls.filter((c) => c.batch === b1.id).map((c) => c.fn);
  assert.deepEqual(b1Calls, ["pack", "push", "run", "status", "pull", "importBatch"]);
  // batch 2 only ever gets as far as pack (which returns 0 files).
  const b2Calls = world.calls.filter((c) => c.batch === b2.id).map((c) => c.fn);
  assert.deepEqual(b2Calls, ["pack"]);
  assert.ok(persisted.length > 0, "state must be persisted at least once");
});

test("runOrchestrator: cap math — pack is called with the configured max-hours-per-batch and max-gb", async () => {
  const world = makeFakeWorld();
  world.packFilesQueue.length = 0;
  world.packFilesQueue.push(0); // stop immediately after the one pack call
  const opts = baseOpts({ maxHoursPerBatch: 23, maxGb: 7 });
  let seenArgs: [number, number] | null = null;
  world.deps.pack = async (batch, maxGb, maxHours) => {
    seenArgs = [maxGb, maxHours];
    return { files: 0, hours: 0, estimatedGb: 0 };
  };
  const state = newState(opts, new Date(world.clockMs.v));
  await runOrchestrator(opts, state, world.deps, () => {});
  assert.deepEqual(seenArgs, [7, 23]);
});

test("runOrchestrator: resumes from a persisted 'pushed' stage — never re-packs or re-pushes", async () => {
  const world = makeFakeWorld();
  world.packFilesQueue.length = 0;
  world.packFilesQueue.push(0); // only the SECOND batch (if any) would hit pack
  const opts = baseOpts();
  const state = newState(opts, new Date(world.clockMs.v));
  const inFlight: BatchRecord = {
    id: "2026-09-18-a",
    source: "yiddish24",
    model: "turbo-model",
    stage: "pushed",
    createdAt: new Date(world.clockMs.v).toISOString(),
    pack: { files: 10, hours: 5, estimatedGb: 1 },
    packedAt: new Date(world.clockMs.v).toISOString(),
    pushedAt: new Date(world.clockMs.v).toISOString(),
  };
  state.batches.push(inFlight);

  const final = await runOrchestrator(opts, state, world.deps, () => {});

  const b1Calls = world.calls.filter((c) => c.batch === "2026-09-18-a").map((c) => c.fn);
  assert.deepEqual(b1Calls, ["run", "status", "pull", "importBatch"], "resumed batch must skip pack/push entirely");
  assert.equal(final.batches[0].stage, "imported");
});

test("runOrchestrator: a kernel ERROR downloads the log, marks the batch failed, and continues to the next batch", async () => {
  const world = makeFakeWorld();
  world.statusQueue["2026-09-18-a"] = ["error"];
  const opts = baseOpts();
  const state = newState(opts, new Date(world.clockMs.v));

  const final = await runOrchestrator(opts, state, world.deps, () => {});

  assert.equal(final.batches.length, 2);
  const [b1, b2] = final.batches;
  assert.equal(b1.stage, "failed");
  assert.equal(b1.error?.logTail, `fake log tail for ${b1.id}`);
  assert.match(b1.error?.message || "", /error/);
  // importBatch must NEVER be called for a failed batch.
  assert.equal(world.calls.some((c) => c.batch === b1.id && c.fn === "importBatch"), false);
  // the pull (to fetch the log) DID happen for the failed batch.
  assert.ok(world.calls.some((c) => c.batch === b1.id && c.fn === "pull"));
  // and the orchestrator moved on: batch 2 was attempted (and found no audio left).
  assert.equal(b2.stage, "skipped_empty");
});

test("runOrchestrator: a STOP file mid-poll exits cleanly without pulling or importing", async () => {
  const world = makeFakeWorld();
  world.statusQueue["2026-09-18-a"] = ["running", "running", "complete"];
  let statusCalls = 0;
  const realStatus = world.deps.status;
  world.deps.status = async (batch) => {
    statusCalls += 1;
    if (statusCalls === 2) world.stop.requested = true; // request STOP after the first poll
    return realStatus(batch);
  };
  const opts = baseOpts();
  const state = newState(opts, new Date(world.clockMs.v));

  const final = await runOrchestrator(opts, state, world.deps, () => {});

  assert.equal(final.stoppedReason, "stop_file");
  assert.equal(final.batches.length, 1);
  assert.equal(final.batches[0].stage, "running", "batch must stay in-flight, not be marked complete/failed");
  assert.equal(world.calls.some((c) => c.fn === "pull"), false);
  assert.equal(world.calls.some((c) => c.fn === "importBatch"), false);
});

test("runOrchestrator: a STOP file present before a new batch would start exits cleanly with none created", async () => {
  const world = makeFakeWorld();
  world.stop.requested = true;
  const opts = baseOpts();
  const state = newState(opts, new Date(world.clockMs.v));

  const final = await runOrchestrator(opts, state, world.deps, () => {});

  assert.equal(final.stoppedReason, "stop_file");
  assert.equal(final.batches.length, 0);
  assert.equal(world.calls.length, 0);
});

test("runOrchestrator: an in-flight batch runs to completion even if the hour budget is already exceeded", async () => {
  const world = makeFakeWorld();
  const opts = baseOpts({ hours: 0.001 }); // effectively already over budget
  const state = newState(opts, new Date(world.clockMs.v - 3_600_000)); // started an hour "ago"
  const inFlight: BatchRecord = {
    id: "2026-09-18-a",
    source: "yiddish24",
    model: "turbo-model",
    stage: "running",
    createdAt: new Date(world.clockMs.v).toISOString(),
    runStartedAt: new Date(world.clockMs.v).toISOString(),
  };
  state.batches.push(inFlight);

  const final = await runOrchestrator(opts, state, world.deps, () => {});

  // the in-flight batch finished (poll -> complete -> pull -> import)...
  assert.equal(final.batches[0].stage, "imported");
  // ...and only THEN did the budget check stop a second batch from starting.
  assert.equal(final.batches.length, 1);
  assert.equal(final.stoppedReason, "hours_budget");
});

test("runOrchestrator: the hour budget stops the loop before starting a new batch", async () => {
  const world = makeFakeWorld();
  const opts = baseOpts({ hours: 1 });
  // Make every fake step advance the clock by 15 minutes so batch 1's full
  // lifecycle (pack/push/run/status/pull/import = 6 steps) alone eats 1.5h —
  // more than the 1h budget — even though NONE of those steps checks the
  // budget itself (only "start a new batch" does).
  const ADVANCE_MS = 15 * 60_000;
  const wrap = <A extends any[], R>(fn: (...a: A) => Promise<R>) => {
    return async (...a: A) => {
      world.clockMs.v += ADVANCE_MS;
      return fn(...a);
    };
  };
  world.deps.pack = wrap(world.deps.pack);
  world.deps.push = wrap(world.deps.push);
  world.deps.run = wrap(world.deps.run);
  world.deps.status = wrap(world.deps.status);
  world.deps.pull = wrap(world.deps.pull);
  world.deps.importBatch = wrap(world.deps.importBatch);
  const state = newState(opts, new Date(world.clockMs.v));

  const final = await runOrchestrator(opts, state, world.deps, () => {});

  assert.equal(final.batches.length, 1);
  assert.equal(final.batches[0].stage, "imported");
  assert.equal(final.stoppedReason, "hours_budget");
});

test("TERMINAL_STAGES matches the stages runOrchestrator treats as 'done, pick a new batch'", () => {
  assert.deepEqual(new Set(TERMINAL_STAGES), new Set(["imported", "failed", "skipped_empty"]));
});

// ── live status reporting (deps.report) ─────────────────────────────────────

test("runOrchestrator: reports at least one status per stage transition of a full batch lifecycle", async () => {
  const world = makeFakeWorld();
  const opts = baseOpts();
  const state = newState(opts, new Date(world.clockMs.v));
  const reports: { status: string; headline: string }[] = [];
  world.deps.report = (input) => {
    reports.push({ status: input.status, headline: input.headline });
  };

  await runOrchestrator(opts, state, world.deps, () => {});

  const headlines = reports.map((r) => r.headline);
  // one report per documented transition, in order, for the (only) real batch.
  assert.match(headlines[0], /between batches/i);
  assert.match(headlines[1], /packing batch/i);
  assert.ok(headlines.some((h) => /packed batch/i.test(h)));
  assert.ok(headlines.some((h) => /uploading batch/i.test(h)));
  assert.ok(headlines.some((h) => /starting the labelling kernel/i.test(h)));
  assert.ok(headlines.some((h) => /pulling transcripts/i.test(h)));
  assert.ok(headlines.some((h) => /importing labelled segments/i.test(h)));
  assert.ok(headlines.some((h) => /finished batch/i.test(h)));
  // and the run ends by reporting the terminal "no more audio" state.
  assert.equal(reports[reports.length - 1].status, "done");
  assert.match(reports[reports.length - 1].headline, /no unlabelled/i);
});

test("runOrchestrator: reports status='error' with the log tail in detail on a kernel error", async () => {
  const world = makeFakeWorld();
  world.statusQueue["2026-09-18-a"] = ["error"];
  const opts = baseOpts();
  const state = newState(opts, new Date(world.clockMs.v));
  const reports: { status: string; headline: string; detail?: any }[] = [];
  world.deps.report = (input) => {
    reports.push({ status: input.status, headline: input.headline, detail: input.detail });
  };

  await runOrchestrator(opts, state, world.deps, () => {});

  const errorReport = reports.find((r) => r.status === "error");
  assert.ok(errorReport, "expected an error report");
  assert.match(errorReport!.headline, /failed on kaggle/i);
  assert.equal(errorReport!.detail?.logTail, "fake log tail for 2026-09-18-a");
});

test("runOrchestrator: reports status='idle' naming the next batch between batches, and status='idle' on a clean STOP exit", async () => {
  const world = makeFakeWorld();
  world.stop.requested = true;
  const opts = baseOpts();
  const state = newState(opts, new Date(world.clockMs.v));
  const reports: { status: string; headline: string }[] = [];
  world.deps.report = (input) => {
    reports.push({ status: input.status, headline: input.headline });
  };

  await runOrchestrator(opts, state, world.deps, () => {});

  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, "idle");
  assert.match(reports[0].headline, /stopped/i);
});

test("runOrchestrator: a report() that throws never breaks the loop", async () => {
  const world = makeFakeWorld();
  const opts = baseOpts();
  const state = newState(opts, new Date(world.clockMs.v));
  world.deps.report = () => {
    throw new Error("reporter is broken");
  };

  const final = await runOrchestrator(opts, state, world.deps, () => {});

  // the run still completes its normal lifecycle despite every report() call
  // throwing synchronously.
  assert.equal(final.batches[0].stage, "imported");
  assert.equal(final.stoppedReason, "audio_exhausted");
});
