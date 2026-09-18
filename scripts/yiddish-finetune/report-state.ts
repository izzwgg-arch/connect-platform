#!/usr/bin/env -S npx tsx
/**
 * Tiny CLI wrapper around `reportPipelineState` for callers that are shell
 * scripts, not TypeScript — today just `auto-launch-training.sh`, which has
 * no other way to write a `YcPipelineState` row at each of its own stages
 * (waiting for clips / uploading the dataset / kernel running / error).
 *
 * Usage:
 *   npx tsx report-state.ts --key training.run.v1 --kind training \
 *     --status running --headline "Uploading the training dataset to Kaggle." \
 *     [--current 3 --total 10 --unit clips] \
 *     [--detail-json '{"kernelRef":"izzywein/loopcom-yiddish-whisper-finetune"}']
 *
 * Loads `DATABASE_URL` from `../yiddish-runner/.env` the same way every other
 * script in this repo does (`loadEnvFile`, never overwriting an already-set
 * env var). Never throws on a reporting failure — `reportPipelineState`
 * itself is fail-closed (see `../yiddish-shared/pipelineState.ts`), so a
 * missing `YcPipelineState` table or a dead DB connection prints one line to
 * stderr and this still exits 0, never aborting the calling shell script's
 * `set -uo pipefail` run over a status write that was never load-bearing.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadEnvFile } from "./build-dataset";
import { pctOf, reportPipelineState, type PipelineKind, type PipelineStatus } from "../yiddish-shared/pipelineState";

const HERE = __dirname;

function argVal(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function requireArg(argv: string[], flag: string): string {
  const v = argVal(argv, flag);
  if (!v) throw new Error(`${flag} is required`);
  return v;
}

const VALID_KINDS: PipelineKind[] = ["labelling", "dataset", "training", "runner"];
const VALID_STATUSES: PipelineStatus[] = ["running", "idle", "done", "error"];

export function parseReportArgs(argv: string[]): {
  key: string;
  kind: PipelineKind;
  status: PipelineStatus;
  headline: string;
  progress: { current: number; total: number; unit: string; pct: number } | null;
  detail: unknown;
} {
  const key = requireArg(argv, "--key");
  const kindRaw = requireArg(argv, "--kind");
  const statusRaw = requireArg(argv, "--status");
  const headline = requireArg(argv, "--headline");
  if (!VALID_KINDS.includes(kindRaw as PipelineKind)) {
    throw new Error(`--kind must be one of ${VALID_KINDS.join(", ")} (got "${kindRaw}")`);
  }
  if (!VALID_STATUSES.includes(statusRaw as PipelineStatus)) {
    throw new Error(`--status must be one of ${VALID_STATUSES.join(", ")} (got "${statusRaw}")`);
  }

  const currentRaw = argVal(argv, "--current");
  const totalRaw = argVal(argv, "--total");
  const unit = argVal(argv, "--unit") ?? "items";
  let progress: { current: number; total: number; unit: string; pct: number } | null = null;
  if (currentRaw !== undefined && totalRaw !== undefined) {
    const current = Number(currentRaw);
    const total = Number(totalRaw);
    progress = { current, total, unit, pct: pctOf(current, total) };
  }

  const detailJson = argVal(argv, "--detail-json");
  let detail: unknown = undefined;
  if (detailJson !== undefined) {
    try {
      detail = JSON.parse(detailJson);
    } catch (e: any) {
      throw new Error(`--detail-json is not valid JSON: ${e?.message || String(e)}`);
    }
  }

  return { key, kind: kindRaw as PipelineKind, status: statusRaw as PipelineStatus, headline, progress, detail };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const input = parseReportArgs(argv);

  loadEnvFile(path.join(HERE, "..", "yiddish-runner", ".env"));

  let db: any = null;
  try {
    const { PrismaClient } = await import("@prisma/client");
    db = new PrismaClient();
  } catch (e: any) {
    // No Prisma client available at all — still never crash the calling
    // shell script over a best-effort status write.
    console.error(`[report-state] could not construct a Prisma client: ${e?.message || String(e)}`);
    return;
  }

  try {
    const ok = await reportPipelineState(db, {
      key: input.key,
      kind: input.kind,
      status: input.status,
      headline: input.headline,
      progress: input.progress,
      detail: input.detail,
    });
    if (!ok) console.error(`[report-state] reportPipelineState returned false for key="${input.key}" (see the one-time warning above, if any)`);
  } finally {
    try {
      await db.$disconnect();
    } catch {
      // never let a disconnect failure surface as a non-zero exit either
    }
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
    // A bad CLI invocation (missing/invalid flags) IS worth surfacing loudly
    // — that is a caller bug, not a "DB might be unavailable" situation.
    console.error("[report-state] fatal", err);
    process.exit(1);
  });
}
