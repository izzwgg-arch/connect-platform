#!/usr/bin/env -S npx tsx
/**
 * Loopcom Yiddish learning engine — UNATTENDED 80-hour labelling orchestrator.
 *
 * Drives `kaggle-label.ts`'s pack -> push -> run -> status -> pull -> import
 * pipeline in a loop, batch after batch, until either an hour budget is spent
 * or there is no more unlabelled `yiddish24` audio left to pack. Meant to be
 * started once and left alone:
 *
 *   npx tsx orchestrate.ts --hours 80 --confirm
 *
 * Every stage transition of every batch is persisted to a JSON state file
 * (`orchestrate-state.json` by default) as it happens, so killing the process
 * (crash, reboot, `STOP` file) and re-running the SAME command resumes each
 * in-flight batch from wherever it left off instead of redoing finished work
 * or re-packing an already-pushed dataset.
 *
 * ⛔ This file only ever calls the ALREADY-GATED functions exported by
 * `kaggle-label.ts` (`runPack`, `pushBatch`, `runBatch`, `statusBatch`,
 * `pullBatch`, `importBatch`) — it never talks to ffmpeg, the `kaggle` CLI, or
 * Prisma directly, and it never reimplements any of that file's `--confirm`
 * gates, the customer-source guard, or the confidence/enqueue engine calls.
 *
 * ⛔ Kaggle-hours budgeting: this is a WALL-CLOCK hour budget (`--hours`), not
 * a GPU-hour budget — Kaggle's own ~30 GPU-hours/week free quota and 12h/session
 * cap are enforced by Kaggle itself, not by this script. A batch is capped at
 * `--max-hours-per-batch` (default 60) of audio AND `--max-gb` (default 12,
 * safely under Kaggle's ~20GB dataset ceiling) so a single batch's kernel has
 * room to finish comfortably inside one 12h session (see README.md's
 * throughput math: ~10x real-time on a T4 means a 60h batch across 2 GPUs is
 * on the order of ~3h wall-clock, not 12).
 *
 * ⛔ The `kaggle` CLI lives at
 * `C:\Users\izzyw\LoopcomYiddishRunner\.venv\Scripts\kaggle.exe`, NOT on the
 * system PATH. `kaggleAwareExecFn` below resolves the binary directly and
 * also prepends its directory to PATH (kaggle.exe itself shells out to the
 * venv's own python) so an unattended, non-interactive run never dies with
 * the empty "could not run kaggle" spawn error a bare PATH lookup gives.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  YIDDISH24_SOURCE_KEY,
  formatPackStats,
  importBatch,
  kernelSlugFor,
  pullBatch,
  pushBatch,
  readManifestFile,
  resolveEngineFns,
  runBatch,
  runPack,
  statusBatch,
  type TranscriptsFile,
} from "./kaggle-label";
import { loadRunnerEnv } from "../yiddish-finetune/build-dataset";
import type { ExecFn, KaggleDeps } from "../yiddish-finetune/kaggle-run";
import { pctOf, reportPipelineState, type PipelineProgress, type PipelineStatus } from "../yiddish-shared/pipelineState";

/** Key this file reports its live status under in `YcPipelineState`. */
export const PIPELINE_STATE_KEY = "labelling.orchestrator";

const HERE = __dirname;

export const DEFAULT_MODEL = "ivrit-ai/yi-whisper-large-v3-turbo-ct2";

const FFMPEG_WINGET_BIN =
  "C:\\Users\\izzyw\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin";

const KAGGLE_BIN_DIR = "C:\\Users\\izzyw\\LoopcomYiddishRunner\\.venv\\Scripts";
const KAGGLE_EXE = path.join(KAGGLE_BIN_DIR, "kaggle.exe");

/** Kaggle sessions cap at 12h. A little over that with no status change is
 * treated as a stuck/lost kernel rather than polled forever. */
export const MAX_POLL_HOURS = 13;

// ── kaggle exec wrapper: resolves the binary directly + prepends PATH ──────

