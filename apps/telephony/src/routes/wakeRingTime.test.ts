/**
 * Follow-Me ring-time normalisation for wake-enrolled extensions.
 *
 * ⛔ THE DEFECT (measured live on the PBX, 2026-08-06)
 * `[connect-mobile-wake-dial]` holds a caller for up to 20 s while a sleeping
 * handset wakes. The caller-side `Dial(...)` timeout on the follow-me path
 * comes from the extension's follow-me ring time — which is **15 on 115 of 122
 * extensions fleet-wide** (VitalPBX default). So the wake engine believed it
 * had 20 s while VitalPBX sent the caller to voicemail at 15 s. Proven on the
 * Create A Box ext 102 call: the hold counted 1…14 s and was then cut off by
 * "Nobody picked up in 15000 ms" → voicemail.
 *
 * Those same extensions carry `ringtimer: 30` — follow-me was overriding their
 * configured intent DOWNWARDS, so raising it to 30 restores intent rather than
 * inventing a new policy.
 *
 * The rules below are the safety envelope. Getting any of them wrong changes
 * how long real callers ring before voicemail, on 12 live extensions.
 *
 * Run: npx tsx --test src/routes/wakeRingTime.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideFollowMeRingTime,
  WAKE_MIN_FOLLOWME_RING_SECS,
} from "./wakeDialPublish.js";

test("the fleet-default 15 is raised to clear the 20s wake hold", () => {
  const d = decideFollowMeRingTime("15", "1");
  assert.equal(d.change, true);
  if (d.change) {
    assert.equal(d.from, 15);
    assert.equal(d.to, WAKE_MIN_FOLLOWME_RING_SECS);
    assert.ok(d.to > 20, "must exceed the 20s wake hold or the clip persists");
  }
});

test("RAISE ONLY — a longer ring is never shortened", () => {
  // Shortening would send real callers to voicemail sooner than configured.
  for (const longer of ["30", "45", "60", "120"]) {
    const d = decideFollowMeRingTime(longer, "1");
    assert.equal(d.change, false, `${longer}s must be left alone`);
  }
});

test("0 means 'no follow-me timeout' and must not gain one", () => {
  const d = decideFollowMeRingTime("0", "1");
  assert.equal(d.change, false);
  if (!d.change) assert.equal(d.reason, "disabled");
});

test("an absent or empty key is left alone, never invented", () => {
  for (const empty of [null, undefined, "", "   "]) {
    const d = decideFollowMeRingTime(empty, "1");
    assert.equal(d.change, false, `${JSON.stringify(empty)} must not be written`);
    if (!d.change) assert.equal(d.reason, "unparseable");
  }
});

test("junk is never coerced into a number", () => {
  for (const junk of ["abc", "15s", "1.5", "-5", "2 0"]) {
    const d = decideFollowMeRingTime(junk, "1");
    assert.equal(d.change, false, `${junk} must not be parsed`);
  }
});

test("un-enrolling is a pure revert — it never touches ring time", () => {
  const d = decideFollowMeRingTime("15", "0");
  assert.equal(d.change, false);
  if (!d.change) assert.equal(d.reason, "unenroll");
});

test("exactly at the minimum is already sufficient", () => {
  const d = decideFollowMeRingTime(String(WAKE_MIN_FOLLOWME_RING_SECS), "1");
  assert.equal(d.change, false);
  if (!d.change) assert.equal(d.reason, "already_sufficient");
});

test("the minimum leaves a human time to actually answer", () => {
  const WAKE_HOLD_SECS = 20; // connect/system/mobile_reach_wait_secs default
  assert.ok(
    WAKE_MIN_FOLLOWME_RING_SECS - WAKE_HOLD_SECS >= 5,
    "a phone that wakes at the last moment still needs seconds for the user to tap Answer",
  );
});

test("the whole live fleet distribution resolves correctly", () => {
  // Values measured on the PBX: 115 extensions at 15, 6 at 0, 1 at 5.
  const fleet = [
    { value: "15", count: 115, expectChange: true },
    { value: "0", count: 6, expectChange: false },
    { value: "5", count: 1, expectChange: true },
  ];
  for (const row of fleet) {
    assert.equal(
      decideFollowMeRingTime(row.value, "1").change,
      row.expectChange,
      `${row.count} extension(s) at ${row.value}s classified wrongly`,
    );
  }
});
