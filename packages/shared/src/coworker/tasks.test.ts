import test from "node:test";
import assert from "node:assert/strict";
import {
  COWORKER_TASK_KINDS, COWORKER_FOLDERS, COWORKER_TASK_SPECS, COWORKER_TASK_TTL_MS,
  parseCoworkerTask, describeCoworkerTask, cleanReason, coworkerTaskApprovalSubject,
  coworkerTaskExpired, boundTaskResult, MAX_REASON_CHARS, MAX_RESULT_DETAILS,
} from "./tasks";
import { decideToolCall, DEFAULT_PERMISSIONS, NEVER_AUTO_DOMAINS, validateToolSpec } from "./index";

test("every kind has a spec, every spec is valid, and none is destructive, networked or exfiltrating", () => {
  for (const kind of COWORKER_TASK_KINDS) {
    const spec = COWORKER_TASK_SPECS[kind];
    const v = validateToolSpec(spec);
    assert.ok(v.ok, `${kind}: ${JSON.stringify((v as { problems?: unknown }).problems)}`);
    assert.equal(spec.destructive, false, `${kind} must not be destructive — v1 moves, never deletes`);
    assert.equal(spec.networked, false);
    assert.equal(spec.exfiltrationCapable, false);
    assert.equal(spec.maxRetries, 0, "a retried file move is a double move");
    for (const d of spec.domains) assert.ok(!NEVER_AUTO_DOMAINS.includes(d), `${kind} reaches a never-auto domain`);
  }
});

test("under the SAFE profile a read is allowed and a write asks — never denied, never silently allowed", () => {
  const read = decideToolCall({ spec: COWORKER_TASK_SPECS.folder_summary, permissions: DEFAULT_PERMISSIONS, provenance: "user", coworkerEnabled: true });
  assert.equal(read.verdict, "allow");
  const write = decideToolCall({ spec: COWORKER_TASK_SPECS.organize_folder, permissions: DEFAULT_PERMISSIONS, provenance: "user", coworkerEnabled: true });
  assert.equal(write.verdict, "ask");
  const snap = decideToolCall({ spec: COWORKER_TASK_SPECS.system_snapshot, permissions: DEFAULT_PERMISSIONS, provenance: "user", coworkerEnabled: true });
  assert.equal(snap.verdict, "allow");
});

test("an instruction that arrived from EXTERNAL content cannot run a write on its own — only the person's own press can", () => {
  const d = decideToolCall({ spec: COWORKER_TASK_SPECS.organize_folder, permissions: DEFAULT_PERMISSIONS, provenance: "external", coworkerEnabled: true });
  assert.notEqual(d.verdict, "allow");
  // The read tasks are the same: external provenance never turns into a silent allow.
  const r = decideToolCall({ spec: COWORKER_TASK_SPECS.folder_summary, permissions: DEFAULT_PERMISSIONS, provenance: "external", coworkerEnabled: true });
  assert.notEqual(r.verdict, "allow");
});

test("parse: only the three kinds, only the three folders, nothing else", () => {
  assert.equal(parseCoworkerTask({ kind: "organize_folder", folder: "downloads", reason: "tidy" }).ok, true);
  assert.equal(parseCoworkerTask({ kind: "system_snapshot", reason: "" }).ok, true);
  assert.deepEqual(parseCoworkerTask({ kind: "delete_folder", folder: "downloads" }), { ok: false, refused: "unknown_task_kind" });
  assert.deepEqual(parseCoworkerTask({ kind: "organize_folder", folder: "c:/windows" }), { ok: false, refused: "unknown_folder" });
  assert.deepEqual(parseCoworkerTask({ kind: "organize_folder", folder: "downloads", path: "C:/x" }), { ok: false, refused: "unexpected_field:path" });
  assert.deepEqual(parseCoworkerTask({ kind: "system_snapshot", command: "rm" }), { ok: false, refused: "unexpected_field:command" });
  assert.equal(parseCoworkerTask(null).ok, false);
  assert.equal(parseCoworkerTask("organize_folder").ok, false);
  assert.equal(parseCoworkerTask([]).ok, false);
});

test("the reason is cleaned: control characters, bidi overrides and length", () => {
  const nasty = "please \u202e\u0000tidy   my\u200b files " + "x".repeat(500);
  const r = cleanReason(nasty);
  assert.ok(!/[\u0000-\u001f\u200b\u202e]/.test(r));
  assert.ok(r.startsWith("please tidy my files"));
  assert.ok(r.length <= MAX_REASON_CHARS);
  assert.equal(cleanReason(42), "");
});

test("the card answers the four questions in plain words and names a folder, never a path", () => {
  const card = describeCoworkerTask({ kind: "organize_folder", folder: "downloads", reason: "You asked me to tidy up." });
  assert.match(card.title, /Organize your Downloads folder\?/);
  assert.match(card.what, /Nothing is deleted/);
  assert.match(card.where, /Downloads/);
  assert.equal(card.why, "You asked me to tidy up.");
  assert.match(card.reversible, /^Yes/);
  assert.equal(card.readOnly, false);
  assert.ok(!/[A-Za-z]:[\\/]/.test(card.where + card.what), "no path on the card");
  const snap = describeCoworkerTask({ kind: "system_snapshot", reason: "" });
  assert.equal(snap.readOnly, true);
  assert.match(snap.why, /You asked for this/);
});

test("the approval subject binds the task id, the tool name and the exact arguments", () => {
  const a = coworkerTaskApprovalSubject("t1", { kind: "organize_folder", folder: "downloads", reason: "r" });
  const b = coworkerTaskApprovalSubject("t1", { kind: "organize_folder", folder: "desktop", reason: "r" });
  const c = coworkerTaskApprovalSubject("t2", { kind: "organize_folder", folder: "downloads", reason: "r" });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.match(a, /coworker\.organize_folder/);
});

test("a proposal expires after the TTL", () => {
  assert.equal(coworkerTaskExpired(0, COWORKER_TASK_TTL_MS - 1), false);
  assert.equal(coworkerTaskExpired(0, COWORKER_TASK_TTL_MS + 1), true);
});

test("a reported result is bounded and cleaned", () => {
  const r = boundTaskResult({ ok: true, summary: "Moved 3 files\u0000", details: Array.from({ length: 40 }, (_, i) => `line ${i}`), code: "ok; drop table" });
  assert.ok(r);
  assert.equal(r!.summary, "Moved 3 files");
  assert.equal(r!.details!.length, MAX_RESULT_DETAILS);
  assert.equal(r!.code, "okdroptable");
  assert.equal(boundTaskResult({ ok: "yes", summary: "x" }), null);
  assert.equal(boundTaskResult("done"), null);
});

test("the folder list is by name only", () => {
  assert.deepEqual([...COWORKER_FOLDERS], ["downloads", "desktop", "documents"]);
});
