#!/usr/bin/env -S npx tsx
/**
 * Loopcom Yiddish learning engine — FREE Kaggle labelling pipeline.
 *
 * Purpose: 661 Yiddish24 episodes (~150h) already sit on this PC at
 * `YcAudioAsset.storageKey` (storage="STORED", deletedAt=null) with no
 * transcript. Instead of spending the local machine's (GPU-less) time or the
 * $5/day paid budget, this drives Kaggle's free 2x T4 GPUs (~30 GPU-hours a
 * week per account) the same way `../yiddish-finetune/kaggle-run.ts` drives
 * them for training: pack -> push -> run -> pull -> import.
 *
 *   pack   — DB READ-ONLY. Selects unlabelled STORED items of one source,
 *            transcodes each to 16kHz mono Opus (~24kbps), writes
 *            batches/<batch>/{audio/*.ogg,manifest.json}.
 *   push   — creates/versions a PRIVATE Kaggle dataset `loopcom-yc-<batch>`
 *            from that folder.
 *   run    — pushes `kaggle_label.ipynb` as a private GPU+internet kernel
 *            `loopcom-label-<batch>` attached to that dataset.
 *   status — polls the kernel.
 *   pull   — downloads the kernel's `transcripts.json` to batches/<batch>/out/.
 *   import — turns `transcripts.json` into `YcTranscript` rows (engine
 *            "ivrit", sttProvider "kaggle:<model>") through the SAME engine
 *            functions the real `transcribe` stage uses
 *            (`enqueueNext`, `recordTranscribeSpend`, `transcriptConfidence`
 *            — imported from YC_ENGINE_ROOT, never reimplemented), advances
 *            the item to TRANSCRIBED, marks its `transcribe` job DONE, and
 *            queues the next stage.
 *
 * ⛔ NO Kaggle API key ever appears in a file this repo owns. Every
 * credential lookup is left to the `kaggle` CLI itself, which reads
 * `~/.kaggle/access_token` (or `KAGGLE_CONFIG_DIR`) on its own. This script
 * only ever shells out to `kaggle ...` — it never opens that file.
 *
 * ⛔ Every subcommand that touches the network (`push`, `run`, `status`,
 * `pull`) refuses without `--confirm`. `pack` and `import` are local/DB work
 * and are not network-gated; `pack --dry-run` computes the selection and
 * stats without transcoding or writing anything.
 *
 * ⛔ `pack` REFUSES any source other than "yiddish24" unless
 * `--allow-customer-sources` is passed. Customer audio (voicemail,
 * call_recordings) needs the owner's explicit, separate approval before it
 * leaves this machine for a third-party GPU host — see README.md.
 *
 * ⛔ Yiddish Labs text is never read, written or referenced anywhere in this
 * file. A guard test asserts that.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildDatasetMetadata, buildKernelMetadata, type ExecFn, type KaggleDeps } from "../yiddish-finetune/kaggle-run";
import { loadEnvFile } from "../yiddish-finetune/build-dataset";

const HERE = __dirname;

const FFMPEG_WINGET_BIN =
  "C:\\Users\\izzyw\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin";

export const YIDDISH24_SOURCE_KEY = "yiddish24";

// ── exec wrapper (same shape as kaggle-run.ts's, reimplemented here because
// that file does not export its private `kaggle()` helper) ─────────────────

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts?.cwd, maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60_000 }, (err: any, stdout, stderr) => {
      resolve({ code: err?.code == null ? 0 : Number(err.code) || 1, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });

async function kaggleExec(args: string[], deps: KaggleDeps): Promise<{ code: number; stdout: string; stderr: string }> {
  const exec = deps.execFn ?? defaultExec;
  return exec("kaggle", args, {});
}

// ── customer-source guard ───────────────────────────────────────────────────

/**
 * `pack` may run against "yiddish24" (the site owner said yes — see the
 * fine-tune handoff §0) without asking anything. Any other source is
 * customer audio and refuses unless the caller explicitly opts in — this is
 * the ONE place that decision is enforced for the Kaggle path.
 */
