import { test } from "node:test";
import assert from "node:assert/strict";
import { AnswerLatencyTracker, buildAnswerLatencyReport, withEndedAt } from "./answerLatency";

test("a healthy answer reports the two numbers a future watchdog needs", () => {
  const r = buildAnswerLatencyReport({ tappedAt: 1000, acceptedAt: 1080, confirmedAt: 1350 }, null, "primary");
  assert.equal(r?.outcome, "confirmed");
  assert.equal(r?.msTapToAccepted, 80);
  assert.equal(r?.msTapToConfirmed, 350);
  // ⛔ The network round trip is the half that fails on a rebuilt socket, so it
  // is reported separately from our own processing time.
  assert.equal(r?.msAcceptedToConfirmed, 270);
});

test("THE GESHEFT FAILURE: answered, never acknowledged", () => {
  const phases = { tappedAt: 1000, acceptedAt: 1090 };
  const r = buildAnswerLatencyReport(phases, "NO_ACK", "primary");
  assert.equal(r?.outcome, "answered_never_confirmed");
  assert.equal(r?.msTapToAccepted, 90);
  assert.equal(r?.msTapToConfirmed, null, "there is no confirmation to time");
  assert.equal(r?.endedCause, "NO_ACK");

  // JsSIP gives up after TIMER_H (64 x T1 = ~32s) and BYEs. That is how long
  // the customer sat on a call the UI told them was connected.
  const withEnd = withEndedAt(r!, phases, 1090 + 32_000);
  assert.equal(withEnd.msAnsweredWithoutAck, 32_000);
});

test("a call that ended before we answered is distinguished, not lumped in", () => {
  const r = buildAnswerLatencyReport({ tappedAt: 1000 }, "CANCELED", "primary");
  assert.equal(r?.outcome, "ended_before_answer");
  assert.equal(r?.msTapToAccepted, null);
});

test("a call nobody answered reports NOTHING", () => {
  // ⛔ Missed calls vastly outnumber answered ones. Reporting them would bury
  // the handful of real failures and burn the 60-events-per-minute budget.
  assert.equal(buildAnswerLatencyReport({}, "CANCELED", "primary"), null);
});

test("both answer paths are labelled, because they behave differently", () => {
  const a = buildAnswerLatencyReport({ tappedAt: 1, acceptedAt: 2 }, null, "primary");
  const b = buildAnswerLatencyReport({ tappedAt: 1, acceptedAt: 2 }, null, "multicall");
  assert.equal(a?.path, "primary");
  assert.equal(b?.path, "multicall");
});

test("a session is reported at most once, however many times it ends", () => {
  const t = new AnswerLatencyTracker();
  const s = {};
  t.tap(s, 1000);
  t.accepted(s, 1100);
  assert.ok(t.finish(s, "NO_ACK", "primary", 5000), "first end reports");
  assert.equal(t.finish(s, "NO_ACK", "primary", 5001), null, "a second end must not double-count");
});

test("the tracker ignores events for a session that was never answered", () => {
  const t = new AnswerLatencyTracker();
  const s = {};
  t.accepted(s, 1100);
  t.confirmed(s, 1200);
  assert.equal(t.finish(s, null, "primary"), null);
});

test("accepted and confirmed keep their FIRST timestamp", () => {
  // JsSIP can re-emit on a re-INVITE; the answer we are timing is the first one.
  const t = new AnswerLatencyTracker();
  const s = {};
  t.tap(s, 1000);
  t.accepted(s, 1100);
  t.accepted(s, 9999);
  t.confirmed(s, 1300);
  t.confirmed(s, 9999);
  const r = t.finish(s, null, "primary", 2000);
  assert.equal(r?.msTapToAccepted, 100);
  assert.equal(r?.msTapToConfirmed, 300);
});
