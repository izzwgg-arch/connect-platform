import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  EMERGENCY_ALLOWED_DESTINATIONS,
  SERVICE_INTERRUPTION_GRACE_DAYS,
  computeInterruptionState,
  decideDailyReminder,
  isEmergencyDestination,
  isOutboundCallAllowed,
  normalizeDialedDigits,
} from "./serviceInterruptionPolicy";

const DAY = 24 * 60 * 60 * 1000;
const FAILED = new Date("2026-08-17T14:00:00Z");

// ─── The emergency allow-list ────────────────────────────────────────────────

test("911 and the local EMS/fire line are the allow-list", () => {
  assert.deepEqual([...EMERGENCY_ALLOWED_DESTINATIONS], ["911", "8457831212"]);
});

test("the allow-list is frozen — it cannot be edited at runtime", () => {
  assert.equal(Object.isFrozen(EMERGENCY_ALLOWED_DESTINATIONS), true);
  assert.throws(() => {
    (EMERGENCY_ALLOWED_DESTINATIONS as string[]).push("5551234567");
  });
});

test("911 is reachable however it is dialled", () => {
  for (const dialed of ["911", " 911 ", "9-1-1"]) {
    assert.equal(isEmergencyDestination(dialed), true, dialed);
  }
});

test("the EMS/fire line is reachable in every common format", () => {
  for (const dialed of [
    "8457831212",
    "845-783-1212",
    "(845) 783-1212",
    "845.783.1212",
    "18457831212",
    "1-845-783-1212",
    "+1 (845) 783-1212",
  ]) {
    assert.equal(isEmergencyDestination(dialed), true, dialed);
  }
});

test("an ordinary number CONTAINING 911 is not an emergency call", () => {
  // The substring trap: this is a normal phone number and must stay blocked.
  for (const dialed of ["8459111234", "845-911-1234", "9115551212", "1911"]) {
    assert.equal(isEmergencyDestination(dialed), false, dialed);
  }
});

test("a number that merely starts with the EMS digits is not allowed", () => {
  assert.equal(isEmergencyDestination("84578312125"), false);
  assert.equal(isEmergencyDestination("845783121"), false);
});

test("unparseable destinations fail closed", () => {
  for (const dialed of [null, undefined, "", "   ", "abc", "+", "-()"]) {
    assert.equal(isEmergencyDestination(dialed as string), false, String(dialed));
    assert.equal(normalizeDialedDigits(dialed as string), null, String(dialed));
  }
});

test("normalize strips a US long-distance 1 but never an 11-digit foreign number", () => {
  assert.equal(normalizeDialedDigits("18457831212"), "8457831212");
  assert.equal(normalizeDialedDigits("28457831212"), "28457831212");
});

// ─── The gate the call path actually calls ───────────────────────────────────

test("a tenant that is NOT interrupted may dial anything", () => {
  assert.equal(isOutboundCallAllowed({ interrupted: false, dialed: "5551234567" }), true);
  assert.equal(isOutboundCallAllowed({ interrupted: false, dialed: null }), true);
});

test("an interrupted tenant may dial only the allow-list", () => {
  assert.equal(isOutboundCallAllowed({ interrupted: true, dialed: "911" }), true);
  assert.equal(isOutboundCallAllowed({ interrupted: true, dialed: "845-783-1212" }), true);
  assert.equal(isOutboundCallAllowed({ interrupted: true, dialed: "5551234567" }), false);
  assert.equal(isOutboundCallAllowed({ interrupted: true, dialed: null }), false);
});

// ─── The seven-day clock ─────────────────────────────────────────────────────

test("seven days is the default grace period", () => {
  assert.equal(SERVICE_INTERRUPTION_GRACE_DAYS, 7);
});

test("the day the payment fails, seven days remain", () => {
  const s = computeInterruptionState({ firstFailedAt: FAILED, now: FAILED });
  assert.equal(s.daysLeft, 7);
  assert.equal(s.dueForInterruption, false);
  assert.equal(s.interruptAt.toISOString(), "2026-08-24T14:00:00.000Z");
});

test("the countdown walks 7 to 1 and never skips a number", () => {
  const seen: number[] = [];
  for (let d = 0; d < SERVICE_INTERRUPTION_GRACE_DAYS; d++) {
    seen.push(computeInterruptionState({ firstFailedAt: FAILED, now: new Date(FAILED.getTime() + d * DAY) }).daysLeft);
  }
  assert.deepEqual(seen, [7, 6, 5, 4, 3, 2, 1]);
});

test("part of a day still counts as a whole day left, never zero early", () => {
  // 2 hours before the deadline the customer has "1 day left", not "0 days".
  const s = computeInterruptionState({ firstFailedAt: FAILED, now: new Date(FAILED.getTime() + 7 * DAY - 2 * 60 * 60 * 1000) });
  assert.equal(s.daysLeft, 1);
  assert.equal(s.dueForInterruption, false);
});

test("service is due exactly at the deadline and stays due after", () => {
  const at = computeInterruptionState({ firstFailedAt: FAILED, now: new Date(FAILED.getTime() + 7 * DAY) });
  assert.equal(at.dueForInterruption, true);
  assert.equal(at.daysLeft, 0);
  const later = computeInterruptionState({ firstFailedAt: FAILED, now: new Date(FAILED.getTime() + 30 * DAY) });
  assert.equal(later.dueForInterruption, true);
  assert.equal(later.daysLeft, 0);
});

// ─── Daily reminder decision ─────────────────────────────────────────────────

test("a reminder goes out on the day of failure", () => {
  const r = decideDailyReminder({ firstFailedAt: FAILED, now: FAILED, lastReminderSentAt: null });
  assert.equal(r?.daysLeft, 7);
});

test("no second reminder within the same 24 hours", () => {
  const now = new Date(FAILED.getTime() + 3 * 60 * 60 * 1000);
  assert.equal(decideDailyReminder({ firstFailedAt: FAILED, now, lastReminderSentAt: FAILED }), null);
});

test("the next day's reminder does go out", () => {
  const now = new Date(FAILED.getTime() + DAY + 60_000);
  const r = decideDailyReminder({ firstFailedAt: FAILED, now, lastReminderSentAt: FAILED });
  assert.equal(r?.daysLeft, 6);
});

test("no reminder once service is already interrupted", () => {
  const now = new Date(FAILED.getTime() + 8 * DAY);
  assert.equal(decideDailyReminder({ firstFailedAt: FAILED, now, lastReminderSentAt: null }), null);
});

test("retries do not restart the clock — the caller passes the FIRST failure", () => {
  // Same first failure, a retry three days later: still 4 days left, not 7.
  const now = new Date(FAILED.getTime() + 3 * DAY);
  assert.equal(computeInterruptionState({ firstFailedAt: FAILED, now }).daysLeft, 4);
});
