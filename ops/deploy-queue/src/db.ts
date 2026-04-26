import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type DeployService = "api" | "portal" | "telephony" | "realtime";
export type JobStatus = "queued" | "running" | "success" | "failed" | "cancelled";

export type JobRow = {
  id: string;
  service: DeployService;
  branch: string;
  commit_hash: string | null;
  requested_by: string;
  status: JobStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  log_path: string | null;
  error_message: string | null;
};

const SERVICES: DeployService[] = ["api", "portal", "telephony", "realtime"];

export function isDeployService(s: string): s is DeployService {
  return (SERVICES as string[]).includes(s);
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
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_per_service
      ON jobs(service)
      WHERE status IN ('queued','running');
  `);
  return db;
}

export function resetStaleRunning(db: Database.Database, reason: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE jobs SET status = 'failed', finished_at = ?, error_message = ?
     WHERE status = 'running'`,
  ).run(now, reason);
}
