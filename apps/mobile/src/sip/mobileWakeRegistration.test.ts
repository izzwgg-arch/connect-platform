import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  decideRingRegister,
  IOS_PBX_CONTACT_DROP_MS,
  shouldForceRestartOnWake,
} from "./mobileWakeRegistration.js";

test("healthy PSTN wake does not forceRestart", () => {
  assert.equal(
    shouldForceRestartOnWake({ sipConnected: true, sipRegistered: true }),
    false,
  );
});

test("unhealthy wake still forceRestarts when not connected", () => {
  assert.equal(
    shouldForceRestartOnWake({ sipConnected: false, sipRegistered: true }),
    true,
  );
});

test("unhealthy wake still forceRestarts when not registered", () => {
  assert.equal(
    shouldForceRestartOnWake({ sipConnected: true, sipRegistered: false }),
    true,
  );
});

test("fully unhealthy wake forceRestarts", () => {
  assert.equal(
    shouldForceRestartOnWake({ sipConnected: false, sipRegistered: false }),
    true,
  );
});

// ── iOS stale-registration decision (Fixup Group 2026-09-04) ─────────────────
//
// The four "real" fixtures below are the registrationAgeMs / appState the
// iOS app itself reported in its WEBRTC_INBOUND_ANSWER_FAIL blackboxes:
//   Fixup 2026-09-04 14:12Z  registered, age 156 681, app in background
//   Fixup 2026-08-07         registered, age 162 675, app in background
// Both calls: PBX contact already dropped, INVITE never received.

test("ios, backgrounded, registration older than the qualify window → force_restart (Fixup 09-04)", () => {
  assert.equal(
    decideRingRegister({ platform: "ios", registrationState: "registered", registrationAgeMs: 156_681, appState: "background" }),
    "force_restart",
  );
});

test("ios, backgrounded, stale registration → force_restart (Fixup 08-07)", () => {
  assert.equal(
    decideRingRegister({ platform: "ios", registrationState: "registered", registrationAgeMs: 162_675, appState: "background" }),
    "force_restart",
  );
});

test("ios, inactive (lock screen) counts as not active → force_restart", () => {
  assert.equal(
    decideRingRegister({ platform: "ios", registrationState: "registered", registrationAgeMs: 45_000, appState: "inactive" }),
    "force_restart",
  );
});

test("the threshold IS the PBX qualify period (30 s), and it is strict", () => {
  assert.equal(IOS_PBX_CONTACT_DROP_MS, 30_000);
  assert.equal(
    decideRingRegister({ platform: "ios", registrationState: "registered", registrationAgeMs: 30_000, appState: "background" }),
    "skip",
  );
  assert.equal(
    decideRingRegister({ platform: "ios", registrationState: "registered", registrationAgeMs: 30_001, appState: "background" }),
    "force_restart",
  );
});

test("ios, FOREGROUND app with an old registration is never torn down mid-ring", () => {
  // A foreground app answers qualify, so its contact is alive however old
  // the registration is. Tearing it down would drop a deliverable INVITE.
  assert.equal(
    decideRingRegister({ platform: "ios", registrationState: "registered", registrationAgeMs: 156_681, appState: "active" }),
    "skip",
  );
});

test("ios, backgrounded but registered within the qualify window → skip (07-13 protection intact)", () => {
  assert.equal(
    decideRingRegister({ platform: "ios", registrationState: "registered", registrationAgeMs: 12_000, appState: "background" }),
    "skip",
  );
});

test("android is byte-identical to before: registered → skip regardless of age/state", () => {
  assert.equal(
    decideRingRegister({ platform: "android", registrationState: "registered", registrationAgeMs: 156_681, appState: "background" }),
    "skip",
  );
});

test("not registered → the pre-existing eager register, on every platform", () => {
  for (const platform of ["ios", "android"]) {
    for (const state of ["unregistered", "failed", "idle", ""]) {
      assert.equal(
        decideRingRegister({ platform, registrationState: state, registrationAgeMs: null, appState: "background" }),
        "register",
        `${platform}/${state}`,
      );
    }
  }
});

test("registering → skip (JsSIP's state machine owns an in-flight REGISTER)", () => {
  assert.equal(
    decideRingRegister({ platform: "ios", registrationState: "registering", registrationAgeMs: null, appState: "background" }),
    "skip",
  );
});

test("an unknown registration age never forces a restart", () => {
  for (const age of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      decideRingRegister({ platform: "ios", registrationState: "registered", registrationAgeMs: age as number | null, appState: "background" }),
      "skip",
      String(age),
    );
  }
});

// ── Source guard: the ring-push path must actually CALL the decision ────────
// The defect was a caller (the eager block skipped on "registered"); a unit
// test of decideRingRegister passes straight through a regression there.

function readSource(rel: string): string {
  const root = process.env.MOBILE_GUARD_ROOT ?? path.resolve(__dirname, "../..");
  return readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
}

function stripLineComments(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function eagerBlock(src: string): string {
  const start = src.indexOf("const hasActiveUaSession = hasOngoingCallRef.current");
  assert.ok(start > 0, "eager pre-register block not found");
  const end = src.indexOf("RING-TIME INVITE PRE-DELIVERY", start);
  assert.ok(end > start, "ring pre-delivery marker not found");
  return stripLineComments(src.slice(start, end));
}

test("guard: NotificationsContext's ring-push pre-register consults decideRingRegister", () => {
  const src = readSource("src/context/NotificationsContext.tsx");
  assert.ok(
    /import \{ decideRingRegister \} from "\.\.\/sip\/mobileWakeRegistration"/.test(src),
    "decideRingRegister must be imported from ../sip/mobileWakeRegistration",
  );
  const block = eagerBlock(src);
  assert.ok(block.includes("decideRingRegister({"), "eager block must call decideRingRegister");
  assert.ok(block.includes("platform: Platform.OS"), "decision must be given the real platform");
  assert.ok(block.includes("appState: AppState.currentState"), "decision must be given the live AppState");
  assert.ok(block.includes("getRegistrationAgeMs"), "decision must be given the client's registration age");
});

test("guard: a force_restart decision really re-registers with forceRestart", () => {
  const block = eagerBlock(readSource("src/context/NotificationsContext.tsx"));
  assert.ok(
    /decision === "force_restart"[\s\S]*?sip\.register\(\{ forceRestart: true \}\)/.test(block),
    "force_restart branch must call sip.register({ forceRestart: true })",
  );
});

test("guard: the old bare 'skip when registered' gate is gone from the eager block", () => {
  const block = eagerBlock(readSource("src/context/NotificationsContext.tsx"));
  assert.ok(
    !/if \(regState !== "registered" && regState !== "registering"\)/.test(block),
    "the eager block must not decide on regState alone any more",
  );
});