export function assertSourceAllowed(sourceKey: string, allowCustomerSources: boolean): void {
  if (sourceKey === YIDDISH24_SOURCE_KEY) return;
  if (allowCustomerSources) return;
  throw new Error(
    `pack refuses source "${sourceKey}": only "${YIDDISH24_SOURCE_KEY}" may be packed for Kaggle without ` +
      `--allow-customer-sources. Customer audio (voicemail, call_recordings) needs the owner's explicit, ` +
      `separate approval before it leaves this machine for a third-party GPU host.`,
  );
}

// ── pack: selection + size/duration cap (pure) ──────────────────────────────

export const OGG_BITRATE_KBPS = 24;
/** Small fixed allowance for Ogg/Opus container + page overhead per file. */
export const OGG_CONTAINER_OVERHEAD_BYTES = 4096;

/** Rough encoded size at the fixed ~24kbps mono Opus target. Used only to
 * decide when packing has hit --max-gb — the real number is whatever ffmpeg
 * actually writes. */
export function estimateOggBytes(durationMs: number): number {
  const durationSec = Math.max(0, durationMs) / 1000;
  return Math.round((durationSec * OGG_BITRATE_KBPS * 1000) / 8) + OGG_CONTAINER_OVERHEAD_BYTES;
}

export interface PackCandidate {
  itemId: string;
  assetId: string;
  sourceKey: string;
  /** Absolute path to the ORIGINAL (untranscoded) audio on disk. */
  storageKey: string;
  durationMs: number;
}

export interface PackSelectionResult {
  selected: PackCandidate[];
  totalDurationMs: number;
  totalEstimatedBytes: number;
}

/**
 * Walk candidates in order, stopping (not skipping-and-continuing) the first
 * time adding the next one would exceed either cap. A cap of 0 means
 * unlimited on that axis.
 */
export function selectForPack(candidates: PackCandidate[], opts: { maxGb: number; maxHours: number }): PackSelectionResult {
  const maxBytes = opts.maxGb > 0 ? opts.maxGb * 1024 ** 3 : Infinity;
  const maxMs = opts.maxHours > 0 ? opts.maxHours * 3_600_000 : Infinity;
  const selected: PackCandidate[] = [];
  let totalDurationMs = 0;
  let totalEstimatedBytes = 0;
  for (const c of candidates) {
    const bytes = estimateOggBytes(c.durationMs);
    if (totalDurationMs + c.durationMs > maxMs) break;
    if (totalEstimatedBytes + bytes > maxBytes) break;
    selected.push(c);
    totalDurationMs += c.durationMs;
    totalEstimatedBytes += bytes;
  }
  return { selected, totalDurationMs, totalEstimatedBytes };
}

// ── pack: manifest ───────────────────────────────────────────────────────────

export interface BatchManifestEntry {
  itemId: string;
  assetId: string;
  sourceKey: string;
  /** Path relative to the batch dir, e.g. "audio/<assetId>.ogg". */
  file: string;
  durationMs: number;
}

export function buildManifestJson(entries: BatchManifestEntry[]): string {
  return JSON.stringify(entries, null, 2) + "\n";
}

export function writeManifest(batchDir: string, entries: BatchManifestEntry[]): string {
  mkdirSync(batchDir, { recursive: true });
  const file = path.join(batchDir, "manifest.json");
  writeFileSync(file, buildManifestJson(entries), "utf8");
  return file;
}

export interface PackStats {
  files: number;
  hours: number;
  estimatedGb: number;
  skippedMissingSource: number;
}

export function formatPackStats(entries: BatchManifestEntry[], skippedMissingSource: number): PackStats {
  const totalMs = entries.reduce((s, e) => s + e.durationMs, 0);
  const totalBytes = entries.reduce((s, e) => s + estimateOggBytes(e.durationMs), 0);
  return {
    files: entries.length,
    hours: Number((totalMs / 3_600_000).toFixed(2)),
    estimatedGb: Number((totalBytes / 1024 ** 3).toFixed(3)),
    skippedMissingSource,
  };
}

// ── pack: ffmpeg transcode ───────────────────────────────────────────────────

