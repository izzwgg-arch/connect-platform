/**
 * deploySkipGuard.test.ts — a deploy may only report "no changes" when it
 * actually knows what is deployed.
 *
 * ⛔⛔ THE FAILURE, on production, 2026-09-16. `scripts/deploy-direct.sh api
 * --commit <sha>` printed:
 *
 *     [deploy-api] checkout advanced cd0d4e4c→617154b8; re-exec deploy-api.sh …
 *     [deploy-common] skip=no_changes
 *     [deploy-api] deployed commit already at 617154b8 — skipping install/build/restart
 *     [deploy-direct] success
 *
 * and shipped NOTHING. The container kept serving the old code; the new module
 * was simply absent from the image. It was only caught because the deploy was
 * verified against the running container instead of believing the word
 * "success".
 *
 * Why it happened: `OLD_HEAD="${PERSISTED_OLD_HEAD:-$PRE_SYNC_HEAD}"`.
 * `DEPLOY_QUEUE_STATE_DIR` was unset (so no marker) AND `/app/.build-commit` in
 * the running container was 1 byte — a bare newline — so the fallback produced
 * an empty string too. OLD_HEAD then degenerated to PRE_SYNC_HEAD, which the
 * re-exec had ALREADY advanced to the new commit. The script compared the new
 * commit against itself and skipped.
 *
 * ⛔ An unknown baseline must mean BUILD, never SKIP. A wasted rebuild costs
 * minutes; a false skip costs a person believing a fix is live when it is not —
 * which is the whole reason "container-verified" is a rule in this repo.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.env.PORTAL_GUARD_ROOT || path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

for (const script of ["scripts/deploy-api.sh", "scripts/deploy-portal.sh"]) {
  test(`⛔ ${script} refuses a no_changes skip when the deployed commit is unknown`, () => {
    const src = read(script);

    const skipAt = src.indexOf('deploy_common_emit_skip "no_changes"');
    assert.ok(skipAt > 0, "the no_changes skip must exist");

    /* The skip has to sit INSIDE a branch that first proves we know what is
       deployed. Take the change-detect block and require the guard in it. */
    const detectAt = src.indexOf('deploy_common_emit_stage "change-detect"');
    assert.ok(detectAt > 0 && detectAt < skipAt, "change-detect must precede the skip");
    const block = src.slice(detectAt, skipAt);

    assert.ok(
      /if\s+\[\[\s+-z\s+"\$PERSISTED_OLD_HEAD"\s+\]\]/.test(block),
      "the skip must be guarded by an empty-PERSISTED_OLD_HEAD check — an unknown baseline means build",
    );
    assert.ok(
      /refusing to skip/.test(block),
      "and it must say out loud that it is refusing to skip, so the log shows why it rebuilt",
    );
  });

  test(`${script} still prefers the real record of what is deployed`, () => {
    const src = read(script);
    assert.ok(
      src.includes("deploy_common_last_deployed_commit"),
      "the state-dir marker is the primary source",
    );
    assert.ok(
      src.includes("/app/.build-commit"),
      "the running container's stamp is the fallback",
    );
    assert.ok(
      src.includes('OLD_HEAD="${PERSISTED_OLD_HEAD:-$PRE_SYNC_HEAD}"'),
      "the checkout HEAD stays the last resort — but it can no longer produce a skip on its own",
    );
  });
}
