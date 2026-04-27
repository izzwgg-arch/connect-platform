import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** Queue targets (maps to scripts/deploy-<name>.sh with hyphens preserved). */
export type DeployService = "api" | "portal" | "telephony" | "realtime" | "worker" | "full-stack";
export type JobStatus = "queued" | "running" | "success" | "failed" | "cancelled";

export type JobRow = {
  id: string;
  service: DeployService;
  branch: string;
  commit_hash: string | null;
  /** SHA the deploy script actually checked out (may differ from requested commit_hash when branch was passed). */
  deployed_commit: string | null;
  requested_by: string;
  status: JobStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  log_path: string | null;
  error_message: string | null;
  dry_run: number;
  /** Coarse-grained stage the worker last observed from the deploy script's state file. */
  current_stage: string | null;
  /** If non-null on a successful job, the script short-circuited (e.g. `no_changes`, `unrelated_paths`). */
  skip_reason: string | null;
  /** started_at → finished_at difference, cached at completion for easy querying. */
  duration_ms: number | null;
  /** 'auto' = enqueued by agent/system; 'manual' = enqueued via UI or authenticated admin call. */
  source: "auto" | "manual";
};

export const DEPLOY_SERVICES: DeployService[] = [
  "api",
  "portal",
  "telephony",
  "realtime",
  "worker",
  "full-stack",
];

export function isDeployService(s: string): s is DeployService {
  return (DEPLOY_SERVICES as string[]).includes(s);
}

function migrateJobsTable(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("dry_run")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has("current_stage")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN current_stage TEXT`);
  }
  if (!names.has("skip_reason")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN skip_reason TEXT`);
  }
  if (!names.has("deployed_commit")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN deployed_commit TEXT`);
  }
  if (!names.has("duration_ms")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN duration_ms INTEGER`);
  }
  if (!names.has("source")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
  }
}

export function openQueueDb(filePath: string): Database.Database {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY NOT NULL,
      service TEXT NOT NULL,
      branch TEXT NOT NULL,
      commit_hash TEXT,
      requested_by TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      log_path TEXT,
      error_message TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
      current_stage TEXT,
      skip_reason TEXT,
      deployed_commit TEXT,
      duration_ms INTEGER,
      source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_per_service
      ON jobs(service)
      WHERE status IN ('queued','running');
  `);
  migrateJobsTable(db);
  return db;
}

export function resetStaleRunning(db: Database.Database, reason: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE jobs SET status = 'failed', finished_at = ?, error_message = ?
     WHERE status = 'running'`,
  ).run(now, reason);
}

export function countQueued(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'queued'`).get() as { c: number };
  return row.c;
}
