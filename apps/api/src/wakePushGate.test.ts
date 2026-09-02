/**
 * Wake-push quota work (2026-09-01 census):
 *   1. Pure unit tests of the one-WAKE-per-(call,user) gate.
 *   2. SOURCE guards on the CALL SITES in server.ts — the defect class here is
 *      always a sender that forgot the gate (or a "simplification" that gates
 *      the untouchable INCOMING_CALL push), which no unit test of the gate
 *      itself can see.
 *   3. SOURCE guards on fcmDirect.ts — HIGH must stay the default priority and
 *      UNREGISTERED must only ever be derived from a 404.
 *
 * All file reads are CRLF-normalised (source-reading-tests-must-normalise-crlf).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  WAKE_PUSH_GATE_TTL_MS,
  wakePushGateCheck,
  wakePushGateRecord,
  resetWakePushGateForTests,
} from "./wakePushGate";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const serverSrc = read(path.join(__dirname, "server.ts"));
const fcmSrc = read(path.join(__dirname, "fcmDirect.ts"));

// ── Unit: gate semantics ─────────────────────────────────────────────────────

test("first wake for a (call, user) is allowed; a second inside the TTL is not", () => {
  resetWakePushGateForTests();
  const now = 1_000_000;
  assert.equal(wakePushGateCheck("call-1", "user-a", now), true);
  wakePushGateRecord("call-1", "user-a", now);
  assert.equal(wakePushGateCheck("call-1", "user-a", now + 1_000), false);
  assert.equal(wakePushGateCheck("call-1", "user-a", now + WAKE_PUSH_GATE_TTL_MS - 1), false);
  assert.equal(wakePushGateCheck("call-1", "user-a", now + WAKE_PUSH_GATE_TTL_MS), true);
});

test("the gate is keyed per (call, user) — other users and other calls are independent", () => {
  resetWakePushGateForTests();
  const now = 2_000_000;
  wakePushGateRecord("call-1", "user-a", now);
  // Same call, different user — the multi-user fan-out (Fixup class) must
  // still wake every person once.
  assert.equal(wakePushGateCheck("call-1", "user-b", now + 10), true);
  // Same user, different call — a second inbound call moments later must wake.
  assert.equal(wakePushGateCheck("call-2", "user-a", now + 10), true);
});

test("check() is a pure read — it never records", () => {
  resetWakePushGateForTests();
  const now = 3_000_000;
  assert.equal(wakePushGateCheck("call-x", "user-x", now), true);
  // A second check without a record must STILL allow: the prewake cooldown
  // gate may refuse between check and send, and that refusal must not eat the
  // call's one wake.
  assert.equal(wakePushGateCheck("call-x", "user-x", now + 5), true);
});

test("a missing call id or user id always allows (no identity = no safe dedupe)", () => {
  resetWakePushGateForTests();
  assert.equal(wakePushGateCheck(null, "user-a"), true);
  assert.equal(wakePushGateCheck("", "user-a"), true);
  assert.equal(wakePushGateCheck("call-1", null), true);
  wakePushGateRecord(null, "user-a");
  wakePushGateRecord("call-1", null);
  assert.equal(wakePushGateCheck("call-1", "user-a"), true);
});

test("WAKE_PUSH_GATE_DISABLED=1 restores the pre-gate fan-out", () => {
  resetWakePushGateForTests();
  const now = 4_000_000;
  wakePushGateRecord("call-k", "user-k", now);
  process.env.WAKE_PUSH_GATE_DISABLED = "1";
  try {
    assert.equal(wakePushGateCheck("call-k", "user-k", now + 10), true);
  } finally {
    delete process.env.WAKE_PUSH_GATE_DISABLED;
  }
  assert.equal(wakePushGateCheck("call-k", "user-k", now + 10), false);
});

// ── Source guards: the call sites ────────────────────────────────────────────
// Strip comment-only lines so a doc block quoting the forbidden/required shape
// can never satisfy (or fail) an assertion — the documented trap, hit five
// times in this repo.
const serverCode = serverSrc
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.trim()))
  .join("\n");

test("all three WAKE senders in server.ts consult the gate (ring-notify, prewake, wake-extension)", () => {
  const checks = serverCode.match(/wakePushGateCheck\(/g) ?? [];
  const records = serverCode.match(/wakePushGateRecord\(/g) ?? [];
  assert.equal(checks.length, 3, "expected exactly 3 wakePushGateCheck call sites");
  assert.equal(records.length, 3, "expected exactly 3 wakePushGateRecord call sites");
  // Each site records its suppression so a call timeline explains the missing
  // WAKE instead of reading like a lost push.
  const suppressed = serverCode.match(/"WAKE_SUPPRESSED_DUPLICATE"/g) ?? [];
  assert.equal(suppressed.length, 3, "each gated site must record WAKE_SUPPRESSED_DUPLICATE");
});

test("prewake checks the wake gate BEFORE burning the per-user cooldown", () => {
  const loop = serverCode.slice(
    serverCode.indexOf("for (const userId of candidateUserIds)"),
    serverCode.indexOf("PREWAKE_PUSH_QUEUED"),
  );
  const gateIdx = loop.indexOf("wakePushGateCheck(input.linkedId, userId)");
  const cooldownIdx = loop.indexOf("prewakeCooldownGate(tenantId, userId)");
  assert.ok(gateIdx >= 0, "prewake loop must consult wakePushGateCheck");
  assert.ok(cooldownIdx >= 0, "prewake loop must keep prewakeCooldownGate");
  assert.ok(
    gateIdx < cooldownIdx,
    "wake gate must run before the cooldown gate — a gate-refused wake must not spend the cooldown",
  );
});

test("wake-extension answers AS IF QUEUED on suppression — the dialplan's wait behaviour must not change", () => {
  const site = serverCode.slice(
    serverCode.indexOf("wakePushGateCheck(input.pbxCallId, target.userId)"),
  );
  const suppressionReply = site.slice(0, site.indexOf("let pushResult"));
  assert.ok(
    suppressionReply.includes("devicesNotified: devices.length"),
    "suppressed wake-extension must report the device count, not 0 — the earlier wake IS in flight",
  );
  assert.ok(suppressionReply.includes("suppressedDuplicate: true"));
});

test("the INCOMING_CALL ring push is NEVER gated — only the caller-less WAKEs are", () => {
  // Every wakePushGateCheck call site must sit next to an INCOMING_CALL_WAKE
  // payload, never an INCOMING_CALL one. Inspect a window after each check.
  let idx = -1;
  let sites = 0;
  while ((idx = serverCode.indexOf("wakePushGateCheck(", idx + 1)) >= 0) {
    sites += 1;
    const windowAfter = serverCode.slice(idx, idx + 3000);
    const wake = windowAfter.indexOf('type: "INCOMING_CALL_WAKE"');
    const ring = windowAfter.indexOf('type: "INCOMING_CALL",');
    assert.ok(
      wake >= 0 && (ring === -1 || wake < ring),
      `gate site #${sites} must guard an INCOMING_CALL_WAKE send, not the INCOMING_CALL ring push`,
    );
  }
  assert.equal(sites, 3);
});

test("the api never sends a NORMAL-priority direct-FCM push — that option is the worker watchdog's alone", () => {
  assert.ok(!serverCode.includes('priority: "NORMAL"'), "apps/api must not pass NORMAL to sendFcmDirectData");
  assert.ok(!serverCode.includes("fcmPriority"), "apps/api sendPushToUserDevices has no fcmPriority input");
});

test("api FCM_DIRECT_FAILED retires the device row ONLY on the typed UNREGISTERED signal", () => {
  const site = serverCode.indexOf("fcm_unregistered_deactivated");
  assert.ok(site >= 0, "api must deactivate on FCM UNREGISTERED");
  const before = serverCode.slice(Math.max(0, site - 1500), site);
  assert.ok(
    before.includes("err instanceof FcmSendError && err.unregistered"),
    "deactivation must be gated on the typed FcmSendError.unregistered — never a string match or a bare catch",
  );
  const around = serverCode.slice(Math.max(0, site - 400), site + 400);
  assert.ok(around.includes("deactivatedAt: new Date()"), "deactivation must stamp deactivatedAt");
});

// ── Source guards: fcmDirect.ts ─────────────────────────────────────────────
const fcmCode = fcmSrc
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.trim()))
  .join("\n");

test("HIGH stays the default direct-FCM priority", () => {
  assert.ok(
    fcmCode.includes('options?.priority ?? "HIGH"'),
    "sendFcmDirectData must default to HIGH — every existing call-critical caller relies on it",
  );
});

test("UNREGISTERED is derived ONLY from a 404 — a 400 can be our bug and must never retire a token", () => {
  assert.ok(
    fcmCode.includes("res.status === 404 && /UNREGISTERED/i.test(text)"),
    "the unregistered flag must require HTTP 404",
  );
});
