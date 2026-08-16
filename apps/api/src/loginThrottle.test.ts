import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOGIN_THROTTLE_CONFIG as CFG,
  clientIpFromForwardedFor,
  evaluateLoginAttempt,
  normalizeSourceKey,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginThrottle,
} from "./loginThrottle";

beforeEach(() => {
  delete process.env.LOGIN_THROTTLE_DISABLED;
  resetLoginThrottle();
});

const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// The bug this file exists to prevent coming back.
// ---------------------------------------------------------------------------

test("the throttle does NOT depend on NODE_ENV (the api container sets none)", () => {
  delete process.env.NODE_ENV;
  for (let i = 0; i < CFG.accountFailureLimit; i++) {
    recordLoginFailure("victim@example.com", "203.0.113.9", T0 + i);
  }
  const d = evaluateLoginAttempt("victim@example.com", "203.0.113.9", T0 + 1000);
  assert.equal(d.action, "throttle", "must engage with NODE_ENV unset — this was the live bug");
});

test("source file contains no NODE_ENV reference at all", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(path.join(__dirname, "loginThrottle.ts"), "utf8");
  const code = src.slice(src.indexOf("export type LoginThrottleAction"));
  assert.ok(!code.includes("NODE_ENV"), "security controls must never be gated on NODE_ENV here");
});

// ---------------------------------------------------------------------------
// PHASE 36 — legitimate behaviour must NOT be punished.
// ---------------------------------------------------------------------------

test("a user who forgets their password a few times is never throttled", () => {
  for (let i = 0; i < CFG.accountFailureLimit - 1; i++) {
    recordLoginFailure("izzy@example.com", "50.49.206.161", T0 + i * 5000);
  }
  const d = evaluateLoginAttempt("izzy@example.com", "50.49.206.161", T0 + 60_000);
  assert.equal(d.action, "allow");
});

test("a successful sign-in fully clears that account's failure history", () => {
  for (let i = 0; i < CFG.accountFailureLimit; i++) {
    recordLoginFailure("izzy@example.com", "50.49.206.161", T0 + i);
  }
  assert.equal(evaluateLoginAttempt("izzy@example.com", "50.49.206.161", T0 + 1).action, "throttle");
  recordLoginSuccess("izzy@example.com");
  assert.equal(evaluateLoginAttempt("izzy@example.com", "50.49.206.161", T0 + 2).action, "allow");
});

test("an account throttle expires on its own — it is never a permanent ban", () => {
  for (let i = 0; i < CFG.accountFailureLimit; i++) {
    recordLoginFailure("izzy@example.com", "50.49.206.161", T0 + i);
  }
  assert.equal(evaluateLoginAttempt("izzy@example.com", "50.49.206.161", T0 + 1).action, "throttle");
  const later = T0 + CFG.accountWindowMs + 1;
  assert.equal(evaluateLoginAttempt("izzy@example.com", "50.49.206.161", later).action, "allow");
});

test("one user changing Wi-Fi -> cellular is not throttled (failures follow the account, not the IP)", () => {
  for (let i = 0; i < 4; i++) recordLoginFailure("izzy@example.com", "50.49.206.161", T0 + i);
  for (let i = 0; i < 4; i++) recordLoginFailure("izzy@example.com", "172.56.164.70", T0 + 100 + i);
  assert.equal(evaluateLoginAttempt("izzy@example.com", "172.56.164.70", T0 + 500).action, "allow");
});

test("a shared-NAT office: several colleagues each failing twice is not credential stuffing", () => {
  const staff = ["a@co.com", "b@co.com", "c@co.com", "d@co.com", "e@co.com"];
  staff.forEach((who, i) => {
    recordLoginFailure(who, "198.51.100.7", T0 + i * 1000);
    recordLoginFailure(who, "198.51.100.7", T0 + i * 1000 + 10);
  });
  const d = evaluateLoginAttempt("f@co.com", "198.51.100.7", T0 + 20_000);
  assert.equal(d.action, "allow", "5 distinct accounts is under the limit — a real office looks like this");
});

// ---------------------------------------------------------------------------
// Attack detection.
// ---------------------------------------------------------------------------

test("credential stuffing: one source, many distinct accounts -> block", () => {
  for (let i = 0; i < CFG.sourceDistinctAccountLimit; i++) {
    recordLoginFailure(`user${i}@victim.com`, "45.148.10.151", T0 + i * 100);
  }
  const d = evaluateLoginAttempt("user99@victim.com", "45.148.10.151", T0 + 5000);
  assert.equal(d.action, "block");
  assert.equal(d.reason, "credential_stuffing");
  assert.match(d.detail, /distinct accounts/);
  assert.ok(d.retryAfterSeconds > 0);
});

test("credential stuffing is judged on distinct accounts, NOT raw failure count", () => {
  // 25 failures, but all against ONE account — that is a person, not a botnet.
  for (let i = 0; i < 25; i++) recordLoginFailure("one@example.com", "203.0.113.5", T0 + i);
  const d = evaluateLoginAttempt("one@example.com", "203.0.113.5", T0 + 500);
  assert.notEqual(d.reason, "credential_stuffing");
});

