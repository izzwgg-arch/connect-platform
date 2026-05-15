import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMIT_ALREADY_DEPLOYED_LOOKUP_SQL,
  shouldSkipCommitAlreadyDeployed,
  type DeployQueueDbForCommitSkip,
} from "./commitSkip.js";

test("lookup SQL requires non-dry-run successes only", () => {
  assert.match(COMMIT_ALREADY_DEPLOYED_LOOKUP_SQL, /IFNULL\(dry_run,\s*0\)\s*=\s*0/);
  assert.match(COMMIT_ALREADY_DEPLOYED_LOOKUP_SQL, /status\s*=\s*'success'/);
});

test("no prior real deploy row => do not skip", () => {
  const db: DeployQueueDbForCommitSkip = {
    prepare: (sql) => {
      assert.equal(sql, COMMIT_ALREADY_DEPLOYED_LOOKUP_SQL);
      return { get: () => undefined };
    },
  };
  assert.equal(shouldSkipCommitAlreadyDeployed(db, "api", "aaa000000000000000000000000000000000000"), false);
});

test("last real deploy matches requested SHA => skip", () => {
  const sha = "bbb000000000000000000000000000000000000";
  const db: DeployQueueDbForCommitSkip = {
    prepare: () => ({
      get: () => ({ deployed_commit: sha }),
    }),
  };
  assert.equal(shouldSkipCommitAlreadyDeployed(db, "api", sha), true);
});

test("last real deploy is different SHA => do not skip (e.g. dry-run newer or older real)", () => {
  const shaX = "ccc000000000000000000000000000000000000";
  const shaY = "ddd000000000000000000000000000000000000";
  const db: DeployQueueDbForCommitSkip = {
    prepare: () => ({
      get: () => ({ deployed_commit: shaY }),
    }),
  };
  assert.equal(shouldSkipCommitAlreadyDeployed(db, "api", shaX), false);
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
