import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { JobRow } from "./db.js";
import { WorkerLock } from "./lockfile.js";

/** Atomically claim the oldest queued job (or return null if none / lost race). */
function claimNextJob(db: Database.Database, now: number, logDir: string): JobRow | null {
  const tx = db.transaction((): JobRow | null => {
    const j = db
      .prepare(
        `SELECT id, service, branch, commit_hash, deployed_commit, requested_by, status,
                created_at, started_at, finished_at, log_path, error_message, dry_run,
                current_stage, skip_reason, duration_ms
         FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
      )
      .get() as JobRow | undefined;
    if (!j) return null;
    const logPath = path.join(logDir, `${j.id}.log`);
    const r = db
      .prepare(
        `UPDATE jobs SET status = 'running', started_at = ?, log_path = ?, error_message = NULL,
                          current_stage = 'queued-picked', skip_reason = NULL, deployed_commit = NULL,
                          duration_ms = NULL
         WHERE id = ? AND status = 'queued'`,
      )
      .run(now, logPath, j.id);
    if (r.changes === 0) return null;
    return {
      ...j,
      status: "running",
      started_at: now,
      log_path: logPath,
      current_stage: "queued-picked",
      skip_reason: null,
      deployed_commit: null,
      duration_ms: null,
    };
  });
  return tx();
}

export type WorkerConfig = {
  db: Database.Database;
  repoRoot: string;
  logDir: string;
  stateDir: string;
  pollMs: number;
};

export type WorkerHandle = {
  /** Call from HTTP enqueue so the worker picks up the new job immediately instead of waiting for the next poll tick. */
  signalEnqueued: () => void;
  stop: () => void;
};

function jobScript(repoRoot: string, service: string): string {
  return path.join(repoRoot, "scripts", `deploy-${service}.sh`);
}

function dryRunEnv(job: JobRow): Record<string, string> {
  return (job.dry_run ?? 0) ? { DEPLOY_DRY_RUN: "1" } : {};
}

function ensureLogDir(logDir: string): void {
  fs.mkdirSync(logDir, { recursive: true });
}

function jobStateFile(stateDir: string, jobId: string): string {
  return path.join(stateDir, `job-${jobId}.state.json`);
}

/**
 * Snapshot the per-job state file written by the deploy script
 * (see `deploy_common_emit_stage` in `scripts/lib/deploy-common.sh`).
 * Missing or partially-written files return null — callers keep the last good value.
 */
function readJobStateFile(stateDir: string, jobId: string): {
  stage?: string;
  skipReason?: string;
  deployedCommit?: string;
} | null {
  const p = jobStateFile(stateDir, jobId);
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const stage = typeof parsed.stage === "string" ? parsed.stage : undefined;
    const skipReason = typeof parsed.skipReason === "string" ? parsed.skipReason : undefined;
    const deployedCommit = typeof parsed.deployedCommit === "string" ? parsed.deployedCommit : undefined;
    if (stage === undefined && skipReason === undefined && deployedCommit === undefined) return null;
    return { stage, skipReason, deployedCommit };
  } catch {
    return null;
  }
}

function applyJobStateToDb(
  db: Database.Database,
  jobId: string,
  state: { stage?: string; skipReason?: string; deployedCommit?: string },
): void {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (state.stage !== undefined) {
    sets.push("current_stage = ?");
    args.push(state.stage);
  }
  if (state.skipReason !== undefined) {
    sets.push("skip_reason = ?");
    args.push(state.skipReason);
  }
  if (state.deployedCommit !== undefined) {
    sets.push("deployed_commit = ?");
    args.push(state.deployedCommit);
  }
  if (!sets.length) return;
  args.push(jobId);
  db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...args);
}

function runDeployScript(
  job: JobRow,
  repoRoot: string,
  logPath: string,
  stateDir: string,
): Promise<{ code: number | null }> {
  const script = jobScript(repoRoot, job.service);
  if (!fs.existsSync(script)) {
    return Promise.resolve({ code: 127 });
  }
  return new Promise((resolve) => {
    const out = fs.openSync(logPath, "a");
    const child = spawn(
      "bash",
      [script],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...dryRunEnv(job),
          DEPLOY_REPO_ROOT: repoRoot,
          DEPLOY_BRANCH: job.branch,
          DEPLOY_COMMIT: job.commit_hash ?? "",
          DEPLOY_REQUESTED_BY: job.requested_by,
          DEPLOY_JOB_ID: job.id,
          DEPLOY_QUEUE_STATE_DIR: stateDir,
        },
        stdio: ["ignore", out, out],
      },
    );
    child.on("close", (code) => {
      try {
        fs.closeSync(out);
      } catch {
        /* noop */
      }
      resolve({ code });
    });
    child.on("error", () => {
      try {
        fs.closeSync(out);
      } catch {
        /* noop */
      }
      resolve({ code: 1 });
    });
  });
}

/**
 * Best-effort log janitor — delete `.log` files under logDir older than
 * `maxAgeMs`, but never remove the log of a queued/running job or a file
 * that was modified in the last hour. Runs on worker start + once per day.
 */
function rotateOldLogs(db: Database.Database, logDir: string, maxAgeMs: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
  } catch {
    return;
  }
  const activeLogs = new Set(
    (
      db
        .prepare(`SELECT log_path FROM jobs WHERE status IN ('queued','running') AND log_path IS NOT NULL`)
        .all() as { log_path: string | null }[]
    )
      .map((r) => (r.log_path ? path.resolve(r.log_path) : null))
      .filter((p): p is string => p != null),
  );
  const cutoff = Date.now() - maxAgeMs;
  const freshCutoff = Date.now() - 60 * 60 * 1000;
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".log")) continue;
    const full = path.resolve(path.join(logDir, ent.name));
    if (activeLogs.has(full)) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    const last = Math.max(st.mtimeMs, st.ctimeMs);
    if (last > cutoff) continue;
    if (last > freshCutoff) continue;
    try {
      fs.unlinkSync(full);
    } catch {
      /* ignore */
    }
  }
}

/** Remove any leftover per-job state files for jobs that are no longer queued/running. */
function rotateStateFiles(db: Database.Database, stateDir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch {
    return;
  }
  const activeIds = new Set(
    (db.prepare(`SELECT id FROM jobs WHERE status IN ('queued','running')`).all() as { id: string }[]).map((r) => r.id),
  );
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const m = /^job-([^.]+)\.state\.json$/.exec(ent.name);
    if (!m) continue;
    if (activeIds.has(m[1])) continue;
    try {
      fs.unlinkSync(path.join(stateDir, ent.name));
    } catch {
      /* ignore */
    }
  }
}

export function startWorkerLoop(cfg: WorkerConfig): WorkerHandle {
  const lock = new WorkerLock(cfg.stateDir);
  try {
    lock.acquire();
  } catch (e) {
    console.error("[deploy-queue] worker lock not acquired — second instance?", e);
    throw e;
  }

  const LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  try {
    ensureLogDir(cfg.logDir);
    rotateOldLogs(cfg.db, cfg.logDir, LOG_MAX_AGE_MS);
    rotateStateFiles(cfg.db, cfg.stateDir);
  } catch {
    /* janitor is best-effort */
  }
  const janitorTimer = setInterval(() => {
    try {
      rotateOldLogs(cfg.db, cfg.logDir, LOG_MAX_AGE_MS);
      rotateStateFiles(cfg.db, cfg.stateDir);
    } catch {
      /* ignore */
    }
  }, 24 * 60 * 60 * 1000);

  let timer: ReturnType<typeof setInterval> | null = null;
  let stageWatcher: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  let stopped = false;
  let immediateTick: ReturnType<typeof setImmediate> | null = null;

  const scheduleTick = (): void => {
    if (stopped || busy || immediateTick) return;
    immediateTick = setImmediate(() => {
      immediateTick = null;
      void tick();
    });
  };

  const tick = async (): Promise<void> => {
    if (busy || stopped) return;
    busy = true;
    try {
      const running = cfg.db
        .prepare(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'running'`)
        .get() as { c: number };
      if (running.c > 0) return;

      const now = Date.now();
      ensureLogDir(cfg.logDir);

      const job = claimNextJob(cfg.db, now, cfg.logDir);
      if (!job) return;

      const logPath = job.log_path as string;
      fs.writeFileSync(
        logPath,
        `=== deploy job ${job.id} service=${job.service} branch=${job.branch} dryRun=${job.dry_run ? "1" : "0"} ===\n`,
        { flag: "a" },
      );

      if (stageWatcher) clearInterval(stageWatcher);
      const startedAt = job.started_at ?? now;
      stageWatcher = setInterval(() => {
        try {
          const st = readJobStateFile(cfg.stateDir, job.id);
          if (st) applyJobStateToDb(cfg.db, job.id, st);
        } catch {
          /* ignore */
        }
      }, 500);

      const row = { ...job, status: "running" as const, log_path: logPath };
      let code: number | null = 1;
      let errMsg: string | null = null;
      try {
        const r = await runDeployScript(row, cfg.repoRoot, logPath, cfg.stateDir);
        code = r.code;
      } catch (e) {
        errMsg = e instanceof Error ? e.message : String(e);
        try {
          fs.appendFileSync(logPath, `\n[worker] exception: ${errMsg}\n`);
        } catch {
          /* noop */
        }
      }

      if (stageWatcher) {
        clearInterval(stageWatcher);
        stageWatcher = null;
      }
      try {
        const finalState = readJobStateFile(cfg.stateDir, job.id);
        if (finalState) applyJobStateToDb(cfg.db, job.id, finalState);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(jobStateFile(cfg.stateDir, job.id));
      } catch {
        /* ignore */
      }

      const done = Date.now();
      const duration = Math.max(0, done - startedAt);
      if (code === 0 && !errMsg) {
        cfg.db
          .prepare(
            `UPDATE jobs SET status = 'success', finished_at = ?, duration_ms = ?,
                             current_stage = COALESCE(current_stage, 'done'), error_message = NULL
             WHERE id = ?`,
          )
          .run(done, duration, job.id);
      } else {
        cfg.db
          .prepare(
            `UPDATE jobs SET status = 'failed', finished_at = ?, duration_ms = ?, error_message = ?
             WHERE id = ?`,
          )
          .run(done, duration, errMsg ?? `deploy script exited with code ${code ?? "null"}`, job.id);
      }
    } finally {
      busy = false;
      if (!stopped) scheduleTick();
    }
  };

  timer = setInterval(() => {
    scheduleTick();
  }, Math.max(250, cfg.pollMs));
  scheduleTick();

  return {
    signalEnqueued: () => {
      scheduleTick();
    },
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (stageWatcher) clearInterval(stageWatcher);
      stageWatcher = null;
      clearInterval(janitorTimer);
      if (immediateTick) {
        clearImmediate(immediateTick);
        immediateTick = null;
      }
      lock.release();
    },
  };
}
