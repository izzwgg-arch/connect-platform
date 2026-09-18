/**
 * kaggle-label.ts — pure-function, fake-db and fake-exec tests. NONE of these
 * touch the real `kaggle` CLI, ffmpeg, Prisma, or the network (same
 * discipline as ../yiddish-finetune/kaggle-run.test.ts and
 * ../yiddish-finetune/build-dataset.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  assertSourceAllowed,
  buildImportRows,
  buildManifestJson,
  buildTranscodeArgs,
  datasetSlugFor,
  estimateOggBytes,
  formatPackStats,
  importBatch,
  kernelSlugFor,
  originRefFor,
  pullBatch,
  pushBatch,
  readManifestFile,
  resolveEngineFns,
  runBatch,
  runPack,
  selectForPack,
  stampManifestModel,
  statusBatch,
  transcodeToOpus,
  writeManifest,
  YIDDISH24_SOURCE_KEY,
  type BatchManifestEntry,
  type ImportDeps,
  type PackCandidate,
  type TranscriptsFile,
} from "./kaggle-label";
import type { ExecFn } from "../yiddish-finetune/kaggle-run";

function tmpDir(label: string): string {
  return path.join(os.tmpdir(), `yc-kaggle-label-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// ── customer-source guard ───────────────────────────────────────────────────

test("assertSourceAllowed: yiddish24 always passes", () => {
  assert.doesNotThrow(() => assertSourceAllowed(YIDDISH24_SOURCE_KEY, false));
  assert.doesNotThrow(() => assertSourceAllowed(YIDDISH24_SOURCE_KEY, true));
});

test("assertSourceAllowed: any other source refuses without the flag", () => {
  assert.throws(() => assertSourceAllowed("voicemail", false), /--allow-customer-sources/);
  assert.throws(() => assertSourceAllowed("call_recordings", false), /--allow-customer-sources/);
});

test("assertSourceAllowed: the flag permits a customer source", () => {
  assert.doesNotThrow(() => assertSourceAllowed("voicemail", true));
});

// ── estimateOggBytes / selectForPack (pure caps) ────────────────────────────

test("estimateOggBytes scales with duration at the fixed 24kbps target", () => {
  const oneMinute = estimateOggBytes(60_000);
  const twoMinutes = estimateOggBytes(120_000);
  // ~24000 bits/sec / 8 = 3000 bytes/sec, so a minute is ~180000 bytes plus overhead.
  assert.ok(oneMinute > 170_000 && oneMinute < 190_000, `unexpected estimate ${oneMinute}`);
  assert.ok(twoMinutes > oneMinute * 1.9, "doubling duration should roughly double bytes");
});

function candidate(itemId: string, durationMs: number): PackCandidate {
  return { itemId, assetId: `${itemId}-asset`, sourceKey: YIDDISH24_SOURCE_KEY, storageKey: `/audio/${itemId}.mp3`, durationMs };
}

test("selectForPack stops at --max-hours instead of skipping to a smaller later item", () => {
  const candidates = [candidate("a", 3_600_000), candidate("b", 3_600_000), candidate("c", 600_000)];
  const { selected, totalDurationMs } = selectForPack(candidates, { maxGb: 0, maxHours: 1.5 });
  // a (1h) fits; b would push total to 2h > 1.5h cap, so the walk STOPS there —
  // c (10min), which alone would fit, is never reached.
  assert.deepEqual(selected.map((c) => c.itemId), ["a"]);
  assert.equal(totalDurationMs, 3_600_000);
});

test("selectForPack stops at --max-gb", () => {
  // At 24kbps (~3000 bytes/sec), 1GB holds ~99.4h. A single 60h item (~0.6GB)
  // fits; two of them (~1.2GB) do not, so the walk stops after the first.
  const bigMs = 60 * 3_600_000;
  const candidates = [candidate("a", bigMs), candidate("b", bigMs)];
  const { selected } = selectForPack(candidates, { maxGb: 1, maxHours: 0 });
  assert.deepEqual(selected.map((c) => c.itemId), ["a"]);
});

test("selectForPack is unlimited when both caps are 0", () => {
  const candidates = [candidate("a", 3_600_000), candidate("b", 3_600_000), candidate("c", 3_600_000)];
  const { selected } = selectForPack(candidates, { maxGb: 0, maxHours: 0 });
  assert.equal(selected.length, 3);
});

// ── manifest ─────────────────────────────────────────────────────────────────

test("buildManifestJson round-trips the exact entry shape", () => {
  const entries: BatchManifestEntry[] = [{ itemId: "i1", assetId: "a1", sourceKey: "yiddish24", file: "audio/a1.ogg", durationMs: 12_345 }];
  const parsed = JSON.parse(buildManifestJson(entries));
  assert.deepEqual(parsed, entries);
});

test("writeManifest creates the batch dir and writes manifest.json", () => {
  const dir = tmpDir("manifest");
  try {
    const entries: BatchManifestEntry[] = [{ itemId: "i1", assetId: "a1", sourceKey: "yiddish24", file: "audio/a1.ogg", durationMs: 1000 }];
    const file = writeManifest(dir, entries);
    assert.equal(file, path.join(dir, "manifest.json"));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), entries);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── manifest.json: plain array vs {model, entries} ──────────────────────────

test("readManifestFile accepts the plain array shape pack always writes", () => {
  const dir = tmpDir("manifest-array");
  try {
    const entries: BatchManifestEntry[] = [{ itemId: "i1", assetId: "a1", sourceKey: "yiddish24", file: "audio/a1.ogg", durationMs: 1000 }];
    writeManifest(dir, entries);
    const parsed = readManifestFile(dir);
    assert.deepEqual(parsed.entries, entries);
    assert.equal(parsed.model, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readManifestFile accepts the {model, entries} object shape run --model stamps", () => {
  const dir = tmpDir("manifest-object");
  mkdirSync(dir, { recursive: true });
  try {
    const entries: BatchManifestEntry[] = [{ itemId: "i1", assetId: "a1", sourceKey: "yiddish24", file: "audio/a1.ogg", durationMs: 1000 }];
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ model: "ivrit-ai/yi-whisper-large-v3-ct2", entries }, null, 2), "utf8");
    const parsed = readManifestFile(dir);
    assert.deepEqual(parsed.entries, entries);
    assert.equal(parsed.model, "ivrit-ai/yi-whisper-large-v3-ct2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stampManifestModel rewrites an array-shaped manifest into {model, entries} without touching the entries", () => {
  const dir = tmpDir("stamp-array");
  try {
    const entries: BatchManifestEntry[] = [
      { itemId: "i1", assetId: "a1", sourceKey: "yiddish24", file: "audio/a1.ogg", durationMs: 1000 },
      { itemId: "i2", assetId: "a2", sourceKey: "yiddish24", file: "audio/a2.ogg", durationMs: 2000 },
    ];
    writeManifest(dir, entries);
    stampManifestModel(dir, "ivrit-ai/yi-whisper-large-v3-ct2");
    const parsed = readManifestFile(dir);
    assert.equal(parsed.model, "ivrit-ai/yi-whisper-large-v3-ct2");
    assert.deepEqual(parsed.entries, entries);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stampManifestModel replaces an already-stamped model (re-stamping is idempotent in shape)", () => {
  const dir = tmpDir("stamp-twice");
  try {
    const entries: BatchManifestEntry[] = [{ itemId: "i1", assetId: "a1", sourceKey: "yiddish24", file: "audio/a1.ogg", durationMs: 1000 }];
    writeManifest(dir, entries);
    stampManifestModel(dir, "model-a");
    stampManifestModel(dir, "model-b");
    const parsed = readManifestFile(dir);
    assert.equal(parsed.model, "model-b");
    assert.deepEqual(parsed.entries, entries);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readManifestFile throws a clear error on a manifest that is neither shape", () => {
  const dir = tmpDir("manifest-bad");
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ notEntries: [] }), "utf8");
    assert.throws(() => readManifestFile(dir), /neither an array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatPackStats sums hours/GB and carries the missing-source count through", () => {
  const entries: BatchManifestEntry[] = [
    { itemId: "i1", assetId: "a1", sourceKey: "yiddish24", file: "audio/a1.ogg", durationMs: 3_600_000 },
    { itemId: "i2", assetId: "a2", sourceKey: "yiddish24", file: "audio/a2.ogg", durationMs: 1_800_000 },
  ];
  const stats = formatPackStats(entries, 3);
  assert.equal(stats.files, 2);
  assert.equal(stats.hours, 1.5);
  assert.equal(stats.skippedMissingSource, 3);
  assert.ok(stats.estimatedGb > 0);
});

// ── ffmpeg transcode ─────────────────────────────────────────────────────────

test("buildTranscodeArgs produces the exact 16kHz mono Opus recipe", () => {
  const args = buildTranscodeArgs("/in/a.mp3", "/out/a.ogg");
  assert.deepEqual(args, ["-y", "-hide_banner", "-loglevel", "error", "-i", "/in/a.mp3", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "/out/a.ogg"]);
});

test("transcodeToOpus succeeds when the injected exec returns code 0", async () => {
  const calls: string[][] = [];
  const execFn: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = await transcodeToOpus("ffmpeg", "/in/a.mp3", "/out/a.ogg", { execFn });
  assert.equal(res.ok, true);
  assert.equal(calls[0][0], "ffmpeg");
});

test("transcodeToOpus reports failure with the stderr reason and exit code", async () => {
  const execFn: ExecFn = async () => ({ code: 1, stdout: "", stderr: "no such filter: libopus" });
  const res = await transcodeToOpus("ffmpeg", "/in/a.mp3", "/out/a.ogg", { execFn }, { retries: 1 });
  assert.equal(res.ok, false);
  assert.match(res.reason || "", /libopus/);
  assert.match(res.reason || "", /exit code 1/);
});

test("transcodeToOpus never leaves an empty reason on a silent spawn failure (both streams empty)", async () => {
  const execFn: ExecFn = async () => ({ code: 1, stdout: "", stderr: "" });
  const res = await transcodeToOpus("ffmpeg", "/in/a.mp3", "/out/a.ogg", { execFn }, { retries: 1 });
  assert.equal(res.ok, false);
  assert.ok(res.reason && res.reason.length > 0, "reason must never be empty");
  assert.match(res.reason || "", /exit code 1/);
});

test("transcodeToOpus retries with the documented 2s/5s backoff and succeeds on the 3rd attempt", async () => {
  let calls = 0;
  const execFn: ExecFn = async () => {
    calls += 1;
    if (calls < 3) return { code: 1, stdout: "", stderr: "transient spawn failure" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const sleeps: number[] = [];
  const sleepFn = async (ms: number) => {
    sleeps.push(ms);
  };
  const res = await transcodeToOpus("ffmpeg", "/in/a.mp3", "/out/a.ogg", { execFn }, { sleepFn });
  assert.equal(res.ok, true);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [2000, 5000]);
});

test("transcodeToOpus gives up after the bounded retry count and reports the last failure", async () => {
  let calls = 0;
  const execFn: ExecFn = async () => {
    calls += 1;
    return { code: 1, stdout: "", stderr: `attempt ${calls} failed` };
  };
  const sleeps: number[] = [];
  const res = await transcodeToOpus("ffmpeg", "/in/a.mp3", "/out/a.ogg", { execFn }, { sleepFn: async (ms) => sleeps.push(ms) });
  assert.equal(res.ok, false);
  assert.equal(calls, 3, "default is 3 total attempts");
  assert.equal(res.attempts, 3);
  assert.match(res.reason || "", /attempt 3 failed/);
  assert.deepEqual(sleeps, [2000, 5000]);
});

// ── runPack: fake db + fake ffmpeg, real fs in a temp dir ───────────────────

function makeFakeSourceDb(items: any[]) {
  let findManyCalls = 0;
  return {
    ycSourceItem: {
      findMany: async ({ where }: any) => {
        findManyCalls += 1;
        return items
          .filter((it) => {
            if (where.source?.key && it.source?.key !== where.source.key) return false;
            const hasStoredAsset = (it.assets || []).some((a: any) => a.storage === "STORED" && a.deletedAt == null);
            if (where.assets?.some && !hasStoredAsset) return false;
            const hasIvrit = (it.transcripts || []).some((t: any) => t.engine === "ivrit");
            if (where.transcripts?.none && hasIvrit) return false;
            return true;
          })
          .map((it) => ({ ...it, assets: (it.assets || []).filter((a: any) => a.storage === "STORED" && a.deletedAt == null) }));
      },
    },
    _findManyCallCount: () => findManyCalls,
  };
}

test("runPack selects only unlabelled+stored items of the given source, skips a missing source file, and writes the manifest", async () => {
  const dir = tmpDir("pack");
  const audioSrcOk = path.join(dir, "source-a.mp3");
  mkdirSync(dir, { recursive: true });
  writeFileSync(audioSrcOk, "fake-mp3-bytes");

  const items = [
    { id: "item-a", source: { key: "yiddish24" }, durationSec: 100, assets: [{ id: "asset-a", storage: "STORED", deletedAt: null, storageKey: audioSrcOk, durationMs: 100_000 }], transcripts: [] },
    { id: "item-b", source: { key: "yiddish24" }, durationSec: 50, assets: [{ id: "asset-b", storage: "STORED", deletedAt: null, storageKey: path.join(dir, "does-not-exist.mp3"), durationMs: 50_000 }], transcripts: [] },
    { id: "item-c", source: { key: "yiddish24" }, assets: [{ id: "asset-c", storage: "STORED", deletedAt: null, storageKey: audioSrcOk, durationMs: 10_000 }], transcripts: [{ engine: "ivrit" }] },
    { id: "item-d", source: { key: "other-source" }, assets: [{ id: "asset-d", storage: "STORED", deletedAt: null, storageKey: audioSrcOk, durationMs: 10_000 }], transcripts: [] },
  ];
  const db = makeFakeSourceDb(items);
  const batchesRoot = path.join(dir, "batches");
  const execFn: ExecFn = async (_cmd, args) => {
    writeFileSync(args[args.length - 1], "fake-ogg-bytes");
    return { code: 0, stdout: "", stderr: "" };
  };

  try {
    await runPack(
      { source: "yiddish24", batch: "t1", maxGb: 0, maxHours: 0, allowCustomerSources: false, dryRun: false, batchesRoot, ffmpegPath: "ffmpeg" },
      db,
      { execFn },
    );

    const manifest = JSON.parse(readFileSync(path.join(batchesRoot, "t1", "manifest.json"), "utf8"));
    // Only item-a: item-b's source file is missing on disk, item-c already has
    // an ivrit transcript, item-d is a different source.
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].itemId, "item-a");
    assert.equal(manifest[0].assetId, "asset-a");
    assert.equal(manifest[0].file, "audio/asset-a.ogg");
    assert.ok(existsSync(path.join(batchesRoot, "t1", "audio", "asset-a.ogg")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPack --dry-run computes the selection but writes nothing and never calls ffmpeg", async () => {
  const dir = tmpDir("pack-dry");
  const src = path.join(dir, "a.mp3");
  mkdirSync(dir, { recursive: true });
  writeFileSync(src, "fake");
  const db = makeFakeSourceDb([{ id: "item-a", source: { key: "yiddish24" }, assets: [{ storage: "STORED", deletedAt: null, storageKey: src, durationMs: 1000 }], transcripts: [] }]);
  const batchesRoot = path.join(dir, "batches");
  let execCalled = false;
  const execFn: ExecFn = async () => {
    execCalled = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    await runPack({ source: "yiddish24", batch: "t2", maxGb: 0, maxHours: 0, allowCustomerSources: false, dryRun: true, batchesRoot, ffmpegPath: "ffmpeg" }, db, { execFn });
    assert.equal(execCalled, false);
    assert.ok(!existsSync(path.join(batchesRoot, "t2", "manifest.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPack refuses a customer source without --allow-customer-sources and never queries the db", async () => {
  const db = makeFakeSourceDb([]);
  await assert.rejects(
    () => runPack({ source: "voicemail", batch: "t3", maxGb: 0, maxHours: 0, allowCustomerSources: false, dryRun: false, batchesRoot: "/tmp/whatever", ffmpegPath: "ffmpeg" }, db),
    /--allow-customer-sources/,
  );
  assert.equal((db as any)._findManyCallCount(), 0);
});

// ── datasetSlugFor / kernelSlugFor ──────────────────────────────────────────

test("datasetSlugFor / kernelSlugFor name a batch consistently", () => {
  assert.equal(datasetSlugFor("2026-09-17-a"), "loopcom-yc-2026-09-17-a");
  // ⛔ Must match what Kaggle derives from the TITLE ("Loopcom YC label <batch>").
  // A mismatch made the first push land under a different slug and then 409 on
  // every later push — see kernelSlugFor's comment.
  assert.equal(kernelSlugFor("2026-09-17-a"), "loopcom-yc-label-2026-09-17-a");
});

// ── push / run / status / pull confirm gates (mirrors kaggle-run.test.ts) ──

test("pushBatch refuses without --confirm and never calls kaggle", async () => {
  let called = false;
  const execFn: ExecFn = async () => {
    called = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    () => pushBatch({ batchDir: "/tmp/whatever", owner: "izzy", batch: "b1", isNew: true, confirm: false, dryRun: false }, { execFn }),
    /--confirm/,
  );
  assert.equal(called, false);
});

test("pushBatch --dry-run never calls kaggle even with --confirm omitted", async () => {
  let called = false;
  const execFn: ExecFn = async () => {
    called = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  await pushBatch({ batchDir: "/tmp/whatever", owner: "izzy", batch: "b1", isNew: true, confirm: false, dryRun: true }, { execFn });
  assert.equal(called, false);
});

test("pushBatch writes dataset-metadata.json and calls kaggle datasets create when confirmed + new", async () => {
  const dir = tmpDir("push");
  mkdirSync(dir, { recursive: true });
  let calledArgs: string[] | null = null;
  const execFn: ExecFn = async (cmd, args) => {
    calledArgs = [cmd, ...args];
    return { code: 0, stdout: "ok", stderr: "" };
  };
  try {
    await pushBatch({ batchDir: dir, owner: "izzy", batch: "b1", isNew: true, confirm: true, dryRun: false }, { execFn });
    assert.deepEqual(calledArgs, ["kaggle", "datasets", "create", "-p", dir, "--dir-mode", "zip"]);
    const meta = JSON.parse(readFileSync(path.join(dir, "dataset-metadata.json"), "utf8"));
    assert.equal(meta.id, "izzy/loopcom-yc-b1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pushBatch versions an existing dataset when not --new", async () => {
  const dir = tmpDir("push-version");
  mkdirSync(dir, { recursive: true });
  let calledArgs: string[] | null = null;
  const execFn: ExecFn = async (cmd, args) => {
    calledArgs = [cmd, ...args];
    return { code: 0, stdout: "ok", stderr: "" };
  };
  try {
    await pushBatch({ batchDir: dir, owner: "izzy", batch: "b1", isNew: false, confirm: true, dryRun: false }, { execFn });
    assert.equal(calledArgs?.[1], "datasets");
    assert.equal(calledArgs?.[2], "version");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pushBatch refuses when the batch dir does not exist", async () => {
  await assert.rejects(
    () => pushBatch({ batchDir: "/tmp/does-not-exist-batch", owner: "izzy", batch: "b1", isNew: true, confirm: true, dryRun: false }, {}),
    /run pack first/,
  );
});

test("runBatch refuses without --confirm and never calls kaggle", async () => {
  let called = false;
  const execFn: ExecFn = async () => {
    called = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    () => runBatch({ notebookDir: __dirname, owner: "izzy", batch: "b1", confirm: false, dryRun: false }, { execFn }),
    /--confirm/,
  );
  assert.equal(called, false);
});

test("runBatch --dry-run prints the plan and never writes kernel-metadata.json", async () => {
  const dir = tmpDir("run-dry");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "kaggle_label.ipynb"), "{}");
  let called = false;
  const execFn: ExecFn = async () => {
    called = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    await runBatch({ notebookDir: dir, owner: "izzy", batch: "b1", confirm: false, dryRun: true }, { execFn });
    assert.equal(called, false);
    assert.ok(!existsSync(path.join(dir, "kernel-metadata.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runBatch refuses when kaggle_label.ipynb is missing from the notebook dir", async () => {
  const dir = tmpDir("run-missing-nb");
  mkdirSync(dir, { recursive: true });
  try {
    await assert.rejects(
      () => runBatch({ notebookDir: dir, owner: "izzy", batch: "b1", confirm: true, dryRun: false }, {}),
      /kaggle_label\.ipynb/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runBatch writes kernel-metadata.json pointing at the batch's dataset and pushes when confirmed", async () => {
  const dir = tmpDir("run-confirm");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "kaggle_label.ipynb"), "{}");
  let calledArgs: string[] | null = null;
  const execFn: ExecFn = async (cmd, args) => {
    calledArgs = [cmd, ...args];
    return { code: 0, stdout: "kernel started", stderr: "" };
  };
  try {
    await runBatch({ notebookDir: dir, owner: "izzy", batch: "b1", confirm: true, dryRun: false }, { execFn });
    assert.deepEqual(calledArgs, ["kaggle", "kernels", "push", "-p", dir]);
    const meta = JSON.parse(readFileSync(path.join(dir, "kernel-metadata.json"), "utf8"));
    assert.equal(meta.id, "izzy/loopcom-yc-label-b1");
    assert.equal(meta.enable_gpu, true);
    assert.equal(meta.enable_internet, true);
    assert.equal(meta.code_file, "kaggle_label.ipynb");
    assert.deepEqual(meta.dataset_sources, ["izzy/loopcom-yc-b1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runBatch --model stamps the manifest, re-versions the dataset, then pushes the kernel", async () => {
  const notebookDir = tmpDir("run-model-nb");
  const batchDir = tmpDir("run-model-batch");
  mkdirSync(notebookDir, { recursive: true });
  writeFileSync(path.join(notebookDir, "kaggle_label.ipynb"), "{}");
  const entries: BatchManifestEntry[] = [{ itemId: "i1", assetId: "a1", sourceKey: "yiddish24", file: "audio/a1.ogg", durationMs: 1000 }];
  writeManifest(batchDir, entries);
  const calls: string[][] = [];
  const execFn: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: "ok", stderr: "" };
  };
  try {
    await runBatch(
      { notebookDir, batchDir, owner: "izzy", batch: "b1", confirm: true, dryRun: false, model: "ivrit-ai/yi-whisper-large-v3-ct2" },
      { execFn },
    );
    // 1) dataset re-versioned (not "--new") BEFORE 2) the kernel push.
    assert.deepEqual(calls[0], ["kaggle", "datasets", "version", "-p", batchDir, "-m", "stamp model ivrit-ai/yi-whisper-large-v3-ct2", "--dir-mode", "zip"]);
    assert.deepEqual(calls[1], ["kaggle", "kernels", "push", "-p", notebookDir]);
    assert.equal(calls.length, 2);

    const parsed = readManifestFile(batchDir);
    assert.equal(parsed.model, "ivrit-ai/yi-whisper-large-v3-ct2");
    assert.deepEqual(parsed.entries, entries);
  } finally {
    rmSync(notebookDir, { recursive: true, force: true });
    rmSync(batchDir, { recursive: true, force: true });
  }
});

test("runBatch without --model never touches manifest.json (stays the plain array pack wrote)", async () => {
  const notebookDir = tmpDir("run-nomodel-nb");
  const batchDir = tmpDir("run-nomodel-batch");
  mkdirSync(notebookDir, { recursive: true });
  writeFileSync(path.join(notebookDir, "kaggle_label.ipynb"), "{}");
  const entries: BatchManifestEntry[] = [{ itemId: "i1", assetId: "a1", sourceKey: "yiddish24", file: "audio/a1.ogg", durationMs: 1000 }];
  writeManifest(batchDir, entries);
  const calls: string[][] = [];
  const execFn: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: "ok", stderr: "" };
  };
  try {
    await runBatch({ notebookDir, batchDir, owner: "izzy", batch: "b1", confirm: true, dryRun: false }, { execFn });
    assert.equal(calls.length, 1, "no dataset re-version call when --model is omitted");
    assert.deepEqual(calls[0], ["kaggle", "kernels", "push", "-p", notebookDir]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(batchDir, "manifest.json"), "utf8")), entries);
  } finally {
    rmSync(notebookDir, { recursive: true, force: true });
    rmSync(batchDir, { recursive: true, force: true });
  }
});

test("runBatch --model without batchDir refuses clearly", async () => {
  const dir = tmpDir("run-model-no-batchdir");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "kaggle_label.ipynb"), "{}");
  try {
    await assert.rejects(
      () => runBatch({ notebookDir: dir, owner: "izzy", batch: "b1", confirm: true, dryRun: false, model: "some/model" }, {}),
      /requires batchDir/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("statusBatch refuses without --confirm", async () => {
  await assert.rejects(() => statusBatch("izzy", "b1", false, {}), /--confirm/);
});

test("statusBatch calls kaggle kernels status with the batch's kernel slug", async () => {
  const execFn: ExecFn = async (cmd, args) => ({ code: 0, stdout: `${cmd} ${args.join(" ")}`, stderr: "" });
  const out = await statusBatch("izzy", "b1", true, { execFn });
  assert.match(out, /kaggle kernels status izzy\/loopcom-yc-label-b1/);
});

test("pullBatch refuses without --confirm", async () => {
  await assert.rejects(() => pullBatch("izzy", "b1", "/tmp/out", false, {}), /--confirm/);
});

test("pullBatch creates the out dir and calls kaggle kernels output", async () => {
  const dir = tmpDir("pull");
  let calledArgs: string[] | null = null;
  const execFn: ExecFn = async (cmd, args) => {
    calledArgs = [cmd, ...args];
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    await pullBatch("izzy", "b1", dir, true, { execFn });
    assert.deepEqual(calledArgs, ["kaggle", "kernels", "output", "izzy/loopcom-yc-label-b1", "-p", dir]);
    assert.ok(existsSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── import: buildImportRows (confidence math spot check) ────────────────────

/**
 * Copied verbatim from `apps/api/src/yiddishCorpus/jobs.ts`'s
 * `transcriptConfidence` ONLY for this test's own assertion math. The
 * shipped CLI never reimplements this — `resolveEngineFns` always imports
 * the real function (see the "resolveEngineFns" tests below).
 */
