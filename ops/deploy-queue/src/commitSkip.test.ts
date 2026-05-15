import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMIT_ALREADY_DEPLOYED_LOOKUP_SQL,
  shouldSkipCommitAlreadyDeployed,
  type DeployQueueDbForCommitSkip,
} from "./commitSkip.js";

test("lookup SQL excludes dry-run, success only, and coalesces deployed_commit with commit_hash", () => {
  assert.match(COMMIT_ALREADY_DEPLOYED_LOOKUP_SQL, /IFNULL\(dry_run,\s*0\)\s*=\s*0/);
  assert.match(COMMIT_ALREADY_DEPLOYED_LOOKUP_SQL, /status\s*=\s*'success'/);
  assert.match(COMMIT_ALREADY_DEPLOYED_LOOKUP_SQL, /COALESCE\s*\(\s*NULLIF\s*\(\s*TRIM\s*\(\s*deployed_commit\s*\)/);
  assert.match(COMMIT_ALREADY_DEPLOYED_LOOKUP_SQL, /commit_hash/);
});

test("no qualifying prior real success row => do not skip (includes history that is dry-run-only)", () => {
  const db: DeployQueueDbForCommitSkip = {
    prepare: (sql) => {
      assert.equal(sql, COMMIT_ALREADY_DEPLOYED_LOOKUP_SQL);
      return { get: () => undefined };
    },
  };
  assert.equal(shouldSkipCommitAlreadyDeployed(db, "api", "aaa000000000000000000000000000000000000"), false);
});

test("last real success resolved SHA matches requested => skip (COALESCE path: deployed_commit or commit_hash)", () => {
  const sha = "bbb000000000000000000000000000000000000";
  const db: DeployQueueDbForCommitSkip = {
    prepare: () => ({
      get: () => ({ resolved: sha }),
    }),
  };
  assert.equal(shouldSkipCommitAlreadyDeployed(db, "api", sha), true);
});

test("last real success is different SHA => do not skip", () => {
  const shaX = "ddd000000000000000000000000000000000000";
  const shaY = "eee000000000000000000000000000000000000";
  const db: DeployQueueDbForCommitSkip = {
    prepare: () => ({
      get: () => ({ resolved: shaY }),
    }),
  };
  assert.equal(shouldSkipCommitAlreadyDeployed(db, "api", shaX), false);
});

test("prepare binds service (portal history must not satisfy api skip)", () => {
  const sha = "fff000000000000000000000000000000000000";
  const db: DeployQueueDbForCommitSkip = {
    prepare: (sql) => {
      assert.equal(sql, COMMIT_ALREADY_DEPLOYED_LOOKUP_SQL);
      return {
        get: (svc: string) => {
          assert.equal(svc, "api");
          return { resolved: sha };
        },
      };
    },
  };
  assert.equal(shouldSkipCommitAlreadyDeployed(db, "api", sha), true);
});

test("resolved commit null or empty => do not skip", () => {
  const db1: DeployQueueDbForCommitSkip = {
    prepare: () => ({ get: () => ({ resolved: null }) }),
  };
  assert.equal(shouldSkipCommitAlreadyDeployed(db1, "api", "abc000000000000000000000000000000000000"), false);
  const db2: DeployQueueDbForCommitSkip = {
    prepare: () => ({ get: () => ({ resolved: "  " }) }),
  };
  assert.equal(shouldSkipCommitAlreadyDeployed(db2, "api", "abc000000000000000000000000000000000000"), false);
});

test("empty commit hash => do not skip", () => {
  const db: DeployQueueDbForCommitSkip = {
    prepare: () => ({
      get: () => {
        throw new Error("prepare should not run for empty hash");
      },
    }),
  };
  assert.equal(shouldSkipCommitAlreadyDeployed(db, "api", "   "), false);
});
