#!/usr/bin/env -S npx tsx
/**
 * Poll a running Kaggle training kernel and mirror its real state into
 * `YcPipelineState`, so the portal's Yiddish pipeline page shows what the
 * training run is ACTUALLY doing instead of the one-shot "running" that
 * `auto-launch-training.sh` writes at launch and never updates.
 *
 * ⛔ Why this exists: on 2026-09-18 three consecutive training runs died
 * (dataset not attached, fp16 double-applied, then a renamed `dtype=` kwarg)
 * while the portal still said "Training kernel running on Kaggle". A status
 * row that cannot go wrong is not a status row — it is a decoration. This
 * watcher writes `done` on COMPLETE, `error` on ERROR (with the last real
 * error lines from the kernel log in `detail`, so the failure is readable in
 * the portal without pulling the log by hand), and keeps `running` fresh with
 * an elapsed-minutes headline in between.
 *
 * Usage (normally started right after a kernel-push):
 *   npx tsx watch-training.ts --key training.run.v1 --confirm [--every 300]
 *
 * It exits 0 as soon as the kernel reaches a terminal state, so it can be
 * chained after `kaggle-run.ts kernel-push` in an unattended script.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadRunnerEnv } from "./build-dataset";
import { reportPipelineState } from "../yiddish-shared/pipelineState";
import { DEFAULT_KERNEL_SLUG, kernelStatus, kernelDownload } from "./kaggle-run";

const HERE = __dirname;

/** Kaggle reports e.g. `has status "KernelWorkerStatus.COMPLETE"`. */
export type TerminalKind = "running" | "done" | "error";

export function classifyKernelStatus(raw: string): { kind: TerminalKind; state: string } {
  const m = raw.match(/KernelWorkerStatus\.([A-Z_]+)/);
  const state = (m ? m[1] : raw.trim()).toUpperCase();
  if (state === "COMPLETE") return { kind: "done", state };
  if (state === "ERROR" || state === "CANCEL_ACKNOWLEDGED" || state === "CANCELLED") return { kind: "error", state };
  return { kind: "running", state };
}

/**
 * Pull the lines worth showing a human out of a Kaggle kernel log. The raw log
 * is a JSON array of `{stream_name, data}` records, dominated by tqdm progress
 * repaints — keeping those would bury the one line that says what broke.
 */
export function errorLinesFromKernelLog(logJson: string, limit = 12): string[] {
  let rows: Array<{ data?: string }> = [];
  try {
    rows = JSON.parse(logJson);
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const r of rows) {
    for (const line of String(r?.data ?? "").split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      if (s.includes("examples/s") || s.includes("it/s]") || s.includes("B/s")) continue;
      lines.push(s.slice(0, 300));
    }
  }
  const useful = lines.filter((l) => !l.startsWith("[NbConvertApp]"));
  // ⛔ The TAIL of a Kaggle log is papermill re-raising the notebook cell's
  // CalledProcessError — true, useless, and identical for every failure. The
  // line that says what actually broke is in the FIRST traceback, so take that
  // block (run v6 tailed "returned non-zero exit status 1" while the real
  // cause, "element 0 of tensors does not require grad", sat 80 lines earlier).
  const start = useful.findIndex((l) => l.startsWith("Traceback (most recent call last)"));
  if (start >= 0) {
    const end = useful.findIndex((l, i) => i > start && /^[A-Za-z_.]*(Error|Exception)\b.*:/.test(l));
    if (end > start) return useful.slice(Math.max(start, end - limit + 1), end + 1);
  }
  return useful.slice(-limit);
}

function argVal(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (!argv.includes("--confirm")) throw new Error("refusing to run without --confirm (this polls the Kaggle API)");
  const key = argVal(argv, "--key") ?? "training.run.v1";
  const owner = argVal(argv, "--owner") ?? process.env.KAGGLE_USERNAME ?? "izzywein";
  const kernelSlug = argVal(argv, "--kernel-slug") ?? DEFAULT_KERNEL_SLUG;
  const everySec = Number(argVal(argv, "--every") ?? 300);
  const kernelRef = `${owner}/${kernelSlug}`;

  loadRunnerEnv(HERE);
  let db: any = null;
  try {
    const { PrismaClient } = await import("@prisma/client");
    db = new PrismaClient();
  } catch (e: any) {
    console.error(`[watch-training] no Prisma client (${e?.message || e}); will still poll and log`);
  }

  const startedAt = Date.now();
  const report = async (status: "running" | "done" | "error", headline: string, detail?: unknown) => {
    if (!db) return;
    await reportPipelineState(db, { key, kind: "training", status, headline, detail });
  };

  try {
    for (;;) {
      const raw = await kernelStatus(owner, kernelSlug, true, {});
      const { kind, state } = classifyKernelStatus(raw);
      const mins = Math.round((Date.now() - startedAt) / 60000);
      console.log(`[watch-training ${new Date().toISOString()}] ${state} (${mins}m)`);

      if (kind === "running") {
        await report("running", `Training on Kaggle's free GPU — ${state.toLowerCase()} for ${mins} minute(s).`, {
          kernelRef,
          kernelState: state,
          elapsedMinutes: mins,
        });
      } else if (kind === "done") {
        await report("done", `Training finished on Kaggle after ${mins} minute(s).`, { kernelRef, kernelState: state, elapsedMinutes: mins });
        console.log("[watch-training] COMPLETE");
        break;
      } else {
        // Pull the log so the portal can show WHY, not just that it failed.
        let errorLines: string[] = [];
        try {
          const out = path.join(HERE, "kernel-log");
          await kernelDownload(owner, kernelSlug, out, true, {});
          const { readFileSync, readdirSync } = await import("node:fs");
          const logFile = readdirSync(out).find((f) => f.endsWith(".log"));
          if (logFile) errorLines = errorLinesFromKernelLog(readFileSync(path.join(out, logFile), "utf8"));
        } catch (e: any) {
          errorLines = [`(could not read the kernel log: ${e?.message || e})`];
        }
        await report("error", `Training failed on Kaggle after ${mins} minute(s) — ${errorLines[errorLines.length - 1] ?? state}`, {
          kernelRef,
          kernelState: state,
          elapsedMinutes: mins,
          errorLines,
        });
        console.log(`[watch-training] ERROR:\n${errorLines.join("\n")}`);
        break;
      }
      await new Promise((r) => setTimeout(r, everySec * 1000));
    }
  } finally {
    try {
      await db?.$disconnect();
    } catch {
      /* a disconnect failure must not change this process's exit code */
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
    console.error(`[watch-training] ${err?.message || err}`);
    process.exit(1);
  });
}