function referenceConfidence(avgLogprob: number | null | undefined, noSpeechProb: number | null | undefined): number {
  let c = typeof avgLogprob === "number" && Number.isFinite(avgLogprob) ? Math.exp(avgLogprob) : 0.5;
  c = Math.max(0, Math.min(1, c));
  if (typeof noSpeechProb === "number" && Number.isFinite(noSpeechProb)) c = Math.max(0, c - noSpeechProb * 0.5);
  return Number(c.toFixed(4));
}

test("buildImportRows: exact row shape, ms rounding, and confidence math", () => {
  const entry: BatchManifestEntry = { itemId: "item1", assetId: "asset1", sourceKey: "yiddish24", file: "audio/asset1.ogg", durationMs: 10_000 };
  const result = {
    language: "yi",
    duration: 10,
    segments: [
      { start: 0, end: 4.5, text: "hello world", avg_logprob: -0.2, no_speech_prob: 0.1, words: [{ word: "hello", start: 0, end: 1, probability: 0.9 }] },
      { start: 4.5, end: 10, text: "second segment" },
    ],
  };
  const rows = buildImportRows(entry, result, "batch-x", "yi-whisper-large-v3-turbo-ct2", referenceConfidence);

  assert.equal(rows.length, 2);
  const [r1, r2] = rows;

  assert.equal(r1.itemId, "item1");
  assert.equal(r1.engine, "ivrit");
  assert.equal(r1.sttProvider, "kaggle:yi-whisper-large-v3-turbo-ct2");
  assert.equal(r1.text, "hello world");
  assert.equal(r1.language, "yi");
  assert.equal(r1.startMs, 0);
  assert.equal(r1.endMs, 4500);
  assert.deepEqual(r1.words, [{ word: "hello", start: 0, end: 1, probability: 0.9 }]);
  assert.equal(r1.avgLogprob, -0.2);
  assert.equal(r1.noSpeechProb, 0.1);
  assert.equal(r1.confidence, referenceConfidence(-0.2, 0.1));
  assert.equal(r1.confidence, 0.7687);
  assert.equal(r1.chunkIndex, 0);
  assert.equal(r1.originRef, "asset1#kaggle:batch-x");

  // Segment without avg_logprob/no_speech_prob: null on the raw fields, 0.5 confidence.
  assert.equal(r2.startMs, 4500);
  assert.equal(r2.endMs, 10_000);
  assert.equal(r2.avgLogprob, null);
  assert.equal(r2.noSpeechProb, null);
  assert.equal(r2.confidence, 0.5);
  assert.equal(r2.words, null);
});

