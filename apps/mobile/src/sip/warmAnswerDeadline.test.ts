/**
 * Regression tests for the WARM answer budget.
 *
 * ⛔⛔ THE OUTAGE THESE LOCK DOWN (2026-08-23, Create A Box ext 102)
 * ------------------------------------------------------------------
 * `83a5728c` set `backendClaimed = true` on the warm answer path. That flag is
 * NOT bookkeeping — it selects which answer branch runs, and only the warm
 * branch (`if (!backendClaimed)`) extends the answer deadline. Setting it routed
 * the warm answer into the COLD branch, which answers on the deadline it was
 * handed: `MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS` = 150 ms. That collapses the
 * per-attempt cap to its 500 ms floor and `MAX_ATTEMPTS = 3` to ONE attempt —
 * after which the pipeline runs `rejectIncomingInvite()` + `hangup()`.
 *
 * Live result: three answers dead at 641 / 745 / 694 ms, one of them a call
 * Asterisk had already bridged (the app tore down its own live call 280 ms
 * later). Full detail:
 * docs/ai-context/AGENT_HANDOFF_WARM_ANSWER_DEADLINE_2026-08-23.md
 *
 * ⛔ WHY THE EXISTING SUITE COULD NOT SEE IT: `answerAttemptBudget.test.ts` and
 * `mobileAnswerTiming.test.ts` build every deadline from
 * `MOBILE_SIP_ANSWER_INITIAL_WAIT_MS` (8 s). Before this file,
 * `MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS` appeared in NO test in the repo — and it
 * is the only value the warm answer path actually runs on.
 *
 * Run: pnpm --filter @connect/mobile test:warm-answer
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MOBILE_SIP_ANSWER_ATTEMPT_TIMEOUT_MS,
  MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS,
  MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS,
  createSipAnswerDeadline,
} from "./mobileAnswerTiming.js";

/** Mirrors the per-attempt cap computed inside jssip.ts `answerIncoming()`. */
const attemptCap = (remainingMs: number): number =>
  Math.max(500, Math.min(MOBILE_SIP_ANSWER_ATTEMPT_TIMEOUT_MS, remainingMs));

/**
 * Walks `answerIncoming()`'s loop the way it really runs: it enters ~88 ms after
 * the tap (measured on the live failures) and each attempt costs its cap plus
 * the 40 ms inter-attempt wait.
 */
function attemptsThatFit(deadlineUntilMs: number, tapAtMs: number): number {
  let now = tapAtMs + 88;
  let attempts = 0;
  while (now < deadlineUntilMs && attempts < 3) {
    now += attemptCap(deadlineUntilMs - now) + 40;
    attempts += 1;
  }
  return attempts;
}

test("the pre-claim window is far too small to answer on — it is a claim grace, not a budget", () => {
  const tap = Date.now();
  const { handle } = createSipAnswerDeadline(tap, MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS);

  // This is the state the outage shipped in. Asserted so nobody "simplifies" the
  // warm path back onto this deadline believing it is survivable.
  assert.equal(handle.getUntilMs() - tap, MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS);
  assert.equal(attemptsThatFit(handle.getUntilMs(), tap), 1);
  assert.equal(attemptCap(handle.getUntilMs() - (tap + 88)), 500);
});

test("the warm path's extended deadline restores 4 s x 3 attempts", () => {
  const tap = Date.now();
  const { handle } = createSipAnswerDeadline(tap, MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS);
  handle.extend(MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS);

  assert.equal(
    attemptCap(handle.getUntilMs() - (tap + 88)),
    MOBILE_SIP_ANSWER_ATTEMPT_TIMEOUT_MS,
    "first attempt must get the full 4 s, not the 500 ms floor",
  );
  assert.equal(attemptsThatFit(handle.getUntilMs(), tap), 3);
});

test("500 ms cannot cover a real answer round trip; 4 s can", () => {
  // Create A Box ext 102 measures ~304 ms one way to the PBX, and the device's
  // own createAnswer/setLocalDescription/ICE work runs before the 200 OK is even
  // sent. His two most recent SUCCESSFUL answers took 636 ms and 2,644 ms from
  // tap to connected — both over the 500 ms the broken build allowed.
  const OBSERVED_SUCCESSFUL_ANSWER_MS = [636, 2_644];
  for (const ms of OBSERVED_SUCCESSFUL_ANSWER_MS) {
    assert.ok(ms > 500, `${ms}ms would be abandoned by the 500 ms floor`);
    assert.ok(
      ms < MOBILE_SIP_ANSWER_ATTEMPT_TIMEOUT_MS,
      `${ms}ms must fit inside one 4 s attempt`,
    );
  }
});

/**
 * Source guards. The defect was a CALLER — a flag set 200 lines away from the
 * branch it selects — so a unit test of the timing helpers passes straight
 * through it. These read the pipeline itself.
 *
 * ⛔ Comments are stripped before every negative assertion: the fix's own doc
 * block quotes the removed code, and a naive `includes()` would match it and
 * report a correct tree as broken. (Fifth time this repo has hit that trap.)
 * ⛔ CRLF is normalised — the working tree is CRLF under core.autocrlf=true.
 */
function pipelineSource(): string {
  // MOBILE_GUARD_PIPELINE lets these guards be replayed against a checkout of an
  // older tree — the ONLY way to prove they are not decorative.
  const override = process.env.MOBILE_GUARD_PIPELINE;
  const p =
    override ??
    join(import.meta.dirname ?? __dirname, "..", "context", "NotificationsContext.tsx");
  return readFileSync(p, "utf8").replace(new RegExp("\\r\\n", "g"), "\n");
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

test("the warm claim must NOT set backendClaimed — that flag selects the answer branch", () => {
  const code = stripComments(pipelineSource());
  const warmClaim = /if\s*\(\s*inviteReady\s*&&\s*!earlyColdAcceptSent\s*\)\s*\{[\s\S]{0,400}?\}/.exec(code);
  if (warmClaim) {
    assert.ok(
      !/backendClaimed\s*=\s*true/.test(warmClaim[0]),
      "the warm-path claim block sets backendClaimed — this routes the warm answer " +
        "into the cold branch and drops its deadline extension (outage 2026-08-23)",
    );
  }
});

test("the warm answer branch extends the deadline before answering", () => {
  const code = stripComments(pipelineSource());
  const idx = code.indexOf("if (!backendClaimed) {");
  assert.ok(idx > 0, "the warm answer branch is gone — the pipeline was restructured");
  const branch = code.slice(idx, idx + 1200);
  const extendAt = branch.indexOf("answerDeadline.handle.extend(");
  const answerAt = branch.indexOf("answerIncomingInvite(");
  assert.ok(extendAt > 0, "the warm branch no longer extends the answer deadline");
  assert.ok(answerAt > 0, "the warm branch no longer answers");
  assert.ok(
    extendAt < answerAt,
    "the deadline must be extended BEFORE the answer, or the answer runs on the pre-claim window",
  );
});

test("the warm answer branch still carries the answer_unacked rescue", () => {
  // Losing the branch also loses the rescue that re-offers the call over a fresh
  // leg while the PBX is still ringing (c55ae840). Pin it so a future revert of
  // the flag cannot quietly take the rescue with it.
  const code = stripComments(pipelineSource());
  const idx = code.indexOf("if (!backendClaimed) {");
  const branch = code.slice(idx, idx + 6000);
  assert.ok(
    branch.includes("ANSWER_UNACKED_REQUEUE"),
    "the warm branch lost the answer_unacked rescue",
  );
});