export const kaggleAwareExecFn: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    const resolvedCmd = cmd === "kaggle" && existsSync(KAGGLE_EXE) ? KAGGLE_EXE : cmd;
    // ⛔ The Kaggle CLI prints whatever the kernel logged. A Yiddish kernel log is
    // Hebrew script, and on Windows Python defaults to cp1252, so `kernels output`
    // died with "'charmap' codec can't encode characters" AFTER it had already
    // written transcripts.json — the data was fine, the CLI just could not print.
    // Force UTF-8 so an unattended run never loses a finished batch to a console
    // encoding error.
    const env = {
      ...process.env,
      PATH: `${KAGGLE_BIN_DIR};${process.env.PATH || ""}`,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    };
    execFile(resolvedCmd, args, { cwd: opts?.cwd, env, maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60_000 }, (err: any, stdout, stderr) => {
      let errText = String(stderr || "");
      if (err && !errText && !String(stdout || "")) {
        errText =
          err.code === "ENOENT"
            ? `could not run "${resolvedCmd}" (checked ${KAGGLE_EXE} and PATH=${KAGGLE_BIN_DIR};...) — confirm the runner venv exists.`
            : `"${resolvedCmd}" produced no output and failed (${err.code ?? err.message ?? "unknown error"}).`;
      }
      resolve({ code: err?.code == null ? 0 : Number(err.code) || 1, stdout: String(stdout || ""), stderr: errText });
    });
  });

// ── batch id sequencing: YYYY-MM-DD-<letter>, letters roll over a..z, aa.. ──

export function formatDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Spreadsheet-column style: 0->a, 25->z, 26->aa, 27->ab, ... */
export function batchSuffixForIndex(n: number): string {
  let num = n + 1;
  let s = "";
  while (num > 0) {
    num -= 1;
    s = String.fromCharCode(97 + (num % 26)) + s;
    num = Math.floor(num / 26);
  }
  return s;
}

/** Picks the next unused `YYYY-MM-DD-<letter>` id for `now`'s date, given the
 * batch ids that already exist on disk (or in the state file) — so a restart
 * on the same day never collides with a batch already packed/pushed today. */
export function nextBatchId(existingIds: string[], now: Date): string {
  const date = formatDateUTC(now);
  const prefix = `${date}-`;
  const usedSuffixes = new Set(existingIds.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)));
  let i = 0;
  while (usedSuffixes.has(batchSuffixForIndex(i))) i += 1;
  return `${prefix}${batchSuffixForIndex(i)}`;
}

// ── kernel status classification (pure) ─────────────────────────────────────

export type KernelStatus = "queued" | "running" | "complete" | "error" | "unknown";

export function classifyKernelStatus(raw: string): KernelStatus {
  const s = (raw || "").toLowerCase();
  if (/\berror\b/.test(s)) return "error";
  if (/cancel/.test(s)) return "error";
  if (/\bcomplete\b/.test(s)) return "complete";
  if (/\brunning\b/.test(s)) return "running";
  if (/queue/.test(s)) return "queued";
  return "unknown";
}

// ── log-tail extraction after a pull (fs-only, no network) ─────────────────

export function extractLogTail(dir: string, maxLines = 60): string {
  if (!existsSync(dir)) return `(no output directory at ${dir} — pull produced nothing)`;
  const logFiles: string[] = [];
  const walk = (d: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (/\.log$/i.test(e)) logFiles.push(full);
    }
  };
  walk(dir);
  if (logFiles.length === 0) return `(no .log file found under ${dir} after pull)`;
  const text = logFiles
    .map((f) => {
      try {
        return `--- ${path.basename(f)} ---\n${readFileSync(f, "utf8")}`;
      } catch {
        return `--- ${path.basename(f)} (unreadable) ---`;
      }
    })
    .join("\n\n");
  const lines = text.split(/\r?\n/);
  return lines.slice(-maxLines).join("\n");
}

// ── elapsed-hours helper (pure) ──────────────────────────────────────────────

export function elapsedHours(startedAtIso: string, nowMs: number): number {
  const startMs = new Date(startedAtIso).getTime();
  return (nowMs - startMs) / 3_600_000;
}

// ── state file ───────────────────────────────────────────────────────────────

export type BatchStage =
  | "new"
  | "packed"
  | "pushed"
  | "running"
  | "kernel_complete"
  | "kernel_error"
  | "pulled"
  | "imported"
  | "failed"
  | "skipped_empty";

export const TERMINAL_STAGES: BatchStage[] = ["imported", "failed", "skipped_empty"];

export interface BatchPackStats {
  files: number;
  hours: number;
  estimatedGb: number;
}

