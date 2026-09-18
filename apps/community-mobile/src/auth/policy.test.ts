import assert from "node:assert/strict";
import { test } from "node:test";
import { isPersistableToken, needsBiometricGate, withinUnlockGrace } from "./policy";

test("needsBiometricGate requires signed in, the setting on, hardware, and enrollment all together", () => {
  const base = { settingEnabled: true, hasHardware: true, isEnrolled: true, isSignedIn: true };
  assert.equal(needsBiometricGate(base), true);
  assert.equal(needsBiometricGate({ ...base, isSignedIn: false }), false, "signed out never gates");
  assert.equal(needsBiometricGate({ ...base, settingEnabled: false }), false, "setting off never gates");
  assert.equal(needsBiometricGate({ ...base, hasHardware: false }), false, "no biometric hardware never gates");
  assert.equal(needsBiometricGate({ ...base, isEnrolled: false }), false, "no enrolled biometric never gates");
});

test("withinUnlockGrace: a null lastUnlockAt is never within grace", () => {
  assert.equal(withinUnlockGrace(null, Date.now()), false);
});

test("withinUnlockGrace: just-unlocked is within the default 30s grace", () => {
  const now = 1_000_000;
  assert.equal(withinUnlockGrace(now - 5_000, now), true);
  assert.equal(withinUnlockGrace(now - 29_999, now), true);
});

test("withinUnlockGrace: past the grace window requires unlocking again", () => {
  const now = 1_000_000;
  assert.equal(withinUnlockGrace(now - 30_000, now), false);
  assert.equal(withinUnlockGrace(now - 60_000, now), false);
});

test("withinUnlockGrace: a custom grace window is respected", () => {
  const now = 1_000_000;
  assert.equal(withinUnlockGrace(now - 4_000, now, 5_000), true);
  assert.equal(withinUnlockGrace(now - 6_000, now, 5_000), false);
});

test("token storage rule: only the refresh token is ever persistable", () => {
  assert.equal(isPersistableToken("refresh"), true);
  assert.equal(isPersistableToken("access"), false);
});
