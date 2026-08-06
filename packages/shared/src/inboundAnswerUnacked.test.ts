/**
 * The un-acknowledged-pickup watchdog.
 *
 * "We answered and the far end never ACKed our 200 OK" had NO distinct signal
 * anywhere in the stack. It was reported as `session_not_found_timeout` — a
 * label the code stamps on ANY failure with fewer than 3 attempts, including
 * ones where the session was found on the first poll and answered. That single
 * mislabel produced two wrong root causes for the Create A Box ext 102 call on
 * 2026-08-05 before the raw blackbox payload was read.
 *
 * ⛔ THE REGRESSION THIS FILE EXISTS TO PREVENT: giving the failure its own
 * diagnosis category is only half a fix. `isInboundAnswerFailure()` — the
 * predicate that feeds incident clustering — matches on an explicit list of
 * categories. Splitting a category out WITHOUT adding it to that list silently
 * removes alerting for it. These tests fail if the two ever drift apart.
 *
 * Run: npx tsx --test src/inboundAnswerUnacked.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyInboundDiagnosis } from "./webrtcBlackbox.js";
import { isInboundAnswerFailure } from "./webrtcIncidentAlerts.js";

test("an unacked answer gets its own diagnosis category", () => {
  assert.equal(
    classifyInboundDiagnosis({ failureReason: "answer_unacked" }),
    "INBOUND_ANSWER_UNACKED",
  );
});

test("the new category still raises an inbound-answer incident", () => {
  // This is the drift guard. If someone adds a category to
  // InboundDiagnosisCategory but not to isInboundAnswerFailure, the failure
  // becomes invisible to alerting — worse than before it had a category.
  assert.equal(
    isInboundAnswerFailure({ diagnosisCategory: "INBOUND_ANSWER_UNACKED" }),
    true,
    "INBOUND_ANSWER_UNACKED must feed incident clustering, or splitting it out REMOVED alerting",
  );
});

test("every inbound diagnosis category that means failure is alertable", () => {
  // Enumerated deliberately rather than derived: adding a category should make
  // someone decide, in review, whether it is alert-worthy.
  const failureCategories = [
    "INBOUND_SESSION_NOT_FOUND_TIMEOUT",
    "INBOUND_INVITE_NOT_RECEIVED",
    "INBOUND_SIP_ANSWER_FAILED",
    "INBOUND_ANSWER_UNACKED",
  ];
  for (const cat of failureCategories) {
    assert.equal(
      isInboundAnswerFailure({ diagnosisCategory: cat }),
      true,
      `${cat} is a failure category but does not raise an incident`,
    );
  }
});

test("the payload shape the live failure actually produced is classified", () => {
  // Verbatim fields from the real WEBRTC_CALL_DEBUG row for pbxCallId
  // 1785949038.169956 (Create A Box ext 102, 2026-08-05 12:57 ET), with the
  // failureReason the fixed client now emits.
  const live = {
    debugKind: "WEBRTC_INBOUND_ANSWER_FAIL",
    direction: "inbound",
    diagnosisCategory: classifyInboundDiagnosis({ failureReason: "answer_unacked" }),
    sipAnswer: { sent: true, attempted: true, confirmed: false },
    incomingSessionSnapshot: {
      incomingSessionCount: 1,
      answerableSessionCount: 1,
      pollIterations: 1,
      answerAttempts: 1,
      failureReason: "answer_unacked",
    },
  };
  assert.equal(live.diagnosisCategory, "INBOUND_ANSWER_UNACKED");
  assert.equal(isInboundAnswerFailure(live), true);
});

test("a session that was answered and CONFIRMED is not a failure", () => {
  assert.equal(
    classifyInboundDiagnosis({ failureReason: null }),
    "INBOUND_FAILED_OTHER",
    "null reason must not masquerade as the unacked category",
  );
});