export interface BatchImportSummary {
  itemsImported: number;
  segments: number;
  hours: number;
  failures: number;
}

export interface BatchError {
  stage: string;
  message: string;
  logTail?: string;
  at: string;
}

export interface BatchRecord {
  id: string;
  source: string;
  model: string;
  stage: BatchStage;
  createdAt: string;
  packedAt?: string;
  pushedAt?: string;
  runStartedAt?: string;
  kernelFinishedAt?: string;
  pulledAt?: string;
  finishedAt?: string;
  pack?: BatchPackStats;
  kernelStatus?: string;
  error?: BatchError;
  importSummary?: BatchImportSummary;
}

export interface OrchestratorState {
  startedAt: string;
  hoursBudget: number;
  maxHoursPerBatch: number;
  maxGb: number;
  source: string;
  model: string;
  batches: BatchRecord[];
  lastUpdatedAt: string;
  stoppedReason?: "hours_budget" | "audio_exhausted" | "stop_file";
}

export function newState(opts: { hours: number; maxHoursPerBatch: number; maxGb: number; source: string; model: string }, now: Date): OrchestratorState {
  return {
    startedAt: now.toISOString(),
    hoursBudget: opts.hours,
    maxHoursPerBatch: opts.maxHoursPerBatch,
    maxGb: opts.maxGb,
    source: opts.source,
    model: opts.model,
    batches: [],
    lastUpdatedAt: now.toISOString(),
  };
}

export function loadStateFile(file: string): OrchestratorState | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function saveStateFile(file: string, state: OrchestratorState): void {
  state.lastUpdatedAt = new Date().toISOString();
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}

// ── CLI arg parsing (pure) ───────────────────────────────────────────────────

export interface OrchestratorOptions {
  hours: number;
  maxHoursPerBatch: number;
  maxGb: number;
  model: string;
  source: string;
  owner?: string;
  confirm: boolean;
  dryRun: boolean;
  pollIntervalMs: number;
  stateFile: string;
  stopFile: string;
  batchesRoot: string;
  engineRoot?: string;
}

function argValOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function parseArgs(argv: string[], here: string): OrchestratorOptions {
  const num = (flag: string, def: number) => {
    const v = argValOf(argv, flag);
    return v !== undefined ? Number(v) : def;
  };
  return {
    hours: num("--hours", 80),
    maxHoursPerBatch: num("--max-hours-per-batch", 60),
    maxGb: num("--max-gb", 12),
    model: argValOf(argv, "--model") || DEFAULT_MODEL,
    source: argValOf(argv, "--source") || YIDDISH24_SOURCE_KEY,
    owner: argValOf(argv, "--owner") || process.env.KAGGLE_USERNAME,
    confirm: argv.includes("--confirm"),
    dryRun: argv.includes("--dry-run"),
    pollIntervalMs: num("--poll-interval-seconds", 120) * 1000,
    stateFile: argValOf(argv, "--state-file") || path.join(here, "orchestrate-state.json"),
    stopFile: argValOf(argv, "--stop-file") || path.join(here, "STOP"),
    batchesRoot: path.join(here, "batches"),
    engineRoot: argValOf(argv, "--engine-root"),
  };
}

// ── the injectable driver loop ───────────────────────────────────────────────

/** What one `deps.report()` call carries — mirrors `ReportPipelineStateInput`
 * minus the `key`/`kind`/`startedAt` fields, which the driver (real or test)
 * supplies itself so the pure state machine never has to know its own DB key. */
export interface OrchestratorReportInput {
  status: PipelineStatus;
  headline: string;
  progress?: PipelineProgress | null;
  detail?: unknown;
}

export interface OrchestratorDeps {
  existingBatchIds: () => string[];
  pack: (batch: string, maxGb: number, maxHours: number, source: string) => Promise<BatchPackStats>;
  push: (batch: string, isNew: boolean) => Promise<void>;
  run: (batch: string, model: string) => Promise<void>;
  status: (batch: string) => Promise<string>;
  pull: (batch: string) => Promise<void>;
  readLogTail: (batch: string) => string;
  importBatch: (batch: string) => Promise<BatchImportSummary>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  isStopRequested: () => boolean;
  log: (line: string) => void;
  /** Report the orchestrator's current, plain-English status for the portal.
   * Optional (defaults to a no-op) so every existing fake-deps test keeps
   * working unchanged — only the tests that care about reporting need to
   * supply it. Must never throw; `runOrchestrator` also guards every call
   * defensively so a broken reporter can never take the 80-hour loop down. */
  report?: (input: OrchestratorReportInput) => Promise<void> | void;
}

