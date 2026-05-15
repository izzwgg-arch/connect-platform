import type { DeployService } from "./db.js";

/** Minimal DB shape used by {@link shouldSkipCommitAlreadyDeployed} (`better-sqlite3` satisfies this). */
export type DeployQueueDbForCommitSkip = {
  prepare: (sql: string) => { get: (service: string) => unknown };
};

/** SQL used for commit pin skip — dry-run rows must be excluded (`dry_run = 0` only). */
export const COMMIT_ALREADY_DEPLOYED_LOOKUP_SQL = `SELECT deployed_commit FROM jobs
       WHERE service = ? AND status = 'success' AND IFNULL(dry_run, 0) = 0
       ORDER BY finished_at DESC LIMIT 1`;

/**
 * Whether a new enqueue with `commitHash` should short-circuit as `commit_already_deployed`.
 * Only successful **real** deploys (`dry_run = 0`) are considered — dry-run successes must never
 * block a live rollout.
 */
export function shouldSkipCommitAlreadyDeployed(
  db: DeployQueueDbForCommitSkip,
  service: DeployService,
  commitHash: string,
): boolean {
  const trimmed = commitHash.trim();
  if (!trimmed) return false;
  const row = db.prepare(COMMIT_ALREADY_DEPLOYED_LOOKUP_SQL).get(service) as
    | { deployed_commit: string | null }
    | undefined;
  return row?.deployed_commit === trimmed;
}

