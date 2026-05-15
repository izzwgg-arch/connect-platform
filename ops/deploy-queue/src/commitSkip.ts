import type { DeployService } from "./db.js";

/** Minimal DB shape used by {@link shouldSkipCommitAlreadyDeployed} (`better-sqlite3` satisfies this). */
export type DeployQueueDbForCommitSkip = {
  prepare: (sql: string) => { get: (service: string) => unknown };
};

/** SQL: last successful real job's resolved pin — prefers deployed_commit, else commit_hash (legacy rows). */
export const COMMIT_ALREADY_DEPLOYED_LOOKUP_SQL = `SELECT COALESCE(NULLIF(TRIM(deployed_commit), ''), commit_hash) AS resolved
       FROM jobs
       WHERE service = ? AND status = 'success' AND IFNULL(dry_run, 0) = 0
       ORDER BY finished_at DESC LIMIT 1`;

/**
 * Whether a new enqueue with `commitHash` should short-circuit as `commit_already_deployed`.
 * Only successful **real** deploys (`dry_run = 0`) are considered — dry-run successes must never
 * block a live rollout. Matching uses the last job's checkout/requested SHA (`deployed_commit`, or
 * `commit_hash` when `deployed_commit` was not recorded).
 */
export function shouldSkipCommitAlreadyDeployed(
  db: DeployQueueDbForCommitSkip,
  service: DeployService,
  commitHash: string,
): boolean {
  const trimmed = commitHash.trim();
  if (!trimmed) return false;
  const row = db.prepare(COMMIT_ALREADY_DEPLOYED_LOOKUP_SQL).get(service) as
    | { resolved: string | null }
    | undefined;
  const resolved = row?.resolved != null ? String(row.resolved).trim() : "";
  if (!resolved) return false;
  return resolved === trimmed;
}

