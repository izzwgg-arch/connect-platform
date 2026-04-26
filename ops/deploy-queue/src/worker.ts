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
        `SELECT id, service, branch, commit_hash, requested_by, status,
                created_at, started_at, finished_at, log_path, error_message
         FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
      )
      .get() as JobRow | undefined;
    if (!j) return null;
    const logPath = path.join(logDir, `${j.id}.log`);
    const r = db
      .prepare(
        `UPDATE jobs SET status = 'running', started_at = ?, log_path = ?, error_message = NULL
         WHERE id = ? AND status = 'queued'`,
      )
      .run(now, logPath, j.id);
    if (r.changes === 0) return null;
    return { ...j, status: "running", started_at: now, log_path: logPath };
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

function jobScript(repoRoot: string, service: string): string {
  return path.join(repoRoot, "scripts", `deploy-${service}.sh`);
}

function ensureLogDir(logDir: string): void {
  fs.mkdirSync(logDir, { recursive: true });
}

function runDeployScript(
  job: JobRow,
  repoRoot: string,
  logPath: string,
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
          DEPLOY_REPO_ROOT: repoRoot,
          DEPLOY_BRANCH: job.branch,
          DEPLOY_COMMIT: job.commit_hash ?? "",
          DEPLOY_REQUESTED_BY: job.requested_by,
          DEPLOY_JOB_ID: job.id,
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

export function startWorkerLoop(cfg: WorkerConfig): () => void {
  const lock = new WorkerLock(cfg.stateDir);
  try {
    lock.acquire();
  } catch (e) {
    console.error("[deploy-queue] worker lock not acquired — second instance?", e);
    throw e;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;

  const tick = async () => {
    if (busy) return;
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
        `=== deploy job ${job.id} service=${job.service} branch=${job.branch} ===\n`,
        { flag: "a" },
      );

      const row = { ...job, status: "running" as const, log_path: logPath };
      let code: number | null = 1;
      let errMsg: string | null = null;
      try {
        const r = await runDeployScript(row, cfg.repoRoot, logPath);
        code = r.code;
      } catch (e) {
        errMsg = e instanceof Error ? e.message : String(e);
        try {
          fs.appendFileSync(logPath, `\n[worker] exception: ${errMsg}\n`);
        } catch {
          /* noop */
        }
      }
      const done = Date.now();
      if (code === 0 && !errMsg) {
        cfg.db
          .prepare(`UPDATE jobs SET status = 'success', finished_at = ?, error_message = NULL WHERE id = ?`)
          .run(done, job.id);
      } else {
        cfg.db
          .prepare(
            `UPDATE jobs SET status = 'failed', finished_at = ?, error_message = ? WHERE id = ?`,
          )
          .run(done, errMsg ?? `deploy script exited with code ${code ?? "null"}`, job.id);
      }
    } finally {
      busy = false;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, cfg.pollMs);

  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    lock.release();
  };
}