test("buildImportRows falls back to language 'yi' when the result carries none", () => {
  const entry: BatchManifestEntry = { itemId: "i", assetId: "a", sourceKey: "yiddish24", file: "audio/a.ogg", durationMs: 1000 };
  const rows = buildImportRows(entry, { segments: [{ start: 0, end: 1, text: "x" }] }, "b", "m", referenceConfidence);
  assert.equal(rows[0].language, "yi");
});

test("originRefFor matches the documented '<assetId>#kaggle:<batch>' shape", () => {
  assert.equal(originRefFor("asset1", "2026-09-17-a"), "asset1#kaggle:2026-09-17-a");
});

// ── importBatch: fake db + fake engine fns ──────────────────────────────────

function makeFakeCorpusDb() {
  const transcripts: any[] = [];
  const items: Record<string, any> = {};
  const jobs: any[] = [{ id: "job-item1-transcribe", itemId: "item1", stage: "transcribe", state: "RUNNING" }];
  let nextId = 1;
  return {
    _state: { transcripts, items, jobs },
    ycTranscript: {
      deleteMany: async ({ where }: any) => {
        const before = transcripts.length;
        for (let i = transcripts.length - 1; i >= 0; i--) {
          const t = transcripts[i];
          if (t.itemId === where.itemId && t.engine === where.engine && t.originRef === where.originRef) transcripts.splice(i, 1);
        }
        return { count: before - transcripts.length };
      },
      // The real client is what importBatch uses to write segments in bulk; a
      // fake that only knows create() would pass while production dies on the
      // pool. Model both.
      createMany: async ({ data }: any) => {
        const list = Array.isArray(data) ? data : [data];
        for (const d of list) transcripts.push({ id: `t${nextId++}`, ...d });
        return { count: list.length };
      },
      create: async ({ data }: any) => {
        const row = { id: `t${nextId++}`, ...data };
        transcripts.push(row);
        return row;
      },
    },
    ycSourceItem: {
      update: async ({ where, data }: any) => {
        items[where.id] = { ...(items[where.id] || {}), ...data };
        return items[where.id];
      },
    },
    ycProcessingJob: {
      findFirst: async ({ where }: any) => jobs.find((j) => j.itemId === where.itemId && j.stage === where.stage) || null,
      update: async ({ where, data }: any) => {
        const j = jobs.find((jj) => jj.id === where.id);
        if (j) Object.assign(j, data);
        return j;
      },
    },
  };
}

