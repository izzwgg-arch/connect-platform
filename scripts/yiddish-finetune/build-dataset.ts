#!/usr/bin/env -S npx tsx
/**
 * Loopcom Yiddish fine-tune — dataset builder (Lane B, §3.2.1 of
 * AGENT_HANDOFF_YIDDISH_WHISPER_FINETUNE_2026-09-17.md).
 *
 * Runs on Izzy's PC. Reads `YcTranscript` rows the engine already produced
 * (`transcribe`/`align`, Lane A), applies the SAME governance ladder the
 * platform's export screen uses (`trainingEligibilityOf` — imported, never
 * re-implemented, so this file cannot drift from the real rule), cuts short
 * audio clips with ffmpeg, and writes a Whisper-fine-tune-ready
 * `train.jsonl` / `eval.jsonl` + a hashed `manifest.json`.
 *
 * ⛔ Yiddish Labs text is NEVER read here. Rows come from `YcTranscript` with
 * `engine="ivrit"` (machine) or `engine="human"` (gold, corrected by a
 * person) ONLY. A guard test asserts this file has no YL marker string.
 *
 * ⛔ Governance is not re-implemented here. `trainingEligibilityOf` is
 * imported from the real engine module (path configurable via
 * `YC_ENGINE_ROOT`, default `../../apps/api/src/yiddishCorpus` — the same
 * relative path the PC runner's `code/` snapshot mirrors) and its ALLOWED /
 * RESTRICTED / EXCLUDED verdict is the only thing that decides whether a row
 * may leave in this dataset. Everything else in this file (confidence,
 * length, duration, merging, splitting) is a QUALITY filter layered on top —
 * never a substitute for the governance verdict.
 *
 * Every pure decision (row filtering, merging, train/eval split, stats,
 * manifest hashing) is a plain exported function so it can be unit-tested
 * with fake rows and a fake eligibility function — no DB, no ffmpeg, no
 * network needed to prove the logic. Only `main()` touches Prisma/ffmpeg/fs.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Type-only: erased at runtime by tsx/esbuild, so this static path never has
// to resolve on disk when the real import is redirected via YC_ENGINE_ROOT.
import type { YcRightsLike, YcRowProvenance, YcSourceLike, YcTrainingVerdict } from "../../apps/api/src/yiddishCorpus/governance";

const HERE = __dirname;

// ── env: same manual .env parser the PC runner uses, never overwriting a
// variable that is already set in the real environment. ─────────────────────
export function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const FFMPEG_WINGET_BIN =
  "C:\\Users\\izzyw\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin";

// ── shapes ───────────────────────────────────────────────────────────────────

/** One `YcTranscript` row, joined with just enough item/source context to
 * decide governance and to locate the audio it came from. */
export interface RawRow {
  id: string;
  itemId: string;
  segmentId: string | null;
  /** "ivrit" (machine) or "human" (gold). Anything else is dropped upstream. */
  engine: string;
  sttProvider: string | null;
  text: string;
  confidence: number | null;
  noSpeechProb: number | null;
  startMs: number | null;
  endMs: number | null;
  chunkIndex: number | null;
  originRef: string | null;
  sourceKey: string;
}

export interface DatasetFilterOptions {
  minConfidence: number;
  maxNoSpeechProb: number;
  minTextLen: number;
  maxTextLen: number;
  minDurationMs: number;
  maxDurationMs: number;
  mergeGapMs: number;
  evalFraction: number;
  goldWeight: number;
}

export const DEFAULT_FILTER_OPTIONS: DatasetFilterOptions = {
  minConfidence: 0.55,
  maxNoSpeechProb: 0.5,
  minTextLen: 3,
  maxTextLen: 400,
  minDurationMs: 1000,
  maxDurationMs: 30_000,
  mergeGapMs: 1200,
  evalFraction: 0.05,
  goldWeight: 3,
};

/** A merged, filtered slice of audio ready to become one dataset row. */
export interface Clip {
  itemId: string;
  sourceKey: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  gold: boolean;
  rowIds: string[];
}

export interface DatasetRow {
  audio: string;
  text: string;
  source: string;
  item: string;
  confidence: number;
  gold: boolean;
}

