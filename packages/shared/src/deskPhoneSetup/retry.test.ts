/**
 * ⛔ THE CASES HERE ARE IZZY'S OWN RUN, read off the database 2026-09-11. The Yealink
 * really was `NEEDS_ATTENTION` / `haltedReason: support` / `attempts: 0` / `resetCount:
 * 0`, and the three Grandstreams really were skipped by his own selection. Every one of
 * them had to come back without a single reset being forgiven.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PHONE_STATES, isTerminal, type PhoneState } from "./states";
import { planPhoneRetry, retryClears, retryableCount, inheritedResetCount } from "./retry";

test("the halted Yealink comes back — this is the whole point", () => {
  const plan = planPhoneRetry({
    state: "NEEDS_ATTENTION",
    resetCount: 0,
    attempts: 0,
    hasExtension: true,
  });
  assert.equal(plan.allowed, true);
  if (!plan.allowed) return;
  assert.equal(plan.nextState, "ASSIGNED", "it already knows whose phone it is");
  assert.equal(plan.resetAttempts, true);
});

test("a phone nobody has assigned yet goes back to being a found phone", () => {
  const plan = planPhoneRetry({
    state: "NEEDS_ATTENTION",
    resetCount: 0,
    attempts: 2,
    hasExtension: false,
  });
  assert.equal(plan.allowed, true);
  if (plan.allowed) assert.equal(plan.nextState, "IDENTIFIED");
});

test("a working phone is REFUSED — a retry would restart somebody mid-call", () => {
  const plan = planPhoneRetry({
    state: "REGISTERED",
    resetCount: 1,
    attempts: 1,
    hasExtension: true,
  });
  assert.equal(plan.allowed, false);
  if (plan.allowed) return;
  assert.equal(plan.reason, "already_working");
  // ⛔ The customer is told plainly, with no internal state name in it.
  assert.match(plan.customerMessage, /already working/i);
  for (const s of PHONE_STATES) assert.ok(!plan.customerMessage.includes(s), s);
});

test("EVERY state except REGISTERED can be retried, terminal or not", () => {
  for (const state of PHONE_STATES) {
    const plan = planPhoneRetry({ state, resetCount: 0, attempts: 0, hasExtension: true });
    if (state === "REGISTERED") {
      assert.equal(plan.allowed, false, "REGISTERED");
      continue;
    }
    assert.equal(plan.allowed, true, `${state} must be retryable`);
  }
});

test("a retry NEVER forgives a reset", () => {
  // ⛔ The one rule that cannot bend. `resetCount` is the record of hardware we have
  // actually wiped, so it is absent from what a retry clears — a second wipe is not
  // recoverable and "we lost our place" must never become "we wiped it again".
  const plan = planPhoneRetry({
    state: "FAILED",
    resetCount: 1,
    attempts: 2,
    hasExtension: true,
  });
  assert.equal(plan.allowed, true);
  if (!plan.allowed) return;
  const clears = retryClears(plan);
  assert.ok(!("resetCount" in clears), "resetCount must not be written by a retry");
  assert.ok(!("resetAuthorizedAt" in clears), "authorisation is a person's decision, not a retry's");
  assert.ok(!("macAddress" in clears));
  assert.ok(!("extensionId" in clears));
  assert.match(plan.explain, /reset history kept at 1/);
});

test("a retry clears the stale sentence the customer keeps re-reading", () => {
  // ⛔ Izzy pressed the button again and got the identical "Loopcom Support can finish
  // this one with you." — because nothing cleared the note or the halt reason.
  const plan = planPhoneRetry({
    state: "NEEDS_ATTENTION",
    resetCount: 0,
    attempts: 0,
    hasExtension: true,
  });
  assert.equal(plan.allowed, true);
  if (!plan.allowed) return;
  const clears = retryClears(plan);
  assert.equal(clears.customerNote, null);
  assert.equal(clears.technicalNote, null);
  assert.equal(clears.haltedReason, null);
  assert.equal(clears.attempts, 0);
  assert.equal(clears.state, "ASSIGNED");
});

test("the finish screen only offers try-again when it would do something", () => {
  assert.equal(retryableCount(["REGISTERED", "REGISTERED"]), 0);
  assert.equal(retryableCount(["REGISTERED", "NEEDS_ATTENTION"]), 1);
  assert.equal(retryableCount(["NEEDS_ATTENTION", "FAILED", "REGISTERED"]), 2);
  // A phone still moving is not stuck — the wizard is still working on it.
  assert.equal(retryableCount(["PROVISIONING", "WAITING_FOR_REGISTRATION"]), 0);
  assert.equal(retryableCount([]), 0);
});

test("retryableCount agrees with isTerminal, so a new terminal state is covered", () => {
  const stuck = PHONE_STATES.filter((s) => isTerminal(s) && s !== "REGISTERED");
  assert.equal(retryableCount(stuck as PhoneState[]), stuck.length);
});

test("a handset that has already been wiped still knows it in a brand new run", () => {
  // ⛔ THIS IS WHAT MAKES A SECOND RUN SAFE. Runs were kept open forever because two
  // runs would each believe they owned the counters; carrying the count forward by
  // hardware address is what removes that reason.
  assert.equal(inheritedResetCount([0, 1, 0]), 1);
  assert.equal(inheritedResetCount([]), 0);
  assert.equal(inheritedResetCount([2, 1]), 2);
});

test("rubbish in a prior count can never lower the wipe history", () => {
  assert.equal(inheritedResetCount([Number.NaN, 1]), 1);
  assert.equal(inheritedResetCount([Number.POSITIVE_INFINITY, 1]), 1);
  assert.equal(inheritedResetCount([-5, 0]), 0);
  assert.equal(inheritedResetCount([1.9]), 1);
});