/** `-ac 1 -ar 16000 -c:a libopus -b:a 24k` into an .ogg container. */
export function buildTranscodeArgs(sourceFile: string, outFile: string): string[] {
  return ["-y", "-hide_banner", "-loglevel", "error", "-i", sourceFile, "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", outFile];
}

export interface TranscodeResult {
  ok: boolean;
  reason?: string;
}

export async function transcodeToOpus(ffmpegPath: string, sourceFile: string, outFile: string, deps: KaggleDeps = {}): Promise<TranscodeResult> {
  const exec = deps.execFn ?? defaultExec;
  const res = await exec(ffmpegPath, buildTranscodeArgs(sourceFile, outFile));
  if (res.code !== 0) return { ok: false, reason: (res.stderr || res.stdout).slice(0, 400) };
  return { ok: true };
}

// ── pack: the impure driver (DB read-only; fs/ffmpeg writes only under
// batches/<batch>/) ─────────────────────────────────────────────────────────

export interface PackCliOptions {
  source: string;
  batch: string;
  maxGb: number;
  maxHours: number;
  allowCustomerSources: boolean;
  dryRun: boolean;
  batchesRoot: string;
  ffmpegPath: string;
}

export async function runPack(opts: PackCliOptions, db: any, deps: KaggleDeps = {}): Promise<void> {
  assertSourceAllowed(opts.source, opts.allowCustomerSources);

  const items: any[] = await db.ycSourceItem.findMany({
    where: {
      source: { key: opts.source },
      assets: { some: { storage: "STORED", deletedAt: null } },
      transcripts: { none: { engine: "ivrit" } },
    },
    include: { assets: { where: { storage: "STORED", deletedAt: null } } },
    orderBy: { discoveredAt: "asc" },
  });

  const candidates: PackCandidate[] = [];
  for (const item of items) {
    const asset = item.assets?.[0];
    if (!asset?.storageKey) continue;
    const durationMs = Number(asset.durationMs) > 0 ? Number(asset.durationMs) : Number(item.durationSec) > 0 ? Number(item.durationSec) * 1000 : 0;
    if (!durationMs) continue;
    candidates.push({ itemId: item.id, assetId: asset.id, sourceKey: opts.source, storageKey: asset.storageKey, durationMs });
  }

  const { selected, totalDurationMs, totalEstimatedBytes } = selectForPack(candidates, { maxGb: opts.maxGb, maxHours: opts.maxHours });
  console.log(
    `[kaggle-label pack] ${items.length} unlabelled+stored item(s) -> ${candidates.length} with usable duration -> ` +
      `${selected.length} selected (${(totalDurationMs / 3_600_000).toFixed(2)}h, ~${(totalEstimatedBytes / 1024 ** 3).toFixed(3)}GB estimated)`,
  );

  if (opts.dryRun) {
    console.log(`[kaggle-label pack] --dry-run: no files transcoded, no manifest written.`);
    return;
  }

  const batchDir = path.join(opts.batchesRoot, opts.batch);
  const audioDir = path.join(batchDir, "audio");
  mkdirSync(audioDir, { recursive: true });

  let missing = 0;
  let ffmpegFailed = 0;
  const manifest: BatchManifestEntry[] = [];
  for (const c of selected) {
    if (!existsSync(c.storageKey)) {
      missing += 1;
      continue;
    }
    const outFile = path.join(audioDir, `${c.assetId}.ogg`);
    const res = await transcodeToOpus(opts.ffmpegPath, c.storageKey, outFile, deps);
    if (!res.ok) {
      ffmpegFailed += 1;
      console.error(`[kaggle-label pack] ffmpeg failed for asset ${c.assetId}: ${res.reason}`);
      continue;
    }
    manifest.push({ itemId: c.itemId, assetId: c.assetId, sourceKey: c.sourceKey, file: `audio/${c.assetId}.ogg`, durationMs: c.durationMs });
  }

  writeManifest(batchDir, manifest);
  const stats = formatPackStats(manifest, missing);
  console.log(
    `[kaggle-label pack] wrote ${batchDir} — files=${stats.files} hours=${stats.hours} estGb=${stats.estimatedGb} ` +
      `missingSource=${missing} ffmpegFailed=${ffmpegFailed}`,
  );
}