/** The real `trainingEligibilityOf` signature, kept structural so a test can
 * hand in a fake without importing governance.ts at all. */
export type EligibilityFn = (
  source: YcSourceLike,
  opts: { rights?: YcRightsLike[] | null; row?: YcRowProvenance | null },
) => YcTrainingVerdict;

/** Everything `filterEligibleRows` needs alongside the row itself. */
export interface GovernanceContext {
  source: YcSourceLike;
  rights: YcRightsLike[];
}

// ── stage 1: governance (the only wall that matters) ────────────────────────

/**
 * Keep only rows whose SOURCE (not the row) resolves to ALLOWED under the
 * real ladder. `contextOf` looks up the row's source + rights; a row whose
 * context cannot be found is dropped (fail closed, never fail open).
 */
export function filterEligibleRows<T extends RawRow>(
  rows: T[],
  contextOf: (row: T) => GovernanceContext | null,
  eligibilityFn: EligibilityFn,
): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const ctx = contextOf(row);
    if (!ctx) continue;
    const provenance: YcRowProvenance = {
      id: row.id,
      sourceKey: row.sourceKey,
      engine: row.engine,
      sttProvider: row.sttProvider,
      originRef: row.originRef,
    };
    const verdict = eligibilityFn(ctx.source, { rights: ctx.rights, row: provenance });
    if (verdict.eligibility === "ALLOWED") out.push(row);
  }
  return out;
}

// ── stage 2: quality filters + merge (ivrit rows only) ──────────────────────

/** Rows without timing cannot be cut into a clip — Lane A ships the columns
 * as nullable, so a row from before the migration (or a mid-chunk failure)
 * is skipped rather than crashing the build. */
export function hasTiming(row: RawRow): boolean {
  return typeof row.startMs === "number" && typeof row.endMs === "number" && row.endMs > row.startMs;
}

/** Per-row machine-quality gate. Never applied to `engine="human"` rows —
 * a human correction does not need to clear the model's own confidence bar. */
export function passesRowQuality(row: RawRow, opts: DatasetFilterOptions): boolean {
  if (!hasTiming(row)) return false;
  const confidence = row.confidence ?? 0;
  if (confidence < opts.minConfidence) return false;
  const noSpeech = row.noSpeechProb ?? 0;
  if (noSpeech > opts.maxNoSpeechProb) return false;
  return true;
}

interface MergeGroup {
  startMs: number;
  endMs: number;
  text: string;
  confidences: number[];
  rowIds: string[];
}

/**
 * Merge consecutive rows of ONE item into clips ≤ `maxDurationMs` /
 * `maxTextLen`, joining rows whose gap is ≤ `mergeGapMs` (they are almost
 * certainly one continuous utterance a whisper chunk boundary split apart).
 * Rows must already all belong to the same item; sorting is done here.
 */
