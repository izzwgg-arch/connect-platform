/**
 * The username and password kept on THIS computer — the whole promise of
 * unattended access is that they are checked here and never leave.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  LOGIN_LOCKOUT_MS,
  LOGIN_MAX_FAILURES,
  attemptLogin,
  createAccessLogin,
  credentialsMatch,
  describeLogin,
  mintDeviceId,
  mintMachineKey,
  validatePassword,
  validateUsername,
} from "./credentials";

const NOW = new Date("2026-09-02T12:00:00Z");

test("a login is a salt and a hash — the password is nowhere in it", () => {
  const login = createAccessLogin("izzy-home", "correct horse battery", NOW);
  assert.equal(login.username, "izzy-home");
  assert.match(login.salt, /^[0-9a-f]{16,}$/);
  assert.match(login.hash, /^[0-9a-f]{32,}$/);
  assert.equal(JSON.stringify(login).includes("correct horse"), false, "the clear text must not be stored");
  assert.equal(login.failures, 0);
  assert.equal(login.lockedUntil, null);
  // Two logins with the same password never share a hash.
  assert.notEqual(createAccessLogin("izzy-home", "correct horse battery", NOW).hash, login.hash);
});

test("matching is exact on the password and forgiving on username case and whitespace", () => {
  const login = createAccessLogin("Izzy-Home", "correct horse battery", NOW);
  assert.equal(credentialsMatch(login, "izzy-home", "correct horse battery"), true);
  assert.equal(credentialsMatch(login, " IZZY-HOME ", "correct horse battery"), true);
  assert.equal(credentialsMatch(login, "izzy-home", "Correct horse battery"), false);
  assert.equal(credentialsMatch(login, "izzy-home", "correct horse battery "), false);
  assert.equal(credentialsMatch(login, "someone-else", "correct horse battery"), false);
  assert.equal(credentialsMatch(login, 42 as any, "correct horse battery"), false);
  assert.equal(credentialsMatch(login, "izzy-home", { toString: () => "correct horse battery" } as any), false, "only a string is a password");
});

test("five wrong tries lock it for fifteen minutes, a right one resets the count, and the lockout expires", () => {
  const login = createAccessLogin("izzy-home", "correct horse battery", NOW);
  let state = login;
  for (let i = 1; i < LOGIN_MAX_FAILURES; i++) {
    const v = attemptLogin(state, "izzy-home", "nope", NOW);
    assert.equal(v.ok, false);
    if (v.ok) throw new Error("unreachable");
    assert.equal(v.reason, "wrong");
    assert.equal(v.attemptsLeft, LOGIN_MAX_FAILURES - i);
    state = v.login!;
  }
  const locked = attemptLogin(state, "izzy-home", "nope", NOW);
  assert.equal(locked.ok, false);
  if (locked.ok) throw new Error("unreachable");
  assert.equal(locked.reason, "locked");
  assert.equal(locked.lockedUntil, NOW.getTime() + LOGIN_LOCKOUT_MS);
  state = locked.login!;
  // ⛔ During the lockout even the RIGHT password is refused — and the check runs
  // before the scrypt, so a locked machine spends nothing on a guess.
  const rightButLocked = attemptLogin(state, "izzy-home", "correct horse battery", new Date(NOW.getTime() + 60_000));
  assert.equal(rightButLocked.ok, false);
  if (rightButLocked.ok) throw new Error("unreachable");
  assert.equal(rightButLocked.reason, "locked");
  // After the fifteen minutes the count is back to zero.
  const later = new Date(NOW.getTime() + LOGIN_LOCKOUT_MS + 1);
  const wrongAgain = attemptLogin(state, "izzy-home", "nope", later);
  assert.equal(wrongAgain.ok, false);
  if (wrongAgain.ok) throw new Error("unreachable");
  assert.equal(wrongAgain.reason, "wrong");
  assert.equal(wrongAgain.attemptsLeft, LOGIN_MAX_FAILURES - 1);
  const right = attemptLogin(wrongAgain.login!, "izzy-home", "correct horse battery", later);
  assert.equal(right.ok, true);
  if (!right.ok) throw new Error("unreachable");
  assert.equal(right.login.failures, 0);
  assert.equal(right.login.lockedUntil, null);
});

test("no login set means no way in, and the verdict says so without inventing a count", () => {
  const v = attemptLogin(null, "anyone", "anything", NOW);
  assert.deepEqual(v, { ok: false, reason: "no_login", login: null, attemptsLeft: 0, lockedUntil: null });
});

test("what the screen may say: set or not, the username, the lockout — never the hash", () => {
  assert.deepEqual(describeLogin(null, NOW), { set: false, username: null, lockedForMs: 0 });
  const login = createAccessLogin("izzy-home", "correct horse battery", NOW);
  const d = describeLogin({ ...login, lockedUntil: NOW.getTime() + 60_000 }, NOW);
  assert.deepEqual(d, { set: true, username: "izzy-home", lockedForMs: 60_000 });
  assert.equal("hash" in d, false);
  assert.equal("salt" in d, false);
  assert.equal(describeLogin({ ...login, lockedUntil: NOW.getTime() - 1 }, NOW).lockedForMs, 0);
});

test("username and password rules are the ones the setup page promises", () => {
  assert.equal(validateUsername("izzy-home").ok, true);
  assert.equal(validateUsername("iz").ok, false, "3 characters minimum");
  assert.equal(validateUsername("a".repeat(33)).ok, false);
  assert.equal(validateUsername("izzy home").ok, false, "no spaces");
  assert.equal(validateUsername("izzy@home.local").ok, true);
  assert.equal(validateUsername(null).ok, false);
  assert.equal(validatePassword("short").ok, false, "8 characters minimum");
  assert.equal(validatePassword("long enough").ok, true);
  assert.equal(validatePassword("x".repeat(129)).ok, false);
  const bad = validatePassword("short");
  if (bad.ok) throw new Error("unreachable");
  assert.match(bad.message, /8/);
});

test("machine key and install id are random, well-shaped and never repeat", () => {
  const keys = new Set(Array.from({ length: 50 }, () => mintMachineKey()));
  assert.equal(keys.size, 50);
  for (const k of keys) assert.match(k, /^[0-9a-f]{64}$/);
  const ids = new Set(Array.from({ length: 50 }, () => mintDeviceId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^win-[0-9a-f]{24}$/);
});
