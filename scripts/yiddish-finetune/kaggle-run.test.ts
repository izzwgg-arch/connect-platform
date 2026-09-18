/**
 * kaggle-run.ts — metadata shape, FLAC manifest rewrite, and confirm-gate
 * tests. Every test injects `execFn`; NONE touch the real `kaggle` CLI,
 * ffmpeg, or the network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  buildDatasetMetadata,
  buildKernelMetadata,
  datasetPush,
  DEFAULT_KERNEL_SLUG,
  DEFAULT_KERNEL_TITLE,
  kernelDownload,
  kernelPush,
  kernelStatus,
  planFlacConversion,
  stageFlacDataset,
  titleToKaggleSlug,
  toFlacRows,
  type ExecFn,
} from "./kaggle-run";

// ── metadata shapes ──────────────────────────────────────────────────────────

test("buildDatasetMetadata produces the owner/slug id and an honest 'other' license (2026-09-18: never CC0 — this data is someone else's copyrighted audio, never public domain)", () => {
  const meta = buildDatasetMetadata({ owner: "izzyloopcom", slug: "yiddish-whisper-dataset", title: "Yiddish Whisper dataset" });
  assert.equal(meta.id, "izzyloopcom/yiddish-whisper-dataset");
  assert.equal(meta.title, "Yiddish Whisper dataset");
  assert.deepEqual(meta.licenses, [{ name: "other" }]);
});

test("buildKernelMetadata enables GPU and internet, and points at the right dataset", () => {
  const meta = buildKernelMetadata({
    owner: "izzyloopcom",
    kernelSlug: "yiddish-whisper-finetune",
    title: "Yiddish Whisper finetune",
    datasetSlug: "yiddish-whisper-dataset",
  });
  assert.equal(meta.id, "izzyloopcom/yiddish-whisper-finetune");
  assert.equal(meta.enable_gpu, true);
  assert.equal(meta.enable_internet, true);
  assert.equal(meta.is_private, true);
  assert.deepEqual(meta.dataset_sources, ["izzyloopcom/yiddish-whisper-dataset"]);
  assert.equal(meta.code_file, "kaggle_train.ipynb");
  assert.equal(meta.kernel_type, "notebook");
});

test("buildKernelMetadata honours a custom code_file", () => {
  const meta = buildKernelMetadata({ owner: "o", kernelSlug: "k", title: "k", datasetSlug: "d", codeFile: "other.ipynb" });
  assert.equal(meta.code_file, "other.ipynb");
});

// ── slug/title agreement (2026-09-18 fix) ───────────────────────────────────

test("titleToKaggleSlug mirrors Kaggle's real slugification: lowercase, non-alnum runs collapsed to one hyphen, trimmed", () => {
  assert.equal(titleToKaggleSlug("Loopcom Yiddish Whisper finetune"), "loopcom-yiddish-whisper-finetune");
  assert.equal(titleToKaggleSlug("Loopcom Yiddish Whisper fine-tune"), "loopcom-yiddish-whisper-fine-tune");
  assert.equal(titleToKaggleSlug("Loopcom YC label 2026-09-17-a"), "loopcom-yc-label-2026-09-17-a");
  assert.equal(titleToKaggleSlug("  Weird!!  Title__ "), "weird-title");
});

test("this script's own kernel-push/status/download default title and slug agree (the exact 2026-09-18 bug: they used to be off by one hyphen)", () => {
  assert.equal(titleToKaggleSlug(DEFAULT_KERNEL_TITLE), DEFAULT_KERNEL_SLUG);
});

test("buildKernelMetadata throws BEFORE any network call when kernelSlug does not match what Kaggle will derive from title", () => {
  assert.throws(
    () => buildKernelMetadata({ owner: "o", kernelSlug: "loopcom-yiddish-whisper-finetune", title: "Loopcom Yiddish Whisper fine-tune", datasetSlug: "d" }),
    /slugifies to "loopcom-yiddish-whisper-fine-tune".*does not match kernelSlug "loopcom-yiddish-whisper-finetune"/s,
  );
});

test("buildKernelMetadata succeeds when kernelSlug and title agree", () => {
  const meta = buildKernelMetadata({ owner: "o", kernelSlug: "loopcom-yiddish-whisper-finetune", title: "Loopcom Yiddish Whisper finetune", datasetSlug: "d" });
  assert.equal(meta.id, "o/loopcom-yiddish-whisper-finetune");
});

// ── FLAC staging (pure parts) ────────────────────────────────────────────────

test("planFlacConversion only targets .wav files, case-insensitively", () => {
  const plan = planFlacConversion(["a.wav", "b.WAV", "c.flac", "notes.txt"]);
  assert.deepEqual(plan, [
    { from: "a.wav", to: "a.flac" },
    { from: "b.WAV", to: "b.flac" },
  ]);
});

test("toFlacRows rewrites the audio field and preserves everything else", () => {
  const rows = [{ audio: "clips/x.wav", text: "hello", gold: false }];
  const out = toFlacRows(rows);
  assert.equal(out[0].audio, "clips/x.flac");
  assert.equal(out[0].text, "hello");
  assert.equal(out[0].gold, false);
});

test("toFlacRows never mutates the input array", () => {
  const rows = [{ audio: "clips/x.wav" }];
  const out = toFlacRows(rows);
  assert.equal(rows[0].audio, "clips/x.wav");
  assert.notEqual(out[0], rows[0]);
});

// ── stageFlacDataset (real fs, fake ffmpeg exec) ────────────────────────────

test("stageFlacDataset converts every wav via the injected exec and rewrites both jsonl files", async () => {
  const tmp = path.join(os.tmpdir(), `yc-kaggle-stage-${Date.now()}`);
  const srcDir = path.join(tmp, "src");
  const outDir = path.join(tmp, "out");
  mkdirSync(path.join(srcDir, "clips"), { recursive: true });
  writeFileSync(path.join(srcDir, "clips", "a.wav"), "fake-wav-bytes");
  writeFileSync(path.join(srcDir, "clips", "b.wav"), "fake-wav-bytes-2");
  writeFileSync(path.join(srcDir, "train.jsonl"), JSON.stringify({ audio: "clips/a.wav", text: "hi", gold: false }) + "\n");
  writeFileSync(path.join(srcDir, "eval.jsonl"), JSON.stringify({ audio: "clips/b.wav", text: "bye", gold: true }) + "\n");
  writeFileSync(path.join(srcDir, "manifest.json"), JSON.stringify({ version: "v1" }));

  const calls: string[][] = [];
  const execFn: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    // Simulate ffmpeg by writing a placeholder flac file at the -o (last) arg.
    writeFileSync(args[args.length - 1], "fake-flac-bytes");
    return { code: 0, stdout: "", stderr: "" };
  };

  try {
    const { converted } = await stageFlacDataset(srcDir, outDir, "ffmpeg", { execFn });
    assert.equal(converted, 2);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c[0] === "ffmpeg"));
    assert.ok(existsSync(path.join(outDir, "clips", "a.flac")));
    assert.ok(existsSync(path.join(outDir, "clips", "b.flac")));
    assert.ok(!existsSync(path.join(outDir, "clips", "a.wav")), "staged dir should hold only the flac output");

    const train = JSON.parse(readFileSync(path.join(outDir, "train.jsonl"), "utf8").trim());
    assert.equal(train.audio, "clips/a.flac");
    const evalRow = JSON.parse(readFileSync(path.join(outDir, "eval.jsonl"), "utf8").trim());
    assert.equal(evalRow.audio, "clips/b.flac");
    assert.ok(existsSync(path.join(outDir, "manifest.json")));

    // The ORIGINAL dataset must be untouched.
    assert.ok(existsSync(path.join(srcDir, "clips", "a.wav")));
    const originalTrain = JSON.parse(readFileSync(path.join(srcDir, "train.jsonl"), "utf8").trim());
    assert.equal(originalTrain.audio, "clips/a.wav");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── the --confirm gate (every network-touching call) ────────────────────────

test("datasetPush refuses without --confirm and never calls kaggle", async () => {
  let called = false;
  const execFn: ExecFn = async () => {
    called = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    () =>
      datasetPush(
        { datasetDir: "/tmp/whatever", owner: "izzy", slug: "s", title: "t", flac: false, isNew: true, confirm: false, dryRun: false },
        { execFn },
      ),
    /--confirm/,
  );
  assert.equal(called, false);
});

test("datasetPush --dry-run prints the plan and never calls kaggle, even with --confirm omitted", async () => {
  let called = false;
  const execFn: ExecFn = async () => {
    called = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  await datasetPush(
    { datasetDir: "/tmp/whatever", owner: "izzy", slug: "s", title: "t", flac: false, isNew: true, confirm: false, dryRun: true },
    { execFn },
  );
  assert.equal(called, false);
});

test("kernelPush refuses without --confirm and never calls kaggle", async () => {
  let called = false;
  const execFn: ExecFn = async () => {
    called = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    () =>
      kernelPush(
        { notebookDir: __dirname, owner: "izzy", kernelSlug: "k", title: "k", datasetSlug: "d", confirm: false, dryRun: false },
        { execFn },
      ),
    /--confirm/,
  );
  assert.equal(called, false);
});

test("kernelPush --dry-run never writes kernel-metadata.json or calls kaggle", async () => {
  const tmp = path.join(os.tmpdir(), `yc-kaggle-kernel-dry-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  writeFileSync(path.join(tmp, "kaggle_train.ipynb"), "{}");
  let called = false;
  const execFn: ExecFn = async () => {
    called = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    await kernelPush({ notebookDir: tmp, owner: "izzy", kernelSlug: "k", title: "k", datasetSlug: "d", confirm: false, dryRun: true }, { execFn });
    assert.equal(called, false);
    assert.ok(!existsSync(path.join(tmp, "kernel-metadata.json")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("kernelPush writes the real kernel-metadata.json and calls kaggle kernels push when confirmed", async () => {
  const tmp = path.join(os.tmpdir(), `yc-kaggle-kernel-push-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  writeFileSync(path.join(tmp, "kaggle_train.ipynb"), "{}");
  let calledArgs: string[] | null = null;
  const execFn: ExecFn = async (cmd, args) => {
    calledArgs = [cmd, ...args];
    return { code: 0, stdout: "ok", stderr: "" };
  };
  try {
    await kernelPush({ notebookDir: tmp, owner: "izzy", kernelSlug: "k", title: "k", datasetSlug: "d", confirm: true, dryRun: false }, { execFn });
    assert.deepEqual(calledArgs, ["kaggle", "kernels", "push", "-p", tmp]);
    const written = JSON.parse(readFileSync(path.join(tmp, "kernel-metadata.json"), "utf8"));
    assert.equal(written.enable_gpu, true);
    assert.deepEqual(written.dataset_sources, ["izzy/d"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("kernelStatus refuses without --confirm", async () => {
  let called = false;
  const execFn: ExecFn = async () => {
    called = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(() => kernelStatus("izzy", "k", false, { execFn }), /--confirm/);
  assert.equal(called, false);
});

test("kernelStatus calls kaggle kernels status when confirmed", async () => {
  const execFn: ExecFn = async (cmd, args) => ({ code: 0, stdout: `${cmd} ${args.join(" ")} -> running`, stderr: "" });
  const out = await kernelStatus("izzy", "k", true, { execFn });
  assert.match(out, /kaggle kernels status izzy\/k/);
});

test("kernelDownload refuses without --confirm", async () => {
  let called = false;
  const execFn: ExecFn = async () => {
    called = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(() => kernelDownload("izzy", "k", "/tmp/out", false, { execFn }), /--confirm/);
  assert.equal(called, false);
});

// ── guard: no Kaggle API key is ever read or embedded here ──────────────────

test("guard: this file never reads kaggle.json or an API key itself (only the kaggle CLI touches credentials)", () => {
  const fs = require("node:fs");
  const src: string = fs.readFileSync(path.join(__dirname, "kaggle-run.ts"), "utf8");
  // Mentioning kaggle.json in a comment (to explain that the CLI reads it) is
  // fine and expected; actually opening it here would not be.
  assert.doesNotMatch(src, /readFileSync\([^)]*kaggle\.json/i);
  assert.doesNotMatch(src, /KAGGLE_KEY|KAGGLE_API_KEY/);
});
