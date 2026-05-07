// Phase B regression coverage for the PBX helper installer.
//
// The helper installer ships the dispatch + record dialplan body in TWO
// places that MUST stay in sync: the in-Python `CONNECT_VM_DIALPLAN_BODY`
// constant (used at helper boot to materialize the dialplan if the file
// is missing) and the bash heredoc that writes `${DIALPLAN_TARGET}` at
// install time. If either drifts, the installed dialplan and the helper's
// self-heal will diverge. We therefore assert the Phase B invariants
// twice (once per copy) on the same script file.
//
// We deliberately do NOT spin up Asterisk, MySQL, or systemd here — this
// is a string-shape test on the installer file, not an integration test.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = join(__dirname, "install-vitalpbx-inbound-route-helper.sh");
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

// ── Phase B: helper Python no longer overrides channel to direct PJSIP ────

test("helper installer no longer assigns direct_pjsip channel_source", () => {
  // The override block was on a single line `channel_source = "direct_pjsip:" + hint_raw`.
  // Phase B removed that assignment. Allow the string `direct_pjsip:` to appear in
  // comments / log lines but assert the assignment form is gone.
  assert.equal(
    countOccurrences(SCRIPT, "channel_source = \"direct_pjsip:"),
    0,
    "the direct_pjsip override assignment must not exist after Phase B",
  );
  assert.equal(
    countOccurrences(SCRIPT, "channel = \"PJSIP/\" + hint_raw"),
    0,
    "the direct PJSIP channel override line must not exist after Phase B",
  );
});

// ── Phase B: dispatch context dials with U(...) Gosub on answered party ───

test("helper installer dispatch dialplan calls Gosub via Dial U() — TWICE (Python const + bash heredoc)", () => {
  const dialU = "Dial(${CONNECT_VM_DIAL},30,U(connect-vm-greeting-record-sub^s^1^${CONNECT_VM_TENANT}^${CONNECT_VM_EXT}^${CONNECT_VM_FILE}))";
  assert.equal(
    countOccurrences(SCRIPT, dialU),
    2,
    "Dial(...,U(connect-vm-greeting-record-sub^s^1^...)) must appear exactly twice (Python const + bash heredoc)",
  );
});

test("helper installer defines the post-answer subroutine context — TWICE", () => {
  assert.equal(
    countOccurrences(SCRIPT, "[connect-vm-greeting-record-sub]"),
    2,
    "[connect-vm-greeting-record-sub] context must appear exactly twice (Python const + bash heredoc)",
  );
});

test("helper installer keeps the legacy [connect-vm-greeting-record] context for back-compat — TWICE", () => {
  assert.equal(
    countOccurrences(SCRIPT, "[connect-vm-greeting-record]"),
    2,
    "[connect-vm-greeting-record] legacy context must still be present (Python const + bash heredoc)",
  );
});

// ── Phase B: improved CallerID identity for vm-record originates ──────────

test("helper installer sets CALLERID(name)=Voicemail Greeting Recording in dispatch — TWICE", () => {
  assert.equal(
    countOccurrences(SCRIPT, "Set(CALLERID(name)=Voicemail Greeting Recording)"),
    2,
    "CALLERID(name)=Voicemail Greeting Recording must appear exactly twice (Python const + bash heredoc)",
  );
});

test("helper installer sets CALLERID(num)=${CONNECT_VM_EXT} in dispatch — TWICE", () => {
  assert.equal(
    countOccurrences(SCRIPT, "Set(CALLERID(num)=${CONNECT_VM_EXT})"),
    2,
    "CALLERID(num)=${CONNECT_VM_EXT} must appear exactly twice (Python const + bash heredoc)",
  );
});

// ── Phase B: AstDB fan-out + dispatch-only originate ──────────────────────

test("helper installer still populates AstDB connect_vm_dial fan-out", () => {
  assert.match(SCRIPT, /database put connect_vm_dial /);
  assert.match(SCRIPT, /channel_source = "dispatch_local:"/);
});

test("helper installer keeps Local/.../connect-vm-greeting-dispatch/n as the default channel template", () => {
  assert.match(
    SCRIPT,
    /Local\/\{recordingExten\}@connect-vm-greeting-dispatch\/n/,
    "the default originate channel template must remain dispatch-based",
  );
});

// ── Phase B: VERSION bump so /health surfaces post-deploy ────────────────

test("helper installer VERSION reflects Phase B build", () => {
  const m = SCRIPT.match(/^VERSION\s*=\s*"([^"]+)"/m);
  assert.ok(m, "VERSION constant must exist in the Python helper");
  const v = m![1];
  assert.ok(
    v.startsWith("2026.05.07") || v.localeCompare("2026.05.07") >= 0,
    "VERSION must be at or after the Phase B cut (2026.05.07.x), got " + v,
  );
});