function makeImportDeps(db: any) {
  const enqueueCalls: any[] = [];
  const spendCalls: any[] = [];
  const deps: ImportDeps = {
    db,
    enqueueNext: async (_db, item, opts) => {
      enqueueCalls.push({ item, opts });
      return { queued: null, skipped: [], done: true };
    },
    recordTranscribeSpend: async (_db, sourceKey, now, spend) => {
      spendCalls.push({ sourceKey, now, spend });
    },
    transcriptConfidence: referenceConfidence,
  };
  return { deps, enqueueCalls, spendCalls };
}

function sampleManifestAndTranscripts(): { manifest: BatchManifestEntry[]; transcriptsFile: TranscriptsFile } {
  const manifest: BatchManifestEntry[] = [
    { itemId: "item1", assetId: "asset1", sourceKey: "yiddish24", file: "audio/asset1.ogg", durationMs: 60_000 },
    { itemId: "item2", assetId: "asset2", sourceKey: "yiddish24", file: "audio/asset2.ogg", durationMs: 30_000 },
    { itemId: "item3", assetId: "asset3", sourceKey: "yiddish24", file: "audio/asset3.ogg", durationMs: 45_000 },
  ];
  const transcriptsFile: TranscriptsFile = {
    model: "yi-whisper-large-v3-turbo-ct2",
    results: {
      asset1: {
        language: "yi",
        duration: 60,
        segments: [
          { start: 0, end: 5, text: "hello", avg_logprob: -0.2, no_speech_prob: 0.1 },
          { start: 5, end: 10, text: "world", avg_logprob: -0.1, no_speech_prob: 0.05 },
        ],
      },
      asset2: { error: "cuda out of memory" },
      // asset3 deliberately absent from results (kernel died before finishing it)
    },
  };
  return { manifest, transcriptsFile };
}