// ── push (dataset), run (kernel), status, pull ──────────────────────────────

export function datasetSlugFor(batch: string): string {
  return `loopcom-yc-${batch}`;
}

export function kernelSlugFor(batch: string): string {
  // ⛔ Kaggle derives a kernel's slug from its TITLE and refuses (409 Conflict)
  // when that does not match the id in kernel-metadata.json. The title is
  // `Loopcom YC label <batch>`, which resolves to loopcom-yc-label-<batch>, so
  // the slug must say the same thing — otherwise the FIRST push warns and
  // silently lands elsewhere, and every later push 409s against it.
  return `loopcom-yc-label-${batch}`;
}

export interface PushOptions {
  batchDir: string;
  owner: string;
  batch: string;
  isNew: boolean;
  confirm: boolean;
  dryRun: boolean;
  message?: string;
}

export async function pushBatch(opts: PushOptions, deps: KaggleDeps = {}): Promise<void> {
  const metadata = buildDatasetMetadata({ owner: opts.owner, slug: datasetSlugFor(opts.batch), title: `Loopcom YC label batch ${opts.batch}` });
  // The shared builder tags CC0-1.0, which is a PUBLIC-DOMAIN DEDICATION. A label
  // batch is somebody else's copyrighted audio (Yiddish24 gave permission to
  // ANALYSE, never to license or redistribute), so claiming CC0 on it would be a
  // false statement about a third party's work. The dataset is private either way
  // (`datasets create` is private unless --public), but the declared licence must
  // still be honest.
  metadata.licenses = [{ name: "other" }];
  if (opts.dryRun) {
    console.log(`[kaggle-label] dry-run push: would ${opts.isNew ? "create" : "version"} ${metadata.id} from ${opts.batchDir}`);
    console.log(JSON.stringify(metadata, null, 2));
    return;
  }
  if (!opts.confirm) throw new Error("refusing push without --confirm (this uploads real audio to a private Kaggle dataset)");
  if (!existsSync(opts.batchDir)) throw new Error(`batch dir not found: ${opts.batchDir} — run pack first`);

  writeFileSync(path.join(opts.batchDir, "dataset-metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
  const args = opts.isNew
    ? ["datasets", "create", "-p", opts.batchDir, "--dir-mode", "zip"]
    : ["datasets", "version", "-p", opts.batchDir, "-m", opts.message ?? `update ${new Date().toISOString()}`, "--dir-mode", "zip"];
  const res = await kaggleExec(args, deps);
  if (res.code !== 0) throw new Error(`kaggle ${args[0]} ${args[1]} failed: ${res.stderr.slice(0, 500) || res.stdout.slice(0, 500)}`);
  console.log(`[kaggle-label] pushed dataset ${metadata.id}`);
  console.log(res.stdout.trim());
}

export interface RunOptions {
  notebookDir: string;
  owner: string;
  batch: string;
  confirm: boolean;
  dryRun: boolean;
}

export async function runBatch(opts: RunOptions, deps: KaggleDeps = {}): Promise<void> {
  const metadata = buildKernelMetadata({
    owner: opts.owner,
    kernelSlug: kernelSlugFor(opts.batch),
    title: `Loopcom YC label ${opts.batch}`,
    datasetSlug: datasetSlugFor(opts.batch),
    codeFile: "kaggle_label.ipynb",
  });
  if (opts.dryRun) {
    console.log(`[kaggle-label] dry-run run: would push ${metadata.id}`);
    console.log(JSON.stringify(metadata, null, 2));
    return;
  }
  if (!opts.confirm) throw new Error("refusing run without --confirm (this starts a real Kaggle GPU session)");
  if (!existsSync(path.join(opts.notebookDir, "kaggle_label.ipynb"))) {
    throw new Error(`${opts.notebookDir} has no kaggle_label.ipynb`);
  }
  writeFileSync(path.join(opts.notebookDir, "kernel-metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
  const res = await kaggleExec(["kernels", "push", "-p", opts.notebookDir], deps);
  if (res.code !== 0) throw new Error(`kaggle kernels push failed: ${res.stderr.slice(0, 500) || res.stdout.slice(0, 500)}`);
  console.log(`[kaggle-label] pushed + started kernel ${metadata.id}`);
  console.log(res.stdout.trim());
}

export async function statusBatch(owner: string, batch: string, confirm: boolean, deps: KaggleDeps = {}): Promise<string> {
  if (!confirm) throw new Error("refusing status without --confirm (this calls the Kaggle API)");
  const res = await kaggleExec(["kernels", "status", `${owner}/${kernelSlugFor(batch)}`], deps);
  return res.stdout.trim() || res.stderr.trim();
}

export async function pullBatch(owner: string, batch: string, outDir: string, confirm: boolean, deps: KaggleDeps = {}): Promise<void> {
  if (!confirm) throw new Error("refusing pull without --confirm (this calls the Kaggle API)");
  mkdirSync(outDir, { recursive: true });
  const res = await kaggleExec(["kernels", "output", `${owner}/${kernelSlugFor(batch)}`, "-p", outDir], deps);
  if (res.code !== 0) throw new Error(`kaggle kernels output failed: ${res.stderr.slice(0, 500) || res.stdout.slice(0, 500)}`);
  console.log(`[kaggle-label] downloaded kernel output to ${outDir}`);
}

// ── import: transcripts.json -> YcTranscript rows ───────────────────────────

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob?: number | null;
  no_speech_prob?: number | null;
  words?: unknown;
}

export interface TranscriptResultEntry {
  language?: string;
  duration?: number;
  segments?: TranscriptSegment[];
  error?: string;
}

export interface TranscriptsFile {
  model?: string;
  results: Record<string, TranscriptResultEntry>;
}

export function originRefFor(assetId: string, batch: string): string {
  return `${assetId}#kaggle:${batch}`;
}

export interface ImportRow {
  itemId: string;
  engine: "ivrit";
  sttProvider: string;
  text: string;
  language: string;
  startMs: number;
  endMs: number;
  words: unknown;
  avgLogprob: number | null;
  noSpeechProb: number | null;
  confidence: number;
  chunkIndex: number;
  originRef: string;
}

/**
 * Pure: one manifest entry + its Kaggle result -> the YcTranscript rows to
 * create. `confidenceFn` is always the REAL `transcriptConfidence` from
 * `jobs.ts` (see `resolveEngineFns`) — never reimplemented here, so this
 * pipeline's confidence can never drift from the platform's own formula.
 */
export function buildImportRows(
  entry: BatchManifestEntry,
  result: TranscriptResultEntry,
  batch: string,
  model: string,
  confidenceFn: (avgLogprob: number | null | undefined, noSpeechProb: number | null | undefined) => number,
): ImportRow[] {
  const originRef = originRefFor(entry.assetId, batch);
  const sttProvider = `kaggle:${model}`;
  const language = result.language || "yi";
  const segments = result.segments || [];
  return segments.map((seg) => ({
    itemId: entry.itemId,
    engine: "ivrit" as const,
    sttProvider,
    text: seg.text ?? "",
    language,
    startMs: Math.round((Number(seg.start) || 0) * 1000),
    endMs: Math.round((Number(seg.end) || 0) * 1000),
    words: seg.words ?? null,
    avgLogprob: typeof seg.avg_logprob === "number" ? seg.avg_logprob : null,
    noSpeechProb: typeof seg.no_speech_prob === "number" ? seg.no_speech_prob : null,
    confidence: confidenceFn(seg.avg_logprob, seg.no_speech_prob),
    chunkIndex: 0,
    originRef,
  }));
}

export interface ImportDeps {
  db: any;
  enqueueNext: (db: any, item: any, opts: { after?: string | null; now?: Date; sourceKey?: string }) => Promise<unknown>;
  recordTranscribeSpend: (db: any, sourceKey: string, now: Date, spend: { transcribedMinutes?: number; costCents?: number }) => Promise<void>;
  transcriptConfidence: (avgLogprob: number | null | undefined, noSpeechProb: number | null | undefined) => number;
}

export interface ImportFailure {
  assetId: string;
  itemId: string;
  reason: string;
}

export interface ImportSummary {
  itemsImported: number;
  segments: number;
  hours: number;
  failures: ImportFailure[];
}

/**
 * For each manifest entry with a clean result: delete-then-recreate its
 * `ivrit` rows for THIS batch's originRef (idempotent re-run), advance the
 * item to TRANSCRIBED, mark its `transcribe` job DONE, and hand off to
 * `enqueueNext`/`recordTranscribeSpend` exactly as the real `transcribe`
 * stage does. Entries with an error (or no result at all) are left
 * completely untouched and reported as failures.
 */
export async function importBatch(
  manifest: BatchManifestEntry[],
  transcriptsFile: TranscriptsFile,
  batch: string,
  deps: ImportDeps,
): Promise<ImportSummary> {
  const db = deps.db;
  const model = transcriptsFile.model || "unknown";
  let itemsImported = 0;
  let segments = 0;
  let hoursMs = 0;
  const failures: ImportFailure[] = [];

  for (const entry of manifest) {
    const result = transcriptsFile.results?.[entry.assetId];
    if (!result) {
      failures.push({ assetId: entry.assetId, itemId: entry.itemId, reason: "no result for this asset in transcripts.json" });
      console.error(`[kaggle-label import] ${entry.assetId} (item ${entry.itemId}): no result in transcripts.json`);
      continue;
    }
    if (result.error) {
      failures.push({ assetId: entry.assetId, itemId: entry.itemId, reason: result.error });
      console.error(`[kaggle-label import] ${entry.assetId} (item ${entry.itemId}): ${result.error}`);
      continue;
    }

    const originRef = originRefFor(entry.assetId, batch);
    await db.ycTranscript.deleteMany({ where: { itemId: entry.itemId, engine: "ivrit", originRef } }).catch(() => {});

    const rows = buildImportRows(entry, result, batch, model, deps.transcriptConfidence);
    for (const row of rows) {
      await db.ycTranscript.create({ data: row });
      segments += 1;
    }
    hoursMs += entry.durationMs;

    await db.ycSourceItem.update({ where: { id: entry.itemId }, data: { state: "TRANSCRIBED" } }).catch(() => {});

    const job = await db.ycProcessingJob.findFirst({ where: { itemId: entry.itemId, stage: "transcribe" } }).catch(() => null);
    if (job) {
      await db.ycProcessingJob
        .update({ where: { id: job.id }, data: { state: "DONE", error: null, leaseUntil: null, leaseOwner: null } })
        .catch(() => {});
    }

    await deps.enqueueNext(db, { id: entry.itemId }, { after: "transcribe", sourceKey: entry.sourceKey });
    await deps.recordTranscribeSpend(db, entry.sourceKey, new Date(), { transcribedMinutes: entry.durationMs / 60_000, costCents: 0 });

    itemsImported += 1;
  }

  return { itemsImported, segments, hours: Number((hoursMs / 3_600_000).toFixed(3)), failures };
}

/**
 * Import never reimplements the engine's own `transcriptConfidence` /
 * `enqueueNext` / `recordTranscribeSpend` — it imports them from
 * `YC_ENGINE_ROOT/jobs.ts` (default the real `apps/api/src/yiddishCorpus`,
 * overridable so tests can point it at a stub), exactly the pattern
 * `build-dataset.ts`'s `resolveEligibilityFn` uses for `governance.ts`.
 */
export async function resolveEngineFns(engineRoot: string): Promise<Pick<ImportDeps, "enqueueNext" | "recordTranscribeSpend" | "transcriptConfidence">> {
  const modPath = path.join(engineRoot, "jobs.ts");
  const modUrl = pathToFileURL(modPath).href;
  const mod: any = await import(modUrl);
  for (const name of ["enqueueNext", "recordTranscribeSpend", "transcriptConfidence"]) {
    if (typeof mod[name] !== "function") throw new Error(`engine module at ${modPath} has no ${name} export`);
  }
  return { enqueueNext: mod.enqueueNext, recordTranscribeSpend: mod.recordTranscribeSpend, transcriptConfidence: mod.transcriptConfidence };
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

function batchArg(argv: string[]): string {
  const batch = argVal(argv, "--batch");
  if (!batch) throw new Error("--batch <id> required");
  return batch;
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes("--dry-run");
  const confirm = rest.includes("--confirm");
  const batchesRoot = path.join(HERE, "batches");

  switch (sub) {
    case "pack": {
      const source = argVal(rest, "--source");
      if (!source) throw new Error("--source <key> required");
      const batch = batchArg(rest);
      loadEnvFile(path.join(HERE, "..", "yiddish-runner", ".env"));
      const ffmpegPath = process.env.YC_FFMPEG_PATH || path.join(FFMPEG_WINGET_BIN, "ffmpeg.exe");
      const { PrismaClient } = await import("@prisma/client");
      const db: any = new PrismaClient();
      try {
        await runPack({
          source,
          batch,
          maxGb: Number(argVal(rest, "--max-gb") ?? 15),
          maxHours: Number(argVal(rest, "--max-hours") ?? 0),
          allowCustomerSources: rest.includes("--allow-customer-sources"),
          dryRun,
          batchesRoot,
          ffmpegPath,
        }, db);
      } finally {
        await db.$disconnect();
      }
      return;
    }
    case "push": {
      const batch = batchArg(rest);
      await pushBatch({
        batchDir: path.join(batchesRoot, batch),
        owner: ownerArg(rest),
        batch,
        isNew: rest.includes("--new"),
        confirm,
        dryRun,
        message: argVal(rest, "--message"),
      });
      return;
    }
    case "run": {
      const batch = batchArg(rest);
      await runBatch({ notebookDir: HERE, owner: ownerArg(rest), batch, confirm, dryRun });
      return;
    }
    case "status": {
      const out = await statusBatch(ownerArg(rest), batchArg(rest), confirm);
      console.log(out);
      return;
    }
    case "pull": {
      const batch = batchArg(rest);
      const outDir = argVal(rest, "--out") ?? path.join(batchesRoot, batch, "out");
      await pullBatch(ownerArg(rest), batch, outDir, confirm);
      return;
    }
    case "import": {
      const batch = batchArg(rest);
      const batchDir = path.join(batchesRoot, batch);
      const manifest: BatchManifestEntry[] = JSON.parse(readFileSync(path.join(batchDir, "manifest.json"), "utf8"));
      const transcriptsFile: TranscriptsFile = JSON.parse(readFileSync(path.join(batchDir, "out", "transcripts.json"), "utf8"));
      const engineRootArg = argVal(rest, "--engine-root");
      const engineRoot = engineRootArg ? path.resolve(engineRootArg) : process.env.YC_ENGINE_ROOT || path.resolve(HERE, "../../apps/api/src/yiddishCorpus");
      const engineFns = await resolveEngineFns(engineRoot);
      const { PrismaClient } = await import("@prisma/client");
      const db: any = new PrismaClient();
      try {
        const summary = await importBatch(manifest, transcriptsFile, batch, { db, ...engineFns });
        console.log(
          `[kaggle-label import] items=${summary.itemsImported} segments=${summary.segments} hours=${summary.hours} failures=${summary.failures.length}`,
        );
        if (summary.failures.length) console.log(JSON.stringify(summary.failures, null, 2));
      } finally {
        await db.$disconnect();
      }
      return;
    }
    default:
      console.log(
        "usage: kaggle-label.ts <" +
          "pack --source <key> --batch <id> [--max-gb 15] [--max-hours N] [--allow-customer-sources]|" +
          "push --batch <id> --confirm [--new] [--owner <kaggle-username>]|" +
          "run --batch <id> --confirm [--owner <kaggle-username>]|" +
          "status --batch <id> --confirm [--owner <kaggle-username>]|" +
          "pull --batch <id> --confirm [--out <dir>] [--owner <kaggle-username>]|" +
          "import --batch <id> [--engine-root <dir>]" +
          "> [--dry-run]",
      );
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
    console.error("[kaggle-label] fatal", err);
    process.exit(1);
  });
}