test("high-volume source is throttled even against few accounts", () => {
  for (let i = 0; i < CFG.sourceFailureLimit; i++) {
    recordLoginFailure(i % 2 ? "a@x.com" : "b@x.com", "203.0.113.77", T0 + i);
  }
  const d = evaluateLoginAttempt("c@x.com", "203.0.113.77", T0 + 5000);
  assert.equal(d.action, "throttle");
  assert.equal(d.reason, "source_failure_volume");
});

test("an attacker guessing one account correctly does not erase the stuffing evidence", () => {
  for (let i = 0; i < CFG.sourceDistinctAccountLimit; i++) {
    recordLoginFailure(`user${i}@victim.com`, "45.148.10.151", T0 + i);
  }
  recordLoginSuccess("user0@victim.com");
  const d = evaluateLoginAttempt("user50@victim.com", "45.148.10.151", T0 + 900);
  assert.equal(d.reason, "credential_stuffing", "source history must survive one success");
});

// ---------------------------------------------------------------------------
// Explainability + safety.
// ---------------------------------------------------------------------------

test("every non-allow decision carries a human-readable reason (Phase 41)", () => {
  for (let i = 0; i < CFG.sourceDistinctAccountLimit; i++) {
    recordLoginFailure(`u${i}@v.com`, "1.2.3.4", T0 + i);
  }
  const d = evaluateLoginAttempt("u99@v.com", "1.2.3.4", T0 + 10);
  assert.ok(d.detail.length > 20 && /\d/.test(d.detail));
});

test("IPv6 is bucketed to /64, IPv4 is used whole", () => {
  assert.equal(
    normalizeSourceKey("2001:db8:1234:5678:abcd:ef01:2345:6789"),
    "2001:db8:1234:5678::/64",
  );
  assert.equal(normalizeSourceKey("203.0.113.9"), "203.0.113.9");
  assert.equal(normalizeSourceKey(""), "unknown");
  assert.equal(normalizeSourceKey(undefined), "unknown");
});

test("rotating the last IPv6 hextet does not buy a fresh budget", () => {
  for (let i = 0; i < CFG.sourceDistinctAccountLimit; i++) {
    recordLoginFailure(`u${i}@v.com`, `2001:db8:1:2:3:4:5:${i}`, T0 + i);
  }
  const d = evaluateLoginAttempt("u99@v.com", "2001:db8:1:2:3:4:5:ffff", T0 + 10);
  assert.equal(d.reason, "credential_stuffing");
});

// ---------------------------------------------------------------------------
// Client IP resolution — the detail that would have caused a platform-wide outage.
// ---------------------------------------------------------------------------

test("X-Forwarded-For: the LAST entry wins (nginx appends the real peer)", () => {
  assert.equal(clientIpFromForwardedFor("203.0.113.9"), "203.0.113.9");
  assert.equal(clientIpFromForwardedFor("10.0.0.1, 203.0.113.9"), "203.0.113.9");
  assert.equal(clientIpFromForwardedFor(" 10.0.0.1 , 203.0.113.9 "), "203.0.113.9");
});

test("a client-forged X-Forwarded-For cannot fake the source", () => {
  // Attacker sends "X-Forwarded-For: 1.2.3.4"; nginx appends their real address.
  const spoofed = clientIpFromForwardedFor("1.2.3.4, 45.148.10.151");
  assert.equal(spoofed, "45.148.10.151", "must ignore the attacker-supplied prefix");
  assert.notEqual(spoofed, "1.2.3.4");
});

test("forged XFF cannot be used to poison a victim into a block", () => {
  for (let i = 0; i < CFG.sourceDistinctAccountLimit; i++) {
    // Attacker claims to be the victim's IP, but is really 45.148.10.151.
    const ip = clientIpFromForwardedFor(`50.49.206.161, 45.148.10.151`);
    recordLoginFailure(`u${i}@v.com`, ip, T0 + i);
  }
  // The innocent IP the attacker tried to frame is still clean.
  const victim = evaluateLoginAttempt("izzy@example.com", "50.49.206.161", T0 + 10);
  assert.equal(victim.action, "allow");
  // The attacker's real address is blocked.
  const attacker = evaluateLoginAttempt("u99@v.com", "45.148.10.151", T0 + 10);
  assert.equal(attacker.reason, "credential_stuffing");
});

test("missing X-Forwarded-For yields 'unknown', not an empty bypass", () => {
  assert.equal(clientIpFromForwardedFor(undefined), "unknown");
  assert.equal(clientIpFromForwardedFor(""), "unknown");
  assert.equal(clientIpFromForwardedFor(" , "), "unknown");
});

test("LOGIN_THROTTLE_DISABLED=1 is the only off switch", () => {
  for (let i = 0; i < CFG.sourceDistinctAccountLimit; i++) {
    recordLoginFailure(`u${i}@v.com`, "1.2.3.4", T0 + i);
  }
  process.env.LOGIN_THROTTLE_DISABLED = "1";
  assert.equal(evaluateLoginAttempt("u99@v.com", "1.2.3.4", T0 + 10).action, "allow");
});

test("an unknown source IP cannot be used to dodge the account counter", () => {
  for (let i = 0; i < CFG.accountFailureLimit; i++) {
    recordLoginFailure("victim@example.com", undefined, T0 + i);
  }
  assert.equal(evaluateLoginAttempt("victim@example.com", undefined, T0 + 1).action, "throttle");
});
