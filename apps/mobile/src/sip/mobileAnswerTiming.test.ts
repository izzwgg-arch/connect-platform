import test from "node:test";
import assert from "node:assert/strict";
import {
  MOBILE_SIP_ANSWER_INITIAL_WAIT_MS,
  MOBILE_SIP_ANSWER_MAX_WAIT_MS,
  MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS,
  createSipAnswerDeadline,
} from "./mobileAnswerTiming.js";

test("answer deadline respects initial timeout and hard cap", () => {
  const start = Date.now();
  const { handle, hardCapMs } = createSipAnswerDeadline(start, MOBILE_SIP_ANSWER_INITIAL_WAIT_MS);
  assert.equal(handle.getUntilMs(), start + MOBILE_SIP_ANSWER_INITIAL_WAIT_MS);
  assert.equal(hardCapMs, start + MOBILE_SIP_ANSWER_MAX_WAIT_MS);
});

test("answer deadline extend grows until hard cap", () => {
  const start = Date.now();
  const { handle, hardCapMs } = createSipAnswerDeadline(start, MOBILE_SIP_ANSWER_INITIAL_WAIT_MS);
  handle.extend(MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS);
  const extended = handle.getUntilMs();
  assert.ok(extended > start + MOBILE_SIP_ANSWER_INITIAL_WAIT_MS);
  assert.ok(extended <= hardCapMs);
});

test("post-accept extra is shorter than max cap", () => {
  assert.ok(MOBILE_SIP_ANSWER_INITIAL_WAIT_MS + MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS <= MOBILE_SIP_ANSWER_MAX_WAIT_MS);
});
