import test from "node:test";
import assert from "node:assert/strict";
import { hashPin, verifyPin } from "./pinHash";
import { PinLockout } from "./pinLockout";

test("hashPin/verifyPin round-trips and rejects wrong PIN", () => {
  const stored = hashPin("4821");
  assert.ok(stored.startsWith("scrypt:"));
  assert.equal(verifyPin("4821", stored), true);
  assert.equal(verifyPin("4822", stored), false);
  assert.equal(verifyPin("", stored), false);
});

test("verifyPin rejects malformed stored hashes", () => {
  assert.equal(verifyPin("1234", "plaintext"), false);
  assert.equal(verifyPin("1234", "scrypt:zz:zz"), false);
  assert.equal(verifyPin("1234", "scrypt:00:00"), false);
});

test("PinLockout locks a caller after maxPerCaller failures in window", () => {
  const lo = new PinLockout({ windowMs: 60_000, maxPerCaller: 3, maxGlobal: 100 });
  const t = 1_000_000;
  assert.equal(lo.isLocked("555", t), false);
  lo.recordFailure("555", t);
  lo.recordFailure("555", t + 1);
  assert.equal(lo.isLocked("555", t + 2), false);
  lo.recordFailure("555", t + 3);
  assert.equal(lo.isLocked("555", t + 4), true);
  // Other callers unaffected (global limit not reached).
  assert.equal(lo.isLocked("666", t + 5), false);
});

test("PinLockout global limit backstops rotating caller IDs", () => {
  const lo = new PinLockout({ windowMs: 60_000, maxPerCaller: 10, maxGlobal: 4 });
  const t = 2_000_000;
  for (let i = 0; i < 4; i++) lo.recordFailure(`caller-${i}`, t + i);
  assert.equal(lo.isLocked("fresh-caller", t + 10), true);
});

test("PinLockout window expiry unlocks", () => {
  const lo = new PinLockout({ windowMs: 1_000, maxPerCaller: 1, maxGlobal: 100 });
  const t = 3_000_000;
  lo.recordFailure("555", t);
  assert.equal(lo.isLocked("555", t + 500), true);
  assert.equal(lo.isLocked("555", t + 1_500), false);
});

test("PinLockout success clears the caller's failures", () => {
  const lo = new PinLockout({ windowMs: 60_000, maxPerCaller: 2, maxGlobal: 100 });
  const t = 4_000_000;
  lo.recordFailure("555", t);
  lo.recordFailure("555", t + 1);
  assert.equal(lo.isLocked("555", t + 2), true);
  lo.recordSuccess("555");
  assert.equal(lo.isLocked("555", t + 3), false);
});

test("PinLockout treats empty caller ID as one bucket", () => {
  const lo = new PinLockout({ windowMs: 60_000, maxPerCaller: 2, maxGlobal: 100 });
  const t = 5_000_000;
  lo.recordFailure("", t);
  lo.recordFailure("", t + 1);
  assert.equal(lo.isLocked("", t + 2), true);
});
