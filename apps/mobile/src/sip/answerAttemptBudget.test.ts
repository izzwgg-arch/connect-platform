/**
 * Regression tests for the inbound-answer retry budget and failure verdicts.
 *
 * These lock down the two defects that caused (and then MISDIAGNOSED) the
 * Create A Box ext 102 call on 2026-08-05 12:57:26 ET
 * (pbxCallId 1785949038.169956):
 *
 *   1. `answerIncoming()` advertises MAX_ATTEMPTS = 3, but its per-attempt
 *      timer was the ENTIRE remaining deadline — so attempt #1 consumed the
 *      whole budget and attempts #2/#3 were unreachable. On that call the app
 *      answered within ~160 ms, got no ACK, and then sat for 16.1 s while the
 *      PBX's 15 s ring timer expired and dumped the caller to voicemail.
 *
 *   2. The failure was reported as `session_not_found_timeout` even though the
 *      session was found on the FIRST poll (pollIterations = 1) and answered
 *      (answerAttempts = 1, sipAnswer.sent = true, JsSIP status 6 =
 *      STATUS_WAITING_FOR_ACK). That label sent two investigations down the
 *      wrong path.
 *
 * Run: pnpm --filter @connect/mobile test:answer-budget
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MOBILE_SIP_ANSWER_ATTEMPT_TIMEOUT_MS,
  MOBILE_SIP_ANSWER_INITIAL_WAIT_MS,
  MOBILE_SIP_ANSWER_MAX_WAIT_MS,
  createSipAnswerDeadline,
} from "./mobileAnswerTiming.js";
import { classifyInboundDiagnosis } from "@connect/shared/webrtcBlackbox";

/** Mirrors the per-attempt cap computed inside jssip.ts `answerIncoming()`. */
function attemptTimeoutMs(remainingMs: number): number {
  return Math.max(500, Math.min(MOBILE_SIP_ANSWER_ATTEMPT_TIMEOUT_MS, remainingMs));
}

test("a single attempt can never consume the whole answer budget", () => {
  const start = Date.now();
  const { handle } = createSipAnswerDeadline(start, MOBILE_SIP_ANSWER_INITIAL_WAIT_MS);
  const remaining = handle.getUntilMs() - start;

  const first = attemptTimeoutMs(remaining);

  // The regression: `Math.max(500, remaining)` returned the entire budget.
  assert.notEqual(first, remaining, "attempt #1 must not swallow the full deadline");
  assert.ok(first <= MOBILE_SIP_ANSWER_ATTEMPT_TIMEOUT_MS);
  assert.ok(remaining - first > 0, "budget must survive attempt #1");
});

function attemptsThatFit(budgetMs: number, cap = 3): number {
  let remaining = budgetMs;
  let attempts = 0;
  while (remaining > 0 && attempts < cap) {
    remaining -= attemptTimeoutMs(remaining);
    attempts += 1;
  }
  return attempts;
}

test("more than one attempt fits in the pre-claim budget", () => {
  // The regression was EXACTLY one: attempt #1 ate everything. Within the
  // initial 8 s window a 4 s cap yields 2 real attempts — the third only
  // becomes reachable once the deadline is extended after a backend claim
  // (asserted below). 2 is the honest number here; do not "fix" this to 3 by
  // shrinking the cap, which would cut SIP's 200 OK retransmission ladder
  // (500 ms / 1 s / 2 s) short and abandon merely-slow transports.
  const attempts = attemptsThatFit(MOBILE_SIP_ANSWER_INITIAL_WAIT_MS);
  assert.ok(attempts >= 2, `expected >=2 attempts, got ${attempts}`);
});

test("all 3 attempts are reachable within the hard cap", () => {
  // The real operating envelope: the deadline extends by
  // MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS after a backend claim, up to
  // MOBILE_SIP_ANSWER_MAX_WAIT_MS. MAX_ATTEMPTS=3 must be genuinely reachable
  // there, not decorative.
  assert.equal(attemptsThatFit(MOBILE_SIP_ANSWER_MAX_WAIT_MS), 3);
});

test("first attempt fails fast enough to rescue inside a 15s PBX ring timer", () => {
  // Create A Box ext 102 rings for 15 s before VitalPBX sends the caller to
  // voicemail. The rescue (reject wedged leg → backend requeue → fresh INVITE →
  // answer) must start with real time to spare.
  const PBX_RING_TIMER_MS = 15_000;
  const TAP_AT_MS = 7_000; // he tapped Answer ~7 s into the ring

  const failsAtMs = TAP_AT_MS + attemptTimeoutMs(MOBILE_SIP_ANSWER_INITIAL_WAIT_MS);
  const rescueWindowMs = PBX_RING_TIMER_MS - failsAtMs;

  assert.ok(
    rescueWindowMs >= 3_000,
    `need >=3s to requeue; got ${rescueWindowMs}ms (failed at ${failsAtMs}ms)`,
  );
});

test("answer_unacked is its own diagnosis, not a session-not-found", () => {
  assert.equal(
    classifyInboundDiagnosis({ failureReason: "answer_unacked" }),
    "INBOUND_ANSWER_UNACKED",
  );
  // Must NOT be swallowed by the generic reason.includes("answer") fallback.
  assert.notEqual(
    classifyInboundDiagnosis({ failureReason: "answer_unacked" }),
    "INBOUND_SIP_ANSWER_FAILED",
  );
  // And must stay distinct from the label that mislabelled the live call.
  assert.notEqual(
    classifyInboundDiagnosis({ failureReason: "answer_unacked" }),
    "INBOUND_SESSION_NOT_FOUND_TIMEOUT",
  );
});

test("the other two verdicts keep their existing meaning", () => {
  assert.equal(
    classifyInboundDiagnosis({ failureReason: "session_not_found_timeout" }),
    "INBOUND_SESSION_NOT_FOUND_TIMEOUT",
  );
  assert.equal(
    classifyInboundDiagnosis({ failureReason: "max_attempts" }),
    "INBOUND_MAX_ATTEMPTS",
  );
});

test("attempt cap never exceeds the hard ceiling", () => {
  assert.ok(MOBILE_SIP_ANSWER_ATTEMPT_TIMEOUT_MS < MOBILE_SIP_ANSWER_INITIAL_WAIT_MS);
  assert.ok(MOBILE_SIP_ANSWER_ATTEMPT_TIMEOUT_MS * 3 <= MOBILE_SIP_ANSWER_MAX_WAIT_MS);
});

test("a nearly-expired budget still yields a usable floor", () => {
  assert.equal(attemptTimeoutMs(10), 500);
  assert.equal(attemptTimeoutMs(-5_000), 500);
});