function nowIso(deps: OrchestratorDeps): string {
  return new Date(deps.now()).toISOString();
}

/**
 * The core loop. Pure state-machine driving `deps` — no direct fs/network/db
 * access here, so this is fully testable with fake deps and an in-memory
 * state object. `persist` is called after every stage transition, which is
 * what makes a restart resume rather than redo.
 */
export async function runOrchestrator(
  opts: OrchestratorOptions,
  state: OrchestratorState,
  deps: OrchestratorDeps,
  persist: (s: OrchestratorState) => void,
): Promise<OrchestratorState> {
  const log = deps.log;

  // Never lets a broken/missing reporter take the 80-hour loop down — on top
  // of `reportPipelineState` itself never throwing, this call site is also
  // guarded, since `deps.report` may be ANY caller-supplied function (e.g. a
  // test double) that does not carry that same guarantee.
  const report = async (input: OrchestratorReportInput): Promise<void> => {
    try {
      await deps.report?.(input);
    } catch {
      // deliberately swallowed — see the doc comment on OrchestratorDeps.report
    }
  };

  outer: while (true) {
    let batch = state.batches.find((b) => !TERMINAL_STAGES.includes(b.stage));

    if (!batch) {
      // Only gate the START of a brand-new batch on the coarse stop
      // conditions — an in-flight batch (found above) always runs to a
      // terminal stage first, since GPU time/upload for it is already spent.
      if (deps.isStopRequested()) {
        state.stoppedReason = "stop_file";
        log(`STOP file present — exiting cleanly (no batch in flight, ${state.batches.length} recorded).`);
        await report({ status: "idle", headline: "Stopped (STOP file present) — no batch was in flight.", detail: { batches: state.batches.length } });
        break;
      }
      const elapsed = elapsedHours(state.startedAt, deps.now());
      if (elapsed >= opts.hours) {
        state.stoppedReason = "hours_budget";
        log(`hour budget reached (${elapsed.toFixed(2)}h >= ${opts.hours}h) — exiting cleanly.`);
        await report({
          status: "done",
          headline: `Finished — hour budget reached (${elapsed.toFixed(2)}h of ${opts.hours}h).`,
          detail: { batches: state.batches.length },
        });
        break;
      }
      // Consider both what's already on disk (deps.existingBatchIds()) AND
      // what this run has already recorded in state — the two usually agree,
      // but relying on state too means a batch id can never collide even if
      // the batches/ directory listing lags behind (e.g. a fake/test deps).
      const knownIds = [...deps.existingBatchIds(), ...state.batches.map((b) => b.id)];
      const id = nextBatchId(knownIds, new Date(deps.now()));
      await report({ status: "idle", headline: `Between batches — starting batch ${id} next.`, detail: { nextBatchId: id } });
      batch = { id, source: opts.source, model: opts.model, stage: "new", createdAt: nowIso(deps) };
      state.batches.push(batch);
      persist(state);
    }

    // ── PACK ──────────────────────────────────────────────────────────────
    if (batch.stage === "new") {
      log(`${batch.id}: packing (source=${opts.source} maxHours=${opts.maxHoursPerBatch} maxGb=${opts.maxGb})`);
      await report({
        status: "running",
        headline: `Packing batch ${batch.id} from "${opts.source}" (up to ${opts.maxHoursPerBatch}h / ${opts.maxGb}GB).`,
        detail: { batchId: batch.id, source: opts.source, maxHoursPerBatch: opts.maxHoursPerBatch, maxGb: opts.maxGb },
      });
      const stats = await deps.pack(batch.id, opts.maxGb, opts.maxHoursPerBatch, opts.source);
      batch.pack = stats;
      if (stats.files === 0) {
        batch.stage = "skipped_empty";
        batch.finishedAt = nowIso(deps);
        state.stoppedReason = "audio_exhausted";
        persist(state);
        log(`${batch.id}: pack found 0 candidate file(s) — no unlabelled "${opts.source}" audio left. Stopping.`);
        await report({
          status: "done",
          headline: `Finished — no unlabelled "${opts.source}" audio left to pack.`,
          detail: { batchId: batch.id, batches: state.batches.length },
        });
        break;
      }
      batch.stage = "packed";
      batch.packedAt = nowIso(deps);
      log(`${batch.id}: packed ${stats.files} file(s), ${stats.hours}h, ~${stats.estimatedGb}GB`);
      await report({
        status: "running",
        headline: `Packed batch ${batch.id}: ${stats.files} file(s), ${stats.hours}h, ~${stats.estimatedGb}GB — uploading next.`,
        progress: { current: stats.files, total: stats.files, unit: "files", pct: 100 },
        detail: { batchId: batch.id, pack: stats },
      });
      persist(state);
    }

    if (deps.isStopRequested()) {
      state.stoppedReason = "stop_file";
      persist(state);
      log(`STOP file present after packing ${batch.id} — exiting cleanly.`);
      await report({ status: "idle", headline: `Stopped after packing batch ${batch.id} (STOP file present).`, detail: { batchId: batch.id } });
      break;
    }

    // ── PUSH ──────────────────────────────────────────────────────────────
    if (batch.stage === "packed") {
      log(`${batch.id}: pushing dataset`);
      await report({
        status: "running",
        headline: `Uploading batch ${batch.id} to Kaggle (${batch.pack?.hours ?? "?"}h, ${batch.pack?.files ?? "?"} file(s)).`,
        detail: { batchId: batch.id },
      });
      await deps.push(batch.id, true);
      batch.stage = "pushed";
      batch.pushedAt = nowIso(deps);
      persist(state);
    }

    if (deps.isStopRequested()) {
      state.stoppedReason = "stop_file";
      persist(state);
      log(`STOP file present after pushing ${batch.id} — exiting cleanly.`);
      await report({ status: "idle", headline: `Stopped after uploading batch ${batch.id} (STOP file present).`, detail: { batchId: batch.id } });
      break;
    }

    // ── RUN ───────────────────────────────────────────────────────────────
    if (batch.stage === "pushed") {
      const kernelRef = opts.owner ? `${opts.owner}/${kernelSlugFor(batch.id)}` : kernelSlugFor(batch.id);
      log(`${batch.id}: starting kernel (model=${batch.model})`);
      await report({
        status: "running",
        headline: `Starting the labelling kernel for batch ${batch.id} on Kaggle (model=${batch.model}).`,
        detail: { batchId: batch.id, kernelRef, model: batch.model },
      });
      await deps.run(batch.id, batch.model);
      batch.stage = "running";
      batch.runStartedAt = nowIso(deps);
      persist(state);
    }

    // ── POLL ──────────────────────────────────────────────────────────────
    if (batch.stage === "running") {
      const kernelRef = opts.owner ? `${opts.owner}/${kernelSlugFor(batch.id)}` : kernelSlugFor(batch.id);
      let kstatus: KernelStatus = "unknown";
      while (true) {
        if (deps.isStopRequested()) {
          state.stoppedReason = "stop_file";
          persist(state);
          log(`${batch.id}: STOP file present while polling — exiting cleanly (the kernel keeps running on Kaggle; re-running resumes polling it).`);
          await report({
            status: "idle",
            headline: `Stopped while labelling batch ${batch.id} on Kaggle (STOP file present) — the kernel keeps running; re-run to resume polling it.`,
            detail: { batchId: batch.id, kernelRef },
          });
          break outer;
        }
        const raw = await deps.status(batch.id);
        batch.kernelStatus = raw;
        kstatus = classifyKernelStatus(raw);
        const runningHours = elapsedHours(batch.runStartedAt!, deps.now());
        if (kstatus === "complete" || kstatus === "error") break;
        if (runningHours > MAX_POLL_HOURS) {
          kstatus = "error";
          batch.kernelStatus = `timeout after ${runningHours.toFixed(2)}h polling (last raw status: ${raw})`;
          break;
        }
        await report({
          status: "running",
          headline: `Labelling on Kaggle: batch ${batch.id} has been running ${runningHours.toFixed(2)}h (status: ${raw}).`,
          detail: { batchId: batch.id, kernelRef, rawStatus: raw, runningHours: Number(runningHours.toFixed(2)) },
        });
        persist(state);
        await deps.sleep(opts.pollIntervalMs);
      }
      batch.kernelFinishedAt = nowIso(deps);
      batch.stage = kstatus === "complete" ? "kernel_complete" : "kernel_error";
      persist(state);
    }

    // ── ERROR: log + continue with the next batch, never spin on one ──────
    if (batch.stage === "kernel_error") {
      log(`${batch.id}: kernel ERROR (${batch.kernelStatus}) — downloading its log and moving on to the next batch`);
      let logTail: string;
      try {
        await deps.pull(batch.id);
        logTail = deps.readLogTail(batch.id);
      } catch (e: any) {
        logTail = `(failed to download output/log: ${e?.message || String(e)})`;
      }
      batch.error = { stage: "kernel", message: batch.kernelStatus || "error", logTail, at: nowIso(deps) };
      batch.stage = "failed";
      batch.finishedAt = nowIso(deps);
      persist(state);
      log(`${batch.id}: marked failed. continuing.`);
      await report({
        status: "error",
        headline: `Batch ${batch.id} failed on Kaggle (${batch.error.message}) — moving on to the next batch.`,
        detail: { batchId: batch.id, message: batch.error.message, logTail },
      });
      continue outer;
    }

    // ── PULL ──────────────────────────────────────────────────────────────
    if (batch.stage === "kernel_complete") {
      log(`${batch.id}: pulling transcripts`);
      await report({ status: "running", headline: `Pulling transcripts for batch ${batch.id} from Kaggle.`, detail: { batchId: batch.id } });
      await deps.pull(batch.id);
      batch.stage = "pulled";
      batch.pulledAt = nowIso(deps);
      persist(state);
    }

    if (deps.isStopRequested()) {
      state.stoppedReason = "stop_file";
      persist(state);
      log(`STOP file present after pulling ${batch.id} — exiting cleanly.`);
      await report({ status: "idle", headline: `Stopped after pulling batch ${batch.id} (STOP file present).`, detail: { batchId: batch.id } });
      break;
    }

    // ── IMPORT ────────────────────────────────────────────────────────────
    if (batch.stage === "pulled") {
      const totalFiles = batch.pack?.files ?? 0;
      log(`${batch.id}: importing transcripts`);
      await report({
        status: "running",
        headline: `Importing labelled segments for batch ${batch.id} (0 of ${totalFiles} file(s)).`,
        progress: { current: 0, total: totalFiles, unit: "files", pct: pctOf(0, totalFiles) },
        detail: { batchId: batch.id },
      });
      const summary = await deps.importBatch(batch.id);
      batch.importSummary = summary;
      batch.stage = "imported";
      batch.finishedAt = nowIso(deps);
      persist(state);
      log(`${batch.id}: imported items=${summary.itemsImported} segments=${summary.segments} hours=${summary.hours} failures=${summary.failures}`);
      await report({
        status: "running",
        headline:
          `Finished batch ${batch.id}: imported ${summary.itemsImported} of ${totalFiles} item(s), ` +
          `${summary.segments} segment(s), ${summary.hours}h${summary.failures ? `, ${summary.failures} failure(s)` : ""}.`,
        progress: { current: summary.itemsImported, total: totalFiles, unit: "items", pct: pctOf(summary.itemsImported, totalFiles) },
        detail: { batchId: batch.id, importSummary: summary },
      });
    }
  }

  persist(state);
  return state;
}

