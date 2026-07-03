// String-shape regression tests for the [connect-wake-core] engine emitted by
// install-connect-wake-dialplan.sh. We do NOT run the installer in CI (it needs
// root, asterisk, and a VitalPBX host). Instead we assert the generated engine
// embeds the exact runtime contract the wake fix depends on:
//
//   * The ConnectWake UserEvent fires EXACTLY ONCE per invocation.
//   * The emit happens BEFORE the warm/cold branch, so BOTH a warm (live
//     contact) and a cold endpoint emit the wake push (fire-and-forget). This
//     is the fix for the IVR -> T2/110 regression where a reconnecting mobile
//     WebSocket contact made the warm branch skip the wake entirely.
//   * The ARG3 != 1 gate still precedes the emit, so a probe-only (wake
//     disabled) invocation never emits.
//   * The warm path returns immediately with NO grace wait (no Wait/loop).
//   * The cold path keeps the full grace loop (Wait + re-probe + decrement).
//   * The cold path injects in-band ringback (Playtones(ring)) on already-
//     answered legs (arriving via the IVR, CHANNEL(state)=Up) so the caller
//     hears ringing instead of dead air during the grace wait, and StopPlaytones
//     runs on every cold exit before control returns to the caller's Dial. This
//     is the fix for the IVR -> T2/110 no-answer case where an unreachable
//     device produced ~20s of silence before voicemail.
//   * The CallId fix is preserved: CHANNEL(linkedid) fallback to UNIQUEID.
//   * The engine never Answers/Dials/bridges/Local — probe + Gosub-return only.
//   * App-reported mobile DND (connect/dnd/T<tid>_<ext>, Connect-owned — NOT
//     VitalPBX's native feature-code DND) short-circuits BEFORE the contact
//     probe/UserEvent/Playtones/grace loop, and fails open (falls through to
//     the unchanged probe path) on every ambiguous case: missing key, "0",
//     missing/malformed/future/stale timestamp.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(__dirname, "install-connect-wake-dialplan.sh"), "utf8");
const BRAIN = readFileSync(
  join(__dirname, "..", "..", "docs", "pbx", "option-a-custom-context.conf"),
  "utf8",
);