test("importBatch imports only the clean entry, skips error + missing entries as failures", async () => {
  const db = makeFakeCorpusDb();
  const { deps, enqueueCalls, spendCalls } = makeImportDeps(db);
  const { manifest, transcriptsFile } = sampleManifestAndTranscripts();

  const summary = await importBatch(manifest, transcriptsFile, "batch-1", deps);

  assert.equal(summary.itemsImported, 1);
  assert.equal(summary.segments, 2);
  assert.equal(summary.hours, Number((60_000 / 3_600_000).toFixed(3)));
  assert.equal(summary.failures.length, 2);
  assert.deepEqual(
    summary.failures.map((f) => f.assetId).sort(),
    ["asset2", "asset3"],
  );
  assert.equal(summary.failures.find((f) => f.assetId === "asset2")?.reason, "cuda out of memory");
  assert.match(summary.failures.find((f) => f.assetId === "asset3")?.reason || "", /no result/);

  // item1: rows written, state advanced, job marked DONE, engine handoff called.
  assert.equal((db as any)._state.transcripts.length, 2);
  assert.ok((db as any)._state.transcripts.every((t: any) => t.itemId === "item1" && t.engine === "ivrit"));
  assert.equal((db as any)._state.items.item1?.state, "TRANSCRIBED");
  assert.equal((db as any)._state.jobs[0].state, "DONE");
  assert.equal((db as any)._state.jobs[0].error, null);
  assert.equal((db as any)._state.jobs[0].leaseUntil, null);
  assert.equal((db as any)._state.jobs[0].leaseOwner, null);

  assert.equal(enqueueCalls.length, 1);
  assert.deepEqual(enqueueCalls[0].item, { id: "item1" });
  assert.deepEqual(enqueueCalls[0].opts, { after: "transcribe", sourceKey: "yiddish24" });

  assert.equal(spendCalls.length, 1);
  assert.equal(spendCalls[0].sourceKey, "yiddish24");
  assert.equal(spendCalls[0].spend.transcribedMinutes, 1);
  assert.equal(spendCalls[0].spend.costCents, 0);

  // item2/item3 (error / missing) must be completely untouched.
  assert.equal((db as any)._state.items.item2, undefined);
  assert.equal((db as any)._state.items.item3, undefined);
});

