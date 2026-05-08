// Phase B + C regression coverage for the PBX helper installer.
//
// The helper installer ships the dispatch + record dialplan body in TWO
// places that MUST stay in sync: the in-Python `CONNECT_VM_DIALPLAN_BODY`
// constant (used at helper boot to materialize the dialplan if the file
// is missing) and the bash heredoc that writes `${DIALPLAN_TARGET}` at
// install time. If either drifts, the installed dialplan and the helper's
// self-heal will diverge. We therefore assert the Phase B/C invariants
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

test("helper installer dispatch dialplan calls Gosub via Dial U() with CONNECT_VM_CONTEXT — TWICE (Python const + bash heredoc)", () => {
  // Phase C: ARG1 is now the resolved voicemail context (CONNECT_VM_CONTEXT),
  // not the raw numeric tenant id (CONNECT_VM_TENANT). This ensures the
  // recording is written to the correct spool path (e.g. test-voicemail/101/).
  const dialU = "Dial(${CONNECT_VM_DIAL},30,U(connect-vm-greeting-record-sub^s^1^${CONNECT_VM_CONTEXT}^${CONNECT_VM_EXT}^${CONNECT_VM_FILE}))";
  assert.equal(
    countOccurrences(SCRIPT, dialU),
    2,
    "Dial(...,U(connect-vm-greeting-record-sub^s^1^${CONNECT_VM_CONTEXT}^...)) must appear exactly twice (Python const + bash heredoc)",
  );
});

test("helper installer dispatch dialplan no longer passes raw CONNECT_VM_TENANT as Gosub ARG1", () => {
  // The old Phase B form passed ${CONNECT_VM_TENANT} as ARG1.
  // Phase C replaces it with ${CONNECT_VM_CONTEXT} (the resolved context name).
  const oldDialU = "Dial(${CONNECT_VM_DIAL},30,U(connect-vm-greeting-record-sub^s^1^${CONNECT_VM_TENANT}^${CONNECT_VM_EXT}^${CONNECT_VM_FILE}))";
  assert.equal(
    countOccurrences(SCRIPT, oldDialU),
    0,
    "old Phase B Dial() form passing CONNECT_VM_TENANT as ARG1 must not exist after Phase C",
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

// ── Phase C: voicemail context resolution (fix wrong spool path) ──────────

test("helper installer defines resolve_voicemail_context_from_conf Python function", () => {
  assert.match(
    SCRIPT,
    /def resolve_voicemail_context_from_conf\(/,
    "resolve_voicemail_context_from_conf() must be defined in the Python helper",
  );
});

test("helper installer reads voicemail__50-<N>-main.conf to resolve context", () => {
  assert.match(
    SCRIPT,
    /voicemail__50.*main\.conf/,
    "installer must reference the VitalPBX voicemail conf filename pattern",
  );
});

test("helper installer populates AstDB connect_vm_context key in vm_record_call", () => {
  assert.match(
    SCRIPT,
    /database put connect_vm_context /,
    "vm_record_call must write the resolved voicemail context into AstDB connect_vm_context",
  );
});

test("helper installer dispatch reads CONNECT_VM_CONTEXT from AstDB — TWICE (Python const + bash heredoc)", () => {
  const lookup = "Set(CONNECT_VM_CONTEXT=${DB(connect_vm_context/T${CONNECT_VM_TENANT}_${CONNECT_VM_EXT})})";
  assert.equal(
    countOccurrences(SCRIPT, lookup),
    // dispatch context + legacy context = 4 total (2 copies × 2 contexts)
    4,
    "CONNECT_VM_CONTEXT AstDB lookup must appear in both dispatch and legacy contexts, in both Python const and bash heredoc (4 total)",
  );
});

test("helper installer record-sub uses CONNECT_VM_CONTEXT in spool path — TWICE (Python const + bash heredoc)", () => {
  const pathLine = "Set(CONNECT_VM_PATH=/var/spool/asterisk/voicemail/${CONNECT_VM_CONTEXT}/${CONNECT_VM_EXT}/${CONNECT_VM_FILE}.wav)";
  assert.equal(
    countOccurrences(SCRIPT, pathLine),
    // record-sub + legacy context = 4 total (2 copies × 2 contexts)
    4,
    "CONNECT_VM_PATH must use CONNECT_VM_CONTEXT (not CONNECT_VM_TENANT) in both subroutine and legacy context, in both copies (4 total)",
  );
});

test("helper installer record-sub no longer uses CONNECT_VM_TENANT in spool path", () => {
  const oldPathLine = "Set(CONNECT_VM_PATH=/var/spool/asterisk/voicemail/${CONNECT_VM_TENANT}/${CONNECT_VM_EXT}/${CONNECT_VM_FILE}.wav)";
  assert.equal(
    countOccurrences(SCRIPT, oldPathLine),
    0,
    "old CONNECT_VM_TENANT-based CONNECT_VM_PATH must not exist after Phase C",
  );
});

test("helper installer dispatch includes fallback: if CONNECT_VM_CONTEXT empty use CONNECT_VM_TENANT — TWICE", () => {
  const fallback = "Set(CONNECT_VM_CONTEXT=${CONNECT_VM_TENANT})";
  assert.equal(
    countOccurrences(SCRIPT, fallback),
    // dispatch + legacy = 4 total (2 copies × 2 contexts)
    4,
    "CONNECT_VM_CONTEXT fallback to CONNECT_VM_TENANT must appear in both dispatch and legacy contexts in both copies (4 total)",
  );
});

test("helper installer voicemail_mailbox_dir calls resolve_voicemail_context_from_conf", () => {
  // Both functions must exist and resolve_voicemail_context_from_conf must
  // be called somewhere inside the voicemail_mailbox_dir function body.
  // We verify by finding them in the expected order within 800 characters.
  assert.match(
    SCRIPT,
    /def voicemail_mailbox_dir[\s\S]{0,800}resolve_voicemail_context_from_conf/,
    "voicemail_mailbox_dir must call resolve_voicemail_context_from_conf to get the primary candidate directory",
  );
});

test("helper installer VERSION reflects Phase C build (2026.05.07.2 or later)", () => {
  const m = SCRIPT.match(/^VERSION\s*=\s*"([^"]+)"/m);
  assert.ok(m, "VERSION constant must exist");
  const v = m![1];
  assert.ok(
    v.localeCompare("2026.05.07.2") >= 0,
    "VERSION must be at or after Phase C cut (2026.05.07.2), got " + v,
  );
});

test("helper installer registers read-only voicemail spool list endpoint", () => {
  assert.match(
    SCRIPT,
    /"\/voicemail\/spool\/list"\s*:\s*vm_spool_list_messages/,
    "POST actions must include /voicemail/spool/list → vm_spool_list_messages",
  );
  assert.match(SCRIPT, /def vm_spool_list_messages/, "vm_spool_list_messages must be defined");
  assert.match(SCRIPT, /MAX_VM_SPOOL_MESSAGES/, "spool list must cap message count");
});
