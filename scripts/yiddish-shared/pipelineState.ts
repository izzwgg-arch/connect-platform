/**
 * Loopcom Yiddish pipeline — live status reporting into `YcPipelineState`.
 *
 * The labelling orchestrator, the dataset builder and the training launcher
 * all run OFF the server (Izzy's PC + Kaggle), so the server database is the
 * only thing the portal can read to show "what is the agent doing right
 * now". Each of those processes calls `reportPipelineState()` at its own
 * state transitions to upsert one row per `key` into `YcPipelineState`.
 *
 * ⛔ A parallel agent owns the `YcPipelineState` Prisma model + migration
 * (see the task brief). At the time this file was written the model may not
 * exist yet in whatever generated Prisma client a caller's `db` was built
 * from, so every call here goes through `(db as any).ycPipelineState` and is
 * wrapped in try/catch. This module must NEVER throw — the orchestrator is a
 * live 80-hour unattended job and a status-reporting call is not allowed to
 * take it down, whether the table is simply missing, the DB connection is
 * momentarily down, or anything else goes wrong writing this one row.
 *
 * Logging discipline: a failure is logged to console.error AT MOST ONCE per
 * process (tracked per `key`, since a long-lived orchestrator process may
 * report several distinct keys — though today it only ever uses one). A
 * process that reports every few seconds for 80 hours must never turn one
 * missing table into a wall of repeated log spam.
 */

export type PipelineKind = "labelling" | "dataset" | "training" | "runner";
export type PipelineStatus = "running" | "idle" | "done" | "error";

export interface PipelineProgress {
  current: number;
  total: number;
  unit: string;
  /** 0-100, rounded. Always present once `progress` is given — computed by
   * the caller via `pctOf`, or supplied directly. */
  pct: number;
}

export interface ReportPipelineStateInput {
  /** Unique key identifying this process, e.g. "labelling.orchestrator",
   * "dataset.build.v1", "training.run.v1". One row per key. */
  key: string;
  kind: PipelineKind;
  status: PipelineStatus;
  /** ONE plain-English sentence — what it is doing RIGHT NOW, written for
   * the owner, not a log line. */
  headline: string;
  progress?: PipelineProgress | null;
  /** Free-form JSON detail: batch id, kernel ref, log tail, final counts,
   * error reason, etc. — whatever is most useful for this transition. */
  detail?: unknown;
  /** ISO timestamp for when THIS run/batch/job started (not when the row was
   * first created) — lets the portal show "running since". Optional; when
   * omitted the upsert leaves any existing `startedAt` alone on update, and
   * sets it to "now" on first insert. */
  startedAt?: string;
}

/**
 * `current`/`total` -> a rounded 0-100 percentage. Never throws or returns
 * NaN/Infinity on a degenerate input:
 *   - total <= 0            -> 0 (nothing to divide by; not "unknown", just 0)
 *   - current > total       -> 100 (clamped, e.g. a recount after a retry)
 *   - current < 0           -> 0 (clamped)
 *   - non-finite current/total -> 0
 */
export function pctOf(current: number, total: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return 0;
  const raw = (current / total) * 100;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** Convenience: build a `PipelineProgress` with `pct` computed via `pctOf`. */
export function progressOf(current: number, total: number, unit: string): PipelineProgress {
  return { current, total, unit, pct: pctOf(current, total) };
}

// One-log-per-key-per-process guard. Module-level so it survives across
// many `reportPipelineState` calls in the same long-running process, and is
// keyed so a process that legitimately reports multiple pipeline keys still
// gets one warning per key, not one warning total.
const warnedKeys = new Set<string>();

/** Test-only: lets a test re-arm the one-log-per-key guard between cases
 * without needing a fresh process. Not used by any real caller. */
export function _resetPipelineStateWarnings(): void {
  warnedKeys.clear();
}

/**
 * Idempotent upsert on `key`. NEVER throws — every failure (missing table,
 * missing `db.ycPipelineState`, a rejected query, a bad `detail` that can't
 * serialize, anything) is swallowed here, logged at most once per `key` per
 * process, and returns `false` so a caller MAY note it happened without
 * being forced to.
 */
export async function reportPipelineState(db: unknown, input: ReportPipelineStateInput): Promise<boolean> {
  try {
    const model = (db as any)?.ycPipelineState;
    if (!model || typeof model.upsert !== "function") {
      throw new Error("db.ycPipelineState is not available (model missing from this Prisma client / not migrated yet)");
    }
    const nowIso = new Date().toISOString();
    const progress = input.progress ?? null;
    const detail = input.detail ?? null;

    await model.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        kind: input.kind,
        status: input.status,
        headline: input.headline,
        progress,
        detail,
        startedAt: input.startedAt ?? nowIso,
      },
      update: {
        kind: input.kind,
        status: input.status,
        headline: input.headline,
        progress,
        detail,
        ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      },
    });
    return true;
  } catch (err: any) {
    if (!warnedKeys.has(input.key)) {
      warnedKeys.add(input.key);
      // eslint-disable-next-line no-console
      console.error(
        `[pipelineState] could not report status for key="${input.key}" (further failures for this key will be silent for the ` +
          `rest of this process): ${err?.message || String(err)}`,
      );
    }
    return false;
  }
}