test("importBatch is idempotent: re-running the same batch does not duplicate rows", async () => {
  const db = makeFakeCorpusDb();
  const { deps } = makeImportDeps(db);
  const { manifest, transcriptsFile } = sampleManifestAndTranscripts();

  await importBatch(manifest, transcriptsFile, "batch-1", deps);
  const afterFirst = (db as any)._state.transcripts.length;
  await importBatch(manifest, transcriptsFile, "batch-1", deps);
  const afterSecond = (db as any)._state.transcripts.length;

  assert.equal(afterFirst, 2);
  assert.equal(afterSecond, 2, "a re-run must delete-and-rewrite this batch's rows, never double them");
});

// ── resolveEngineFns: dynamic import against a stub jobs.ts ─────────────────

test("resolveEngineFns loads enqueueNext/recordTranscribeSpend/transcriptConfidence from YC_ENGINE_ROOT/jobs.ts", async () => {
  const dir = tmpDir("engine-root-ok");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "jobs.ts"),
    [
      "export async function enqueueNext(db, item, opts) { return { queued: null, skipped: [], done: true, item, opts }; }",
      "export async function recordTranscribeSpend(db, sourceKey, now, spend) { return; }",
      "export function transcriptConfidence(avgLogprob, noSpeechProb) {",
      "  let c = typeof avgLogprob === 'number' && Number.isFinite(avgLogprob) ? Math.exp(avgLogprob) : 0.5;",
      "  c = Math.max(0, Math.min(1, c));",
      "  if (typeof noSpeechProb === 'number' && Number.isFinite(noSpeechProb)) c = Math.max(0, c - noSpeechProb * 0.5);",
      "  return Number(c.toFixed(4));",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  try {
    const fns = await resolveEngineFns(dir);
    assert.equal(typeof fns.enqueueNext, "function");
    assert.equal(typeof fns.recordTranscribeSpend, "function");
    assert.equal(typeof fns.transcriptConfidence, "function");
    assert.equal(fns.transcriptConfidence(-0.2, 0.1), referenceConfidence(-0.2, 0.1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveEngineFns throws when a required export is missing", async () => {
  const dir = tmpDir("engine-root-missing");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "jobs.ts"), "export async function enqueueNext() { return null; }\n", "utf8");
  try {
    await assert.rejects(() => resolveEngineFns(dir), /recordTranscribeSpend/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── guards ───────────────────────────────────────────────────────────────────

test("guard: this file never reads a Kaggle credential file or embeds a key itself", () => {
  const fs = require("node:fs");
  const src: string = fs.readFileSync(path.join(__dirname, "kaggle-label.ts"), "utf8");
  assert.doesNotMatch(src, /readFileSync\([^)]*(kaggle\.json|access_token)/i);
  assert.doesNotMatch(src, /KAGGLE_KEY|KAGGLE_API_KEY/);
});

test("guard: this file never mentions Yiddish Labs as a label source", () => {
  const fs = require("node:fs");
  const src: string = fs.readFileSync(path.join(__dirname, "kaggle-label.ts"), "utf8");
  assert.doesNotMatch(src, /yiddishlabs/i);
});
