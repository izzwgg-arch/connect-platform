/**
 * Guards on the portal's call-waiting audio (2026-08-20).
 *
 * ⛔ THE DEFECT: when a second call arrived while the user was already on a
 * call, the portal called the SAME `startRingtone()` as an idle incoming call —
 * a full, looping, deliberately-loud ringtone blasted over a live conversation.
 * The branch was even labelled "call-waiting"; only the audio was wrong. The
 * mobile app has always done this correctly: one short high beep, repeating,
 * and never the ringtone.
 *
 * There are TWO incoming-call paths in useSipPhone.ts — the primary UA and the
 * extra-SIP-account engine (`startAccountEngine`) — and both had the bug. A fix
 * to one is invisible in the other, which is the recurring defect shape in this
 * repo, so these guards assert on BOTH.
 *
 * Source-reading on purpose: the defect is which function a branch calls, and a
 * unit test of the audio hook passes straight through a caller that picks the
 * wrong one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// CRLF-normalise: Windows checkouts are CRLF and literal-\n matching breaks.
const read = (...p: string[]) =>
  readFileSync(path.join(__dirname, "..", ...p), "utf8").replace(/\r\n/g, "\n");

const sip = read("hooks", "useSipPhone.ts");
const audio = read("hooks", "useTelephonyAudio.ts");

/** Strip comments so the doc blocks describing the old bug can't satisfy a guard. */
function executable(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

test("the audio hook exposes a call-waiting alert", () => {
  assert.ok(/startCallWaitingAlert/.test(audio), "startCallWaitingAlert must exist");
  assert.ok(/stopCallWaitingAlert/.test(audio), "stopCallWaitingAlert must exist");
  const exported = audio.slice(audio.lastIndexOf("return {"));
  assert.ok(exported.includes("startCallWaitingAlert"), "must be returned from the hook");
  assert.ok(exported.includes("stopCallWaitingAlert"), "must be returned from the hook");
});

test("the beep is a SHORT one-shot, repeating — never a looping ringtone", () => {
  const src = executable(audio);
  // A single burst per tick. `loop = true` belongs to the ringtone only.
  assert.ok(
    /playToneBurst\([\s\S]{0,120}CALL_WAITING_BEEP_MS/.test(src),
    "the alert must play a bounded tone burst",
  );
  assert.ok(
    /CALL_WAITING_BEEP_MS\s*=\s*\d{2,3}\b/.test(src),
    "the beep length must be a short constant (milliseconds)",
  );
  const beepMs = Number(/CALL_WAITING_BEEP_MS\s*=\s*(\d+)/.exec(src)?.[1] ?? "0");
  assert.ok(beepMs > 0 && beepMs <= 400, `beep must be short, got ${beepMs}ms`);
  const repeatMs = Number(/CALL_WAITING_REPEAT_MS\s*=\s*(\d+)/.exec(src)?.[1] ?? "0");
  assert.ok(repeatMs >= 2000, `repeat gap must not be a machine-gun, got ${repeatMs}ms`);
});

test("BOTH incoming paths use the beep for a second call, not the ringtone", () => {
  const src = executable(sip);
  // Each incoming handler branches: idle -> startRingtone, busy -> beep.
  const branches = [
    ...src.matchAll(
      /if \(!sessionRef\.current \|\| sessionRef\.current\.isEnded\?\.\(\)\) \{([\s\S]*?)\} else \{([\s\S]*?)\n\s{14}\}/g,
    ),
  ];
  assert.equal(branches.length, 2, "both the primary UA and the account engine must be covered");
  for (const [, idle, busy] of branches) {
    assert.ok(idle.includes("startRingtone()"), "the idle path still rings normally");
    assert.ok(
      busy.includes("startCallWaitingAlert()"),
      "a call arriving while another is live must BEEP",
    );
    assert.ok(
      !busy.includes("startRingtone()"),
      "the full ringtone must never play over a live call",
    );
  }
});

test("the beep is stopped when the waiting call resolves", () => {
  const src = executable(sip);
  // Answered / declined / caller gave up — each must settle the alert.
  assert.ok(
    /settleCallWaitingAlert/.test(src),
    "a settle helper must exist so the beep cannot outlive the waiting call",
  );
  const side = src.slice(src.indexOf("function bindSideSession"));
  const body = side.slice(0, side.indexOf("\n  }\n") + 5);
  for (const evt of ["ended", "failed", "accepted", "confirmed"]) {
    const at = body.indexOf(`session.on("${evt}"`);
    assert.ok(at > 0, `bindSideSession must handle "${evt}"`);
    assert.ok(
      body.slice(at, at + 500).includes("settleCallWaitingAlert"),
      `"${evt}" must settle the call-waiting alert`,
    );
  }
});

test("stopAll clears the repeating beep, so no path can leave it running", () => {
  const src = executable(audio);
  const at = src.indexOf("const stopAll =");
  assert.ok(at > 0, "stopAll must exist");
  const body = src.slice(at, at + 900);
  assert.ok(
    /callWaitingTimerRef/.test(body),
    "stopAll must clear the call-waiting timer or the beep survives hangup",
  );
});

test("declining a waiting call silences the beep immediately", () => {
  const src = executable(sip);
  const at = src.indexOf("const hangupSession =");
  assert.ok(at > 0, "hangupSession must exist");
  const body = src.slice(at, at + 700);
  // Excluding the declined id matters: its meta is only removed later, by the
  // async "ended" handler, so without it the beep runs on past the click.
  assert.ok(
    /settleCallWaitingAlert\(id\)/.test(body),
    "hangupSession must settle the alert excluding the declined session",
  );
});