// ── real driver wiring ───────────────────────────────────────────────────────

function defaultFfmpegPath(): string {
  return process.env.YC_FFMPEG_PATH || path.join(FFMPEG_WINGET_BIN, "ffmpeg.exe");
}

async function buildRealDeps(
  opts: OrchestratorOptions,
  db: any,
  engineFns: Awaited<ReturnType<typeof resolveEngineFns>>,
  startedAt: string,
): Promise<OrchestratorDeps> {
  const kaggleDeps: KaggleDeps = { execFn: kaggleAwareExecFn };
  const owner = opts.owner!;

  return {
    existingBatchIds: () => (existsSync(opts.batchesRoot) ? readdirSync(opts.batchesRoot) : []),

    pack: async (batch, maxGb, maxHours, source) => {
      await runPack(
        { source, batch, maxGb, maxHours, allowCustomerSources: false, dryRun: false, batchesRoot: opts.batchesRoot, ffmpegPath: defaultFfmpegPath() },
        db,
      );
      const { entries } = readManifestFile(path.join(opts.batchesRoot, batch));
      const stats = formatPackStats(entries, 0);
      return { files: stats.files, hours: stats.hours, estimatedGb: stats.estimatedGb };
    },

    push: async (batch, isNew) => {
      await pushBatch({ batchDir: path.join(opts.batchesRoot, batch), owner, batch, isNew, confirm: true, dryRun: false }, kaggleDeps);
    },

    run: async (batch, model) => {
      await runBatch(
        {
          notebookDir: HERE,
          batchDir: path.join(opts.batchesRoot, batch),
          owner,
          batch,
          confirm: true,
          dryRun: false,
          // Only pass --model through when it differs from the notebook's own
          // built-in default — no need to stamp+re-version the dataset for
          // the common case.
          model: model === DEFAULT_MODEL ? undefined : model,
        },
        kaggleDeps,
      );
    },

    status: async (batch) => statusBatch(owner, batch, true, kaggleDeps),

    pull: async (batch) => {
      await pullBatch(owner, batch, path.join(opts.batchesRoot, batch, "out"), true, kaggleDeps);
    },

    readLogTail: (batch) => extractLogTail(path.join(opts.batchesRoot, batch, "out")),

    importBatch: async (batch) => {
      const batchDir = path.join(opts.batchesRoot, batch);
      const { entries } = readManifestFile(batchDir);
      const transcriptsFile: TranscriptsFile = JSON.parse(readFileSync(path.join(batchDir, "out", "transcripts.json"), "utf8"));
      const summary = await importBatch(entries, transcriptsFile, batch, { db, ...engineFns });
      return { itemsImported: summary.itemsImported, segments: summary.segments, hours: summary.hours, failures: summary.failures.length };
    },

    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isStopRequested: () => existsSync(opts.stopFile),
    log: (line) => console.log(`[orchestrate ${new Date().toISOString()}] ${line}`),

    // Best-effort live status for the portal. `reportPipelineState` itself
    // never throws (missing table, dead connection, anything) — see
    // yiddish-shared/pipelineState.ts — so this can never take the 80-hour
    // loop down even if YcPipelineState does not exist yet.
    report: (input) =>
      reportPipelineState(db, {
        key: PIPELINE_STATE_KEY,
        kind: "labelling",
        status: input.status,
        headline: input.headline,
        progress: input.progress ?? null,
        detail: input.detail,
        startedAt,
      }).then(() => undefined),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv, HERE);

  if (opts.dryRun) {
    console.log(`[orchestrate] DRY RUN — plan only, nothing will be touched, no --confirm required.`);
    console.log(JSON.stringify(opts, null, 2));
    console.log(
      `[orchestrate] would loop: pack "${opts.source}" into batches capped at ${opts.maxHoursPerBatch}h/${opts.maxGb}GB each, ` +
        `model="${opts.model}", push -> run -> poll -> pull -> import each one, then start the next, ` +
        `until ${opts.hours}h elapsed or no unlabelled audio remains. State file: ${opts.stateFile}. STOP file checked at: ${opts.stopFile}.`,
    );
    return;
  }
  if (!opts.confirm) {
    throw new Error(
      `refusing to run without --confirm (this pushes real batches to Kaggle and starts real GPU kernels, unattended, for up to ${opts.hours} hours)`,
    );
  }
  if (!opts.owner) throw new Error("Kaggle username required: pass --owner or set KAGGLE_USERNAME (public username, never a secret)");

  loadRunnerEnv(HERE);
  mkdirSync(opts.batchesRoot, { recursive: true });

  const engineRoot = opts.engineRoot ? path.resolve(opts.engineRoot) : process.env.YC_ENGINE_ROOT || path.resolve(HERE, "../../apps/api/src/yiddishCorpus");
  const engineFns = await resolveEngineFns(engineRoot);

  const { PrismaClient } = await import("@prisma/client");
  const db: any = new PrismaClient();

  let state = loadStateFile(opts.stateFile) ?? newState(opts, new Date());
  const deps = await buildRealDeps(opts, db, engineFns, state.startedAt);

  try {
    state = await runOrchestrator(opts, state, deps, (s) => saveStateFile(opts.stateFile, s));
  } finally {
    await db.$disconnect();
  }
  console.log(`[orchestrate] stopped — reason=${state.stoppedReason ?? "unknown"}, batches recorded=${state.batches.length}`);
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
    console.error("[orchestrate] fatal", err);
    process.exit(1);
  });
}
