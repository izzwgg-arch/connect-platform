#!/usr/bin/env -S npx tsx
/**
 * Loopcom Yiddish fine-tune — the FREE path, via Kaggle (owner decision
 * 2026-09-17: "use the best free option available"; paid RunPod path is the
 * fallback once Kaggle's free quota is spent — see runpod-pod.ts).
 *
 * Kaggle gives every account ~30 GPU-hours/week free (2x T4 or 1x P100,
 * 12h max per session, `enable_internet: true` to pip-install deps). This
 * script drives the `kaggle` CLI (`pip install kaggle`) to:
 *   1. `dataset-push`  — create/version a PRIVATE Kaggle dataset from a
 *      `build-dataset.ts` output folder (clips/train.jsonl/eval.jsonl/
 *      manifest.json), plus copies of train.py/baseline.py/
 *      requirements-kaggle.txt so the notebook is fully self-contained.
 *      `--flac` re-encodes the WAV clips to FLAC first (lossless, ~half the
 *      size) into a staged copy — the ORIGINAL dataset folder is never
 *      touched.
 *   2. `kernel-push`   — writes `kernel-metadata.json` (enable_gpu: true,
 *      is_private: true, dataset_sources: [the pushed dataset]) next to
 *      `kaggle_train.ipynb` and pushes it, which starts the run.
 *   3. `status`        — polls run status.
 *   4. `download`      — pulls the kernel's output (`out-ct2/`,
 *      `report.json`) back to this machine.
 *
 * ⛔ NO Kaggle API key ever appears in a file this repo owns. Every
 * credential lookup is left to the `kaggle` CLI itself, which reads
 * `~/.kaggle/kaggle.json` (or `KAGGLE_CONFIG_DIR`) on its own. This script
 * only ever shells out to `kaggle ...` — it never opens that file.
 *
 * ⛔ Every subcommand that can reach the network (`dataset-push`,
 * `kernel-push`, `status`, `download`) refuses without `--confirm`.
 * `--dry-run` prints the exact command + metadata that WOULD run, for any
 * of them, with nothing executed.
 */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = __dirname;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<ExecResult>;

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts?.cwd, maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60_000 }, (err: any, stdout, stderr) => {
      resolve({ code: err?.code == null ? 0 : Number(err.code) || 1, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });

export interface KaggleDeps {
  execFn?: ExecFn;
}

async function kaggle(args: string[], deps: KaggleDeps, opts?: { cwd?: string }): Promise<ExecResult> {
  const exec = deps.execFn ?? defaultExec;
  return exec("kaggle", args, opts);
}

// ── dataset-metadata.json / kernel-metadata.json (pure, testable) ──────────

export interface DatasetMetadataInput {
  owner: string;
  slug: string;
  title: string;
}

/** https://github.com/Kaggle/kaggle-api — the shape `kaggle datasets init` writes. */
export function buildDatasetMetadata(input: DatasetMetadataInput): Record<string, unknown> {
  return {
    title: input.title,
    id: `${input.owner}/${input.slug}`,
    licenses: [{ name: "CC0-1.0" }],
  };
}

export interface KernelMetadataInput {
  owner: string;
  kernelSlug: string;
  title: string;
  datasetSlug: string;
  codeFile?: string;
}

/**
 * ⛔ TODO(integrator, verify against the live `kaggle kernels init` template):
 * this mirrors the documented kaggle-api kernel-metadata.json shape as of
 * 2026-09-17 (github.com/Kaggle/kaggle-api, `kaggle kernels init -p .`).
 * The two fields that MUST be right for a free GPU run are `enable_gpu` and
 * `dataset_sources` — everything else degrades gracefully if the schema has
 * drifted (the CLI reports an error rather than silently ignoring a field).
 */
export function buildKernelMetadata(input: KernelMetadataInput): Record<string, unknown> {
  return {
    id: `${input.owner}/${input.kernelSlug}`,
    title: input.title,
    code_file: input.codeFile ?? "kaggle_train.ipynb",
    language: "python",
    kernel_type: "notebook",
    is_private: true,
    enable_gpu: true,
    enable_internet: true,
    dataset_sources: [`${input.owner}/${input.datasetSlug}`],
    competition_sources: [],
    kernel_sources: [],
    model_sources: [],
  };
}

// ── FLAC staging (pure manifest rewrite; ffmpeg calls are the only I/O) ────

export interface DatasetRowLike {
  audio: string;
  [key: string]: unknown;
}

/** Point every row at the .flac sibling of its .wav clip. Pure — no filesystem. */
export function toFlacRows<T extends DatasetRowLike>(rows: T[]): T[] {
  return rows.map((r) => ({ ...r, audio: r.audio.replace(/\.wav$/i, ".flac") }));
}

/** Which clip files need converting, and to what. Pure — the caller runs ffmpeg. */
export function planFlacConversion(clipFiles: string[]): { from: string; to: string }[] {
  return clipFiles.filter((f) => f.toLowerCase().endsWith(".wav")).map((f) => ({ from: f, to: f.replace(/\.wav$/i, ".flac") }));
}

async function convertToFlac(ffmpegPath: string, from: string, to: string, deps: KaggleDeps): Promise<void> {
  const exec = deps.execFn ?? defaultExec;
  const res = await exec(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-i", from, to]);
  if (res.code !== 0) throw new Error(`ffmpeg flac conversion failed for ${from}: ${res.stderr.slice(0, 300)}`);
}

/** Stage a copy of the dataset dir with clips converted to FLAC and the jsonl
 * manifests rewritten to point at them. Never touches the original folder. */
export async function stageFlacDataset(
  datasetDir: string,
  stagedDir: string,
  ffmpegPath: string,
  deps: KaggleDeps = {},
): Promise<{ converted: number }> {
  mkdirSync(path.join(stagedDir, "clips"), { recursive: true });
  const clipFiles = readdirSync(path.join(datasetDir, "clips"));
  const plan = planFlacConversion(clipFiles);
  for (const { from, to } of plan) {
    await convertToFlac(ffmpegPath, path.join(datasetDir, "clips", from), path.join(stagedDir, "clips", to), deps);
  }
  for (const nonWav of clipFiles.filter((f) => !f.toLowerCase().endsWith(".wav"))) {
    copyFileSync(path.join(datasetDir, "clips", nonWav), path.join(stagedDir, "clips", nonWav));
  }
  for (const jsonlName of ["train.jsonl", "eval.jsonl"]) {
    const src = path.join(datasetDir, jsonlName);
    if (!existsSync(src)) continue;
    const rows = readFileSync(src, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const flacRows = toFlacRows(rows);
    writeFileSync(path.join(stagedDir, jsonlName), flacRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
  const manifestSrc = path.join(datasetDir, "manifest.json");
  if (existsSync(manifestSrc)) copyFileSync(manifestSrc, path.join(stagedDir, "manifest.json"));
  return { converted: plan.length };
}

// ── dataset-push ─────────────────────────────────────────────────────────────

export interface DatasetPushOptions {
  datasetDir: string;
  owner: string;
  slug: string;
  title: string;
  flac: boolean;
  isNew: boolean;
  confirm: boolean;
  dryRun: boolean;
  ffmpegPath?: string;
  message?: string;
}

export async function datasetPush(opts: DatasetPushOptions, deps: KaggleDeps = {}): Promise<void> {
  const metadata = buildDatasetMetadata({ owner: opts.owner, slug: opts.slug, title: opts.title });
  if (opts.dryRun) {
    console.log(`[kaggle-run] dry-run dataset-push: would ${opts.isNew ? "create" : "version"} ${metadata.id}`);
    console.log(JSON.stringify(metadata, null, 2));
    if (opts.flac) console.log(`[kaggle-run] dry-run: would convert clips/*.wav -> *.flac into a staged copy first`);
    return;
  }
  if (!opts.confirm) throw new Error("refusing dataset-push without --confirm (this uploads real data to Kaggle)");

  let pushDir = opts.datasetDir;
  const stagedRoot = path.join(opts.datasetDir, "..", `${path.basename(opts.datasetDir)}-kaggle-staged`);
  if (opts.flac) {
    rmSync(stagedRoot, { recursive: true, force: true });
    mkdirSync(stagedRoot, { recursive: true });
    const { converted } = await stageFlacDataset(opts.datasetDir, stagedRoot, opts.ffmpegPath ?? process.env.YC_FFMPEG_PATH ?? "ffmpeg", deps);
    console.log(`[kaggle-run] staged ${converted} clips as FLAC in ${stagedRoot}`);
    pushDir = stagedRoot;
  }

  // Self-contained kernel input: the dataset carries the scripts it needs.
  for (const f of ["train.py", "baseline.py", "requirements-kaggle.txt"]) {
    copyFileSync(path.join(HERE, f), path.join(pushDir, f));
  }
  writeFileSync(path.join(pushDir, "dataset-metadata.json"), JSON.stringify(metadata, null, 2), "utf8");

  const args = opts.isNew
    ? ["datasets", "create", "-p", pushDir, "--dir-mode", "zip"]
    : ["datasets", "version", "-p", pushDir, "-m", opts.message ?? `update ${new Date().toISOString()}`, "--dir-mode", "zip"];
  const res = await kaggle(args, deps);
  if (res.code !== 0) throw new Error(`kaggle ${args[0]} ${args[1]} failed: ${res.stderr.slice(0, 500) || res.stdout.slice(0, 500)}`);
  console.log(`[kaggle-run] pushed dataset ${metadata.id}`);
  console.log(res.stdout.trim());
}

// ── kernel-push / status / download ─────────────────────────────────────────

export interface KernelPushOptions {
  notebookDir: string;
  owner: string;
  kernelSlug: string;
  title: string;
  datasetSlug: string;
  confirm: boolean;
  dryRun: boolean;
}

export async function kernelPush(opts: KernelPushOptions, deps: KaggleDeps = {}): Promise<void> {
  const metadata = buildKernelMetadata({ owner: opts.owner, kernelSlug: opts.kernelSlug, title: opts.title, datasetSlug: opts.datasetSlug });
  if (opts.dryRun) {
    console.log(`[kaggle-run] dry-run kernel-push: would push ${metadata.id}`);
    console.log(JSON.stringify(metadata, null, 2));
    return;
  }
  if (!opts.confirm) throw new Error("refusing kernel-push without --confirm (this starts a real Kaggle GPU session)");
  if (!existsSync(path.join(opts.notebookDir, "kaggle_train.ipynb"))) {
    throw new Error(`${opts.notebookDir} has no kaggle_train.ipynb`);
  }
  writeFileSync(path.join(opts.notebookDir, "kernel-metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
  const res = await kaggle(["kernels", "push", "-p", opts.notebookDir], deps);
  if (res.code !== 0) throw new Error(`kaggle kernels push failed: ${res.stderr.slice(0, 500) || res.stdout.slice(0, 500)}`);
  console.log(`[kaggle-run] pushed + started kernel ${metadata.id}`);
  console.log(res.stdout.trim());
}

export async function kernelStatus(owner: string, kernelSlug: string, confirm: boolean, deps: KaggleDeps = {}): Promise<string> {
  if (!confirm) throw new Error("refusing status without --confirm (this calls the Kaggle API)");
  const res = await kaggle(["kernels", "status", `${owner}/${kernelSlug}`], deps);
  return res.stdout.trim() || res.stderr.trim();
}

export async function kernelDownload(owner: string, kernelSlug: string, outDir: string, confirm: boolean, deps: KaggleDeps = {}): Promise<void> {
  if (!confirm) throw new Error("refusing download without --confirm (this calls the Kaggle API)");
  mkdirSync(outDir, { recursive: true });
  const res = await kaggle(["kernels", "output", `${owner}/${kernelSlug}`, "-p", outDir], deps);
  if (res.code !== 0) throw new Error(`kaggle kernels output failed: ${res.stderr.slice(0, 500) || res.stdout.slice(0, 500)}`);
  console.log(`[kaggle-run] downloaded kernel output to ${outDir}`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function argVal(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function ownerArg(argv: string[]): string {
  const owner = argVal(argv, "--owner") ?? process.env.KAGGLE_USERNAME;
  if (!owner) throw new Error("Kaggle username required: pass --owner or set KAGGLE_USERNAME (this is your public username, never a secret)");
  return owner;
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes("--dry-run");
  const confirm = rest.includes("--confirm");
  switch (sub) {
    case "dataset-push": {
      const datasetDir = argVal(rest, "--dataset");
      if (!datasetDir) throw new Error("--dataset <dir> required");
      await datasetPush(
        {
          datasetDir: path.resolve(datasetDir),
          owner: ownerArg(rest),
          slug: argVal(rest, "--slug") ?? "loopcom-yiddish-whisper-dataset",
          title: argVal(rest, "--title") ?? "Loopcom Yiddish Whisper fine-tune dataset",
          flac: rest.includes("--flac"),
          isNew: rest.includes("--new"),
          confirm,
          dryRun,
          message: argVal(rest, "--message"),
        },
        {},
      );
      return;
    }
    case "kernel-push": {
      await kernelPush(
        {
          notebookDir: HERE,
          owner: ownerArg(rest),
          kernelSlug: argVal(rest, "--kernel-slug") ?? "loopcom-yiddish-whisper-finetune",
          title: argVal(rest, "--title") ?? "Loopcom Yiddish Whisper fine-tune",
          datasetSlug: argVal(rest, "--dataset-slug") ?? "loopcom-yiddish-whisper-dataset",
          confirm,
          dryRun,
        },
        {},
      );
      return;
    }
    case "status": {
      const out = await kernelStatus(ownerArg(rest), argVal(rest, "--kernel-slug") ?? "loopcom-yiddish-whisper-finetune", confirm, {});
      console.log(out);
      return;
    }
    case "download": {
      const outDir = argVal(rest, "--out") ?? path.join(HERE, "kaggle-out");
      await kernelDownload(ownerArg(rest), argVal(rest, "--kernel-slug") ?? "loopcom-yiddish-whisper-finetune", outDir, confirm, {});
      return;
    }
    default:
      console.log("usage: kaggle-run.ts <dataset-push --dataset <dir> [--flac] [--new] [--confirm]|kernel-push [--confirm]|status [--confirm]|download [--confirm]> [--dry-run] [--owner <kaggle-username>]");
  }
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || "").href;
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  main().catch((err) => {
    console.error("[kaggle-run] fatal", err);
    process.exit(1);
  });
}