// Extract the [connect-wake-core] context body (up to the next [context] header).
// The header must be anchored to the start of a line (multiline flag) so we do
// NOT match the literal "[connect-wake-core]" that appears inside comments in the
// preceding [connect-dial-with-wake] block. Files are CRLF, so allow \r.
function wakeCore(source: string): string {
  const m = source.match(/^\[connect-wake-core\][^\r\n]*\r?\n([\s\S]*?)\r?\n\[/m);
  assert.ok(m, "could not locate [connect-wake-core] block");
  return m![1];
}

test("emits exactly one ConnectWake UserEvent per invocation", () => {
  const body = wakeCore(SCRIPT);
  const emits = body.match(/UserEvent\(ConnectWake/g) ?? [];
  assert.equal(emits.length, 1, "must emit ConnectWake exactly once");
});

test("wake emission precedes the warm branch AND the grace loop (both paths emit)", () => {
  const body = wakeCore(SCRIPT);
  const emitIdx = body.indexOf("UserEvent(ConnectWake");
  const warmBranchIdx = body.indexOf('GotoIf($["${WARM}" = "1"]?warm)');
  const loopIdx = body.indexOf("n(loop),GotoIf");
  assert.ok(emitIdx > -1, "emit present");
  assert.ok(warmBranchIdx > -1, "warm branch GotoIf present");
  assert.ok(loopIdx > -1, "grace loop present");
  assert.ok(emitIdx < warmBranchIdx, "emit must come before the warm branch");
  assert.ok(emitIdx < loopIdx, "emit must come before the grace loop");
});

test("WARM is computed from the contact probe before the ARG3 gate", () => {
  const body = wakeCore(SCRIPT);
  const warmSetIdx = body.indexOf("Set(WARM=");
  const arg3Idx = body.indexOf('GotoIf($["${ARG3}" != "1"]?done)');
  assert.ok(warmSetIdx > -1, "WARM flag is set");
  assert.ok(arg3Idx > -1, "ARG3 gate present");
  assert.ok(warmSetIdx < arg3Idx, "WARM computed before the ARG3 gate");
  assert.match(
    body,
    /Set\(WARM=\$\{IF\(\$\[\$\[\$\{LEN\(\$\{CONTACTS_PRIMARY\}\)\} > 0\] \| \$\[\$\{LEN\(\$\{CONTACTS_SECONDARY\}\)\} > 0\]\]\?1:0\)\}\)/,
  );
});

test("wake is gated by ARG3 == 1 (no emit when wake disabled)", () => {
  const body = wakeCore(SCRIPT);
  const arg3Idx = body.indexOf('GotoIf($["${ARG3}" != "1"]?done)');
  const emitIdx = body.indexOf("UserEvent(ConnectWake");
  assert.ok(arg3Idx > -1 && arg3Idx < emitIdx, "ARG3 gate must precede the emit");
});

test("warm path returns immediately with NO grace wait", () => {
  const body = wakeCore(SCRIPT);
  // Between the (warm) label and its Return there must be NOTHING but the NoOp.
  const m = body.match(/n\(warm\),NoOp[^\n]*\n\s*same =>\s*n,Return\(\)/);
  assert.ok(m, "warm label must be NoOp then Return with nothing in between");
});

test("cold path still has the grace loop (Wait + re-probe + decrement + registered)", () => {
  const body = wakeCore(SCRIPT);
  assert.match(body, /n\(loop\),GotoIf\(\$\[\$\{GRACE_LEFT\} <= 0\]\?expired\)/);
  assert.match(body, /same =>\s*n,Wait\(1\)/);
  assert.match(body, /Set\(GRACE_LEFT=\$\[\$\{GRACE_LEFT\} - 1\]\)/);
  assert.match(body, /\?registered\)/);
});

test("cold path injects in-band ringback on already-answered (IVR) legs before the loop", () => {
  const body = wakeCore(SCRIPT);
  // Injected only when the channel is already Up (past SIP answer, e.g. via IVR).
  assert.match(
    body,
    /ExecIf\(\$\["\$\{CHANNEL\(state\)\}" = "Up"\]\?Playtones\(ring\)\)/,
    "must inject Playtones(ring) on Up channels",
  );
  // Ringback must start before the grace loop begins.
  const ringIdx = body.indexOf("?Playtones(ring)");
  const loopIdx = body.indexOf("n(loop),GotoIf");
  assert.ok(ringIdx > -1 && loopIdx > -1 && ringIdx < loopIdx, "ringback must start before the loop");
  // Exactly one ringback start; and it lives on the cold path (after the warm branch).
  assert.equal((body.match(/Playtones\(ring\)/g) ?? []).length, 1);
  const warmBranchIdx = body.indexOf('GotoIf($["${WARM}" = "1"]?warm)');
  assert.ok(warmBranchIdx > -1 && warmBranchIdx < ringIdx, "ringback is cold-path only (after warm branch)");
  // Unanswered legs keep the standard early-media 180 ringback.
  assert.match(body, /ExecIf\(\$\["\$\{CHANNEL\(state\)\}" != "Up"\]\?Progress\(\)\)/);
  assert.match(body, /ExecIf\(\$\["\$\{CHANNEL\(state\)\}" != "Up"\]\?Ringing\(\)\)/);
});

test("ringback is stopped on every cold exit before returning to the caller", () => {
  const body = wakeCore(SCRIPT);
  assert.match(
    body,
    /n\(registered\),NoOp[^\n]*\n\s*same =>\s*n,StopPlaytones\(\)\n\s*same =>\s*n,Return\(\)/,
    "registered exit must StopPlaytones before Return",
  );
  assert.match(
    body,
    /n\(expired\),NoOp[^\n]*\n\s*same =>\s*n,StopPlaytones\(\)\n\s*same =>\s*n,Return\(\)/,
    "expired exit must StopPlaytones before Return",
  );
  // Exactly two StopPlaytones (registered + expired). The warm/done exits never
  // start tones, so they must NOT StopPlaytones.
  assert.equal((body.match(/StopPlaytones\(\)/g) ?? []).length, 2);
});

test("CallId fix preserved: CHANNEL(linkedid) fallback to UNIQUEID", () => {
  const body = wakeCore(SCRIPT);
  assert.match(
    body,
    /CallId: \$\{IF\(\$\["\$\{CHANNEL\(linkedid\)\}" != ""\]\?\$\{CHANNEL\(linkedid\)\}:\$\{UNIQUEID\}\)\}/,
  );
});

test("engine never Answers/Dials/bridges/Local/VoiceMail — probe + Gosub-return only", () => {
  const body = wakeCore(SCRIPT);
  for (const forbidden of [/\bAnswer\s*\(/i, /\bDial\s*\(/i, /\bLocal\//i, /\bVoiceMail\s*\(/i, /\bOriginate\b/i, /\bPlayback\s*\(/i]) {
    assert.equal(forbidden.test(body), false, `engine must not contain ${forbidden}`);
  }
});

test("app DND short-circuit reads connect/dnd BEFORE the contact probe, UserEvent, Playtones, and grace loop", () => {
  const body = wakeCore(SCRIPT);
  const dndReadIdx = body.indexOf("Set(APP_DND=${DB(connect/dnd/T${TID}_${EXT})})");
  const probeLabelIdx = body.indexOf("n(probe),Set(EP_PRIMARY=");
  const emitIdx = body.indexOf("UserEvent(ConnectWake");
  const ringIdx = body.indexOf("?Playtones(ring)");
  const loopIdx = body.indexOf("n(loop),GotoIf");
  assert.ok(dndReadIdx > -1, "connect/dnd read present");
  assert.ok(probeLabelIdx > -1, "(probe) label present on the (formerly first) contact-probe line");
  assert.ok(dndReadIdx < probeLabelIdx, "DND read must precede the contact probe");
  assert.ok(dndReadIdx < emitIdx, "DND read must precede UserEvent(ConnectWake)");
  assert.ok(dndReadIdx < ringIdx, "DND read must precede Playtones(ring)");
  assert.ok(dndReadIdx < loopIdx, "DND read must precede the grace loop");
});

test("app DND short-circuit only skips wake on an exact '1' — everything else falls through to (probe)", () => {
  const body = wakeCore(SCRIPT);
  assert.match(body, /GotoIf\(\$\["\$\{APP_DND\}" != "1"\]\?probe\)/, "non-'1' values (missing key, '0', anything else) must fall through to (probe)");
});

test("app DND freshness: missing/malformed/future/stale timestamp all fall through to (probe)", () => {
  const body = wakeCore(SCRIPT);
  // Missing timestamp (LEN = 0).
  assert.match(body, /GotoIf\(\$\[\$\{LEN\(\$\{APP_DND_TS\}\)\} = 0\]\?probe\)/);
  // Malformed (non-digit) timestamp via FILTER(0-9,...) round-trip check.
  assert.match(body, /GotoIf\(\$\["\$\{APP_DND_TS\}" != "\$\{FILTER\(0-9,\$\{APP_DND_TS\}\)\}"\]\?probe\)/);
  // Future timestamp (negative age) fails open too.
  assert.match(body, /GotoIf\(\$\[\$\{APP_DND_AGE\} < 0\]\?probe\)/);
  // Stale timestamp (older than the TTL) falls open.
  assert.match(body, /GotoIf\(\$\[\$\{APP_DND_AGE\} > \$\{DND_TTL_SECS\}\]\?probe\)/);
});

test("app DND TTL constant is 72 hours (259200s), named and documented", () => {
  const body = wakeCore(SCRIPT);
  assert.match(body, /Set\(DND_TTL_SECS=259200\)/);
});

test("app DND fresh-and-true path Returns immediately without touching WARM/contacts/UserEvent/grace", () => {
  const body = wakeCore(SCRIPT);
  // The DND-active NoOp must be followed by nothing but Return(), then the (probe) label —
  // i.e. no Set(EP_PRIMARY/WARM/...), no UserEvent, no grace Set/loop in between.
  const m = body.match(
    /NoOp\(connect-wake-core app DND active[^\n]*\n\s*same =>\s*n,Return\(\)\n\s*same =>\s*n\(probe\),Set\(EP_PRIMARY=/,
  );
  assert.ok(m, "DND-active branch must be NoOp then Return() then straight into the (probe) label with nothing in between");
});

test("brain mirror stays in sync with the installer engine on the fix-critical lines", () => {
  const script = wakeCore(SCRIPT);
  const brain = wakeCore(BRAIN);
  for (const needle of [
    "Set(WARM=",
    'GotoIf($["${WARM}" = "1"]?warm)',
    "CallId: ${IF($[\"${CHANNEL(linkedid)}\" != \"\"]?${CHANNEL(linkedid)}:${UNIQUEID})}",
    'ExecIf($["${CHANNEL(state)}" = "Up"]?Playtones(ring))',
    "StopPlaytones()",
    "Set(DND_TTL_SECS=259200)",
    "Set(APP_DND=${DB(connect/dnd/T${TID}_${EXT})})",
    "Set(APP_DND_TS=${DB(connect/dnd_ts/T${TID}_${EXT})})",
    "n(probe),Set(EP_PRIMARY=",
  ]) {
    assert.ok(script.includes(needle), `installer engine missing: ${needle}`);
    assert.ok(brain.includes(needle), `brain mirror missing: ${needle}`);
  }
  // Both emit ConnectWake exactly once.
  assert.equal((script.match(/UserEvent\(ConnectWake/g) ?? []).length, 1);
  assert.equal((brain.match(/UserEvent\(ConnectWake/g) ?? []).length, 1);
  // Both start ringback exactly once and stop it on the two cold exits.
  assert.equal((script.match(/Playtones\(ring\)/g) ?? []).length, 1);
  assert.equal((brain.match(/Playtones\(ring\)/g) ?? []).length, 1);
  assert.equal((script.match(/StopPlaytones\(\)/g) ?? []).length, 2);
  assert.equal((brain.match(/StopPlaytones\(\)/g) ?? []).length, 2);
});