export function mergeAdjacentRows(rows: RawRow[], opts: DatasetFilterOptions): MergeGroup[] {
  const sorted = [...rows]
    .filter(hasTiming)
    .sort((a, b) => (a.startMs as number) - (b.startMs as number) || (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
  const groups: MergeGroup[] = [];
  let current: MergeGroup | null = null;
  for (const r of sorted) {
    const startMs = r.startMs as number;
    const endMs = r.endMs as number;
    const text = r.text.trim();
    const confidence = r.confidence ?? 1;
    if (current) {
      const gap = startMs - current.endMs;
      const mergedText = `${current.text} ${text}`.trim();
      const mergedDurationMs = endMs - current.startMs;
      if (gap <= opts.mergeGapMs && mergedDurationMs <= opts.maxDurationMs && mergedText.length <= opts.maxTextLen) {
        current.endMs = endMs;
        current.text = mergedText;
        current.confidences.push(confidence);
        current.rowIds.push(r.id);
        continue;
      }
      groups.push(current);
    }
    current = { startMs, endMs, text, confidences: [confidence], rowIds: [r.id] };
  }
  if (current) groups.push(current);
  return groups;
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

/** Bounds check shared by ivrit clips and gold clips: duration and text
 * length, applied AFTER merging so a merged clip is judged as one whole. */
export function withinBounds(durationMs: number, textLen: number, opts: DatasetFilterOptions): boolean {
  return (
    durationMs >= opts.minDurationMs &&
    durationMs <= opts.maxDurationMs &&
    textLen >= opts.minTextLen &&
    textLen <= opts.maxTextLen
  );
}

/** Build the ivrit (machine) clips: per-item quality filter, merge, bounds. */
export function buildIvritClips(rows: RawRow[], opts: DatasetFilterOptions): Clip[] {
  const byItem = new Map<string, RawRow[]>();
  for (const r of rows) {
    if (r.engine !== "ivrit") continue;
    if (!passesRowQuality(r, opts)) continue;
    if (!byItem.has(r.itemId)) byItem.set(r.itemId, []);
    byItem.get(r.itemId)!.push(r);
  }
  const clips: Clip[] = [];
  for (const [itemId, itemRows] of byItem) {
    const sourceKey = itemRows[0]!.sourceKey;
    for (const g of mergeAdjacentRows(itemRows, opts)) {
      const durationMs = g.endMs - g.startMs;
      if (!withinBounds(durationMs, g.text.length, opts)) continue;
      clips.push({
        itemId,
        sourceKey,
        startMs: g.startMs,
        endMs: g.endMs,
        text: g.text,
        confidence: avg(g.confidences),
        gold: false,
        rowIds: g.rowIds,
      });
    }
  }
  return clips;
}

/** Build the gold (human) clips: one clip per row, no merge — Lane C samples
 * candidates already short (3–20s) and the corrected text is trusted as-is,
 * so only the sanity bounds apply, never the machine confidence gate. */
export function buildGoldClips(rows: RawRow[], opts: DatasetFilterOptions): Clip[] {
  const clips: Clip[] = [];
  for (const r of rows) {
    if (r.engine !== "human") continue;
    if (!hasTiming(r)) continue;
    const durationMs = (r.endMs as number) - (r.startMs as number);
    const text = r.text.trim();
    if (!withinBounds(durationMs, text.length, opts)) continue;
    clips.push({
      itemId: r.itemId,
      sourceKey: r.sourceKey,
      startMs: r.startMs as number,
      endMs: r.endMs as number,
      text,
      confidence: r.confidence ?? 1,
      gold: true,
      rowIds: [r.id],
    });
  }
  return clips;
}

// ── stage 3: item-level train/eval split ────────────────────────────────────

/** A stable pseudo-random value in [0, 1) for an id — same id always gives
 * the same value, so re-running the builder never reshuffles a prior split. */
export function stableUnit(id: string): number {
  const digest = createHash("sha1").update(id).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Assign every ITEM (never a single row/clip) to "train" or "eval", so an
 * item can never straddle both splits. Gold rows are handled separately by
 * the caller and deliberately override this for their own item (§3.2.1: gold
 * is always in eval, and duplicated into train) — that is a named exception,
 * not a violation of "never split an item".
 */
export function assignSplits(itemIds: string[], evalFraction: number): Map<string, "train" | "eval"> {
  const map = new Map<string, "train" | "eval">();
  for (const id of itemIds) map.set(id, stableUnit(id) < evalFraction ? "eval" : "train");
  return map;
}

// ── stage 4: assemble dataset rows ──────────────────────────────────────────

function clipFileName(c: Clip): string {
  const hash = createHash("sha1").update(`${c.itemId}:${c.startMs}:${c.endMs}:${c.gold ? "gold" : "ivrit"}`).digest("hex").slice(0, 16);
  return `${c.gold ? "gold" : "ivrit"}-${hash}.wav`;
}

function toDatasetRow(c: Clip): DatasetRow {
  return {
    audio: `clips/${clipFileName(c)}`,
    text: c.text,
    source: c.sourceKey,
    item: c.itemId,
    confidence: Number(c.confidence.toFixed(4)),
    gold: c.gold,
  };
}

export interface AssembledDataset {
  train: DatasetRow[];
  evalRows: DatasetRow[];
  /** Every clip that needs to be cut on disk, de-duplicated by file name. */
  clipsToCut: Clip[];
}

/**
 * Turn ivrit + gold clips into train.jsonl / eval.jsonl rows.
 *   - ivrit clips: whichever split their ITEM was assigned to.
 *   - gold clips: ALWAYS in eval, and repeated `goldWeight` times in train
 *     (§3.2.1 — gold is the highest-trust label, so training sees it more).
 */
export function assembleDatasetRows(params: {
  ivritClips: Clip[];
  goldClips: Clip[];
  splitByItem: Map<string, "train" | "eval">;
  goldWeight: number;
}): AssembledDataset {
  const train: DatasetRow[] = [];
  const evalRows: DatasetRow[] = [];
  const clipsToCut: Clip[] = [];
  const seenFiles = new Set<string>();

  const stage = (c: Clip) => {
    const file = clipFileName(c);
    if (!seenFiles.has(file)) {
      seenFiles.add(file);
      clipsToCut.push(c);
    }
  };

  for (const c of params.ivritClips) {
    const split = params.splitByItem.get(c.itemId) ?? "train";
    stage(c);
    (split === "eval" ? evalRows : train).push(toDatasetRow(c));
  }
  for (const c of params.goldClips) {
    stage(c);
    const row = toDatasetRow(c);
    evalRows.push(row);
    for (let i = 0; i < Math.max(1, params.goldWeight); i++) train.push(row);
  }
  return { train, evalRows, clipsToCut };
}

// ── stats + manifest ─────────────────────────────────────────────────────────

export interface SourceStat {
  source: string;
  clips: number;
  hours: number;
  meanConfidence: number;
}

export interface DatasetStats {
  trainClips: number;
  evalClips: number;
  goldClips: number;
  totalHours: number;
  meanConfidence: number;
  bySource: SourceStat[];
}

export function computeStats(clips: Clip[]): DatasetStats {
  const bySourceMap = new Map<string, { clips: number; ms: number; confSum: number }>();
  let totalMs = 0;
  let confSum = 0;
  let goldClips = 0;
  for (const c of clips) {
    const durationMs = c.endMs - c.startMs;
    totalMs += durationMs;
    confSum += c.confidence;
    if (c.gold) goldClips += 1;
    const bucket = bySourceMap.get(c.sourceKey) ?? { clips: 0, ms: 0, confSum: 0 };
    bucket.clips += 1;
    bucket.ms += durationMs;
    bucket.confSum += c.confidence;
    bySourceMap.set(c.sourceKey, bucket);
  }
  const bySource: SourceStat[] = [...bySourceMap.entries()]
    .map(([source, b]) => ({
      source,
      clips: b.clips,
      hours: Number((b.ms / 3_600_000).toFixed(3)),
      meanConfidence: Number((b.confSum / b.clips).toFixed(4)),
    }))
    .sort((a, b) => b.hours - a.hours);
  return {
    trainClips: 0, // filled in by the caller, who knows the split
    evalClips: 0,
    goldClips,
    totalHours: Number((totalMs / 3_600_000).toFixed(3)),
    meanConfidence: clips.length ? Number((confSum / clips.length).toFixed(4)) : 0,
    bySource,
  };
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export interface Manifest {
  createdAt: string;
  version: string;
  options: DatasetFilterOptions;
  files: { name: string; sha256: string; rows: number }[];
  stats: DatasetStats & { trainClips: number; evalClips: number };
}

export function buildManifest(params: {
  version: string;
  options: DatasetFilterOptions;
  files: { name: string; sha256: string; rows: number }[];
  stats: DatasetStats & { trainClips: number; evalClips: number };
}): Manifest {
  return {
    createdAt: new Date().toISOString(),
    version: params.version,
    options: params.options,
    files: params.files,
    stats: params.stats,
  };
}

// ── ffmpeg: cut one clip to 16kHz mono 16-bit WAV ───────────────────────────

export interface CutResult {
  ok: boolean;
  reason?: string;
}

export function cutClip(
  ffmpegPath: string,
  sourceFile: string,
  startMs: number,
  endMs: number,
  outFile: string,
): Promise<CutResult> {
  const durationSec = Math.max(0.05, (endMs - startMs) / 1000);
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    (startMs / 1000).toFixed(3),
    "-t",
    durationSec.toFixed(3),
    "-i",
    sourceFile,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-sample_fmt",
    "s16",
    outFile,
  ];
  return new Promise((resolve) => {
    execFile(ffmpegPath, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) return resolve({ ok: false, reason: String(stderr || err.message || err).slice(0, 400) });
      resolve({ ok: true });
    });
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────

interface Cli {
  version: string;
  outDir: string;
  dryRun: boolean;
  engineRoot: string;
  limit: number | null;
  options: DatasetFilterOptions;
}

export function parseArgs(argv: string[]): Cli {
  const opts: DatasetFilterOptions = { ...DEFAULT_FILTER_OPTIONS };
  const cli: Cli = {
    version: new Date().toISOString().replace(/[:.]/g, "-"),
    outDir: path.join(HERE, "dataset"),
    dryRun: false,
    engineRoot: process.env.YC_ENGINE_ROOT || path.resolve(HERE, "../../apps/api/src/yiddishCorpus"),
    limit: null,
    options: opts,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--version": cli.version = next(); break;
      case "--out-dir": cli.outDir = path.resolve(next()); break;
      case "--dry-run": cli.dryRun = true; break;
      case "--engine-root": cli.engineRoot = path.resolve(next()); break;
      case "--limit": cli.limit = Number(next()); break;
      case "--min-confidence": opts.minConfidence = Number(next()); break;
      case "--max-no-speech-prob": opts.maxNoSpeechProb = Number(next()); break;
      case "--min-text-len": opts.minTextLen = Number(next()); break;
      case "--max-text-len": opts.maxTextLen = Number(next()); break;
      case "--min-duration-ms": opts.minDurationMs = Number(next()); break;
      case "--max-duration-ms": opts.maxDurationMs = Number(next()); break;
      case "--merge-gap-ms": opts.mergeGapMs = Number(next()); break;
      case "--eval-fraction": opts.evalFraction = Number(next()); break;
      case "--gold-weight": opts.goldWeight = Number(next()); break;
      default:
        if (a && a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    }
  }
  return cli;
}

async function resolveEligibilityFn(engineRoot: string): Promise<EligibilityFn> {
  const modPath = path.join(engineRoot, "governance.ts");
  const modUrl = pathToFileURL(modPath).href;
  const mod: any = await import(modUrl);
  if (typeof mod.trainingEligibilityOf !== "function") {
    throw new Error(`governance module at ${modPath} has no trainingEligibilityOf export`);
  }
  return mod.trainingEligibilityOf as EligibilityFn;
}

async function main(): Promise<void> {
  loadEnvFile(path.join(HERE, "..", "yiddish-runner", ".env"));
  process.env.YC_FFMPEG_PATH ||= path.join(FFMPEG_WINGET_BIN, "ffmpeg.exe");
  process.env.YC_FFPROBE_PATH ||= path.join(FFMPEG_WINGET_BIN, "ffprobe.exe");

  const cli = parseArgs(process.argv.slice(2));
  const eligibilityFn = await resolveEligibilityFn(cli.engineRoot);

  const { PrismaClient } = await import("@prisma/client");
  const db: any = new PrismaClient();

  console.log(`[build-dataset] querying YcTranscript engine in (ivrit, human)…`);
  const transcripts: any[] = await db.ycTranscript.findMany({
    where: { engine: { in: ["ivrit", "human"] } },
    include: { item: { include: { source: { include: { rights: true } } } } },
    ...(cli.limit ? { take: cli.limit } : {}),
  });

  const itemIds = [...new Set(transcripts.map((t) => t.itemId))];
  const assets: any[] = itemIds.length
    ? await db.ycAudioAsset.findMany({ where: { itemId: { in: itemIds }, storage: "STORED", deletedAt: null } })
    : [];
  const assetByItem = new Map<string, any>();
  for (const a of assets) if (!assetByItem.has(a.itemId)) assetByItem.set(a.itemId, a);

  let skippedNoTiming = 0;
  const rows: RawRow[] = [];
  const contextByRowId = new Map<string, GovernanceContext>();
  for (const t of transcripts) {
    const item = t.item;
    const source = item?.source;
    if (!item || !source) continue;
    const row: RawRow = {
      id: t.id,
      itemId: t.itemId,
      segmentId: t.segmentId ?? null,
      engine: t.engine,
      sttProvider: t.sttProvider ?? null,
      text: String(t.text || ""),
      confidence: typeof t.confidence === "number" ? t.confidence : null,
      noSpeechProb: typeof t.noSpeechProb === "number" ? t.noSpeechProb : null,
      startMs: typeof t.startMs === "number" ? t.startMs : null,
      endMs: typeof t.endMs === "number" ? t.endMs : null,
      chunkIndex: typeof t.chunkIndex === "number" ? t.chunkIndex : null,
      originRef: t.originRef ?? null,
      sourceKey: source.key,
    };
    if (!hasTiming(row)) {
      skippedNoTiming += 1;
      continue;
    }
    rows.push(row);
    contextByRowId.set(row.id, {
      source: {
        key: source.key,
        name: source.name,
        governanceClass: source.governanceClass,
        contentAllowed: !!source.contentAllowed,
        audioFetchMode: source.audioFetchMode,
        trainingExportEligibility: source.trainingExportEligibility,
        rightsNote: source.rightsNote ?? null,
      },
      rights: (source.rights || []).map((r: any) => ({
        allowedUse: r.allowedUse,
        state: r.state,
        decidedBy: r.decidedBy ?? null,
        evidence: r.evidence ?? null,
      })),
    });
  }

  const eligible = filterEligibleRows(rows, (r) => contextByRowId.get(r.id) ?? null, eligibilityFn);
  console.log(
    `[build-dataset] ${transcripts.length} transcript rows -> ${skippedNoTiming} skipped (no timing) -> ${rows.length} timed -> ${eligible.length} governance-ALLOWED`,
  );

  const ivritClips = buildIvritClips(eligible, cli.options);
  const goldClips = buildGoldClips(eligible, cli.options);
  const trainItemIds = [...new Set(ivritClips.map((c) => c.itemId))];
  const splitByItem = assignSplits(trainItemIds, cli.options.evalFraction);
  const { train, evalRows, clipsToCut } = assembleDatasetRows({ ivritClips, goldClips, splitByItem, goldWeight: cli.options.goldWeight });

  const allClips = [...ivritClips, ...goldClips];
  const rawStats = computeStats(allClips);
  const stats = { ...rawStats, trainClips: train.length, evalClips: evalRows.length };

  console.log(`[build-dataset] stats:`, JSON.stringify(stats, null, 2));

  if (cli.dryRun) {
    console.log(`[build-dataset] --dry-run: no clips cut, no files written.`);
    await db.$disconnect();
    return;
  }

  const clipsDir = path.join(cli.outDir, cli.version, "clips");
  mkdirSync(clipsDir, { recursive: true });

  let cutOk = 0;
  let cutFailed = 0;
  for (const c of clipsToCut) {
    const asset = assetByItem.get(c.itemId);
    if (!asset?.storageKey) {
      cutFailed += 1;
      continue;
    }
    const outFile = path.join(clipsDir, clipFileName(c));
    const res = await cutClip(process.env.YC_FFMPEG_PATH!, asset.storageKey, c.startMs, c.endMs, outFile);
    if (res.ok) cutOk += 1;
    else {
      cutFailed += 1;
      console.error(`[build-dataset] ffmpeg failed for item ${c.itemId} (${c.startMs}-${c.endMs}ms): ${res.reason}`);
    }
  }
  console.log(`[build-dataset] cut ${cutOk} clips, ${cutFailed} failed`);

  const outDirVersion = path.join(cli.outDir, cli.version);
  const trainFile = path.join(outDirVersion, "train.jsonl");
  const evalFile = path.join(outDirVersion, "eval.jsonl");
  writeFileSync(trainFile, train.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  writeFileSync(evalFile, evalRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  const manifest = buildManifest({
    version: cli.version,
    options: cli.options,
    files: [
      { name: "train.jsonl", sha256: await sha256File(trainFile), rows: train.length },
      { name: "eval.jsonl", sha256: await sha256File(evalFile), rows: evalRows.length },
    ],
    stats,
  });
  writeFileSync(path.join(outDirVersion, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`[build-dataset] wrote ${outDirVersion} (train=${train.length} eval=${evalRows.length})`);

  await db.$disconnect();
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
    console.error("[build-dataset] fatal", err);
    process.exit(1);
  });
}
