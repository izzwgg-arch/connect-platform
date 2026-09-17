/**
 * copy-call-recordings — tests for the pure parts.
 *
 * ⛔ NO NETWORK, NO SSH, NO REAL PBX, NO PRISMA. These tests exercise the
 * functions that have nothing to do with the wire: day-folder grouping, the
 * PBX-filename → linkedId mapping, size verification, the resumable
 * progress file, --max-gb bounding, and — the one that matters most — a
 * guard that the ONLY remote command strings this module can ever produce
 * start with `ls`, `cd ... && stat`, or `cd ... && tar -c`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  splitPbxPath,
  groupByDayFolder,
  buildRemoteCommand,
  REMOTE_COMMAND_KINDS,
  sshArgv,
  parseLsOutput,
  verifyLocalSize,
  emptyProgress,
  loadProgress,
  saveProgress,
  markDone,
  isDone,
  boundGroupsByMaxGb,
} from "./copy-call-recordings";

// ── PBX path splitting + day-folder grouping ────────────────────────────────

test("splitPbxPath separates the day-folder from the filename", () => {
  const p = splitPbxPath("/var/spool/asterisk/monitor/abc123/2026/09/17/1758012345.678901.wav");
  assert.equal(p.dayFolder, "/var/spool/asterisk/monitor/abc123/2026/09/17");
  assert.equal(p.remoteFile, "1758012345.678901.wav");
});

test("groupByDayFolder groups calls from the same day into one round trip, and carries the linkedId mapping", () => {
  const groups = groupByDayFolder([
    { linkedId: "call-1", pbxPath: "/mon/t1/2026/09/17/aaa.wav" },
    { linkedId: "call-2", pbxPath: "/mon/t1/2026/09/17/bbb.wav" },
    { linkedId: "call-3", pbxPath: "/mon/t1/2026/09/18/ccc.wav" },
  ]);
  assert.equal(groups.length, 2, "two distinct day-folders");
  const day17 = groups.find((g) => g.dayFolder === "/mon/t1/2026/09/17")!;
  assert.equal(day17.files.length, 2);
  const byLinkedId = Object.fromEntries(day17.files.map((f) => [f.linkedId, f]));
  assert.equal(byLinkedId["call-1"].remoteFile, "aaa.wav");
  assert.equal(byLinkedId["call-1"].localName, "call-1.wav", "the PBX name is never kept — always <linkedId>.wav");
  assert.equal(byLinkedId["call-2"].remoteFile, "bbb.wav");
});

test("groupByDayFolder skips a candidate with no pbxPath rather than guessing a folder", () => {
  const groups = groupByDayFolder([{ linkedId: "x", pbxPath: "" }]);
  assert.equal(groups.length, 0);
});

// ── the remote-command guard ────────────────────────────────────────────────

test("buildRemoteCommand only ever emits ls / stat / tar -c, for every kind and a range of inputs", () => {
  const folders = ["/mon/t1/2026/09/17", "/weird '\" path/with spaces", "."];
  const fileLists = [[], ["a.wav"], ["a.wav", "b's file.wav", "c\"d.wav"]];
  const allowed = /^(ls -l '|cd '.*' && stat -c '%n %s'|cd '.*' && tar -c -f - )/;

  for (const kind of REMOTE_COMMAND_KINDS) {
    for (const folder of folders) {
      for (const files of fileLists) {
        const cmd = buildRemoteCommand(kind, folder, files);
        assert.match(cmd, allowed, `kind=${kind} folder=${folder} files=${JSON.stringify(files)} -> "${cmd}"`);
        // Never a write verb, whatever the inputs.
        for (const forbidden of [" -x ", " -x\n", "--delete", "--remove-files", " -u ", "rm -", " mv ", " dd ", " > ", " >> "]) {
          assert.ok(!cmd.includes(forbidden), `"${cmd}" must not contain "${forbidden}"`);
        }
      }
    }
  }
});

test("REMOTE_COMMAND_KINDS is exactly the read-only set — nothing to add a write kind to", () => {
  assert.deepEqual([...REMOTE_COMMAND_KINDS].sort(), ["ls", "stat", "tar-create"]);
});

test("buildRemoteCommand escapes a single quote instead of letting it close the argument", () => {
  const injected = "a.wav'; rm -rf / #";
  const cmd = buildRemoteCommand("tar-create", "/mon/t1", [injected]);
  // A literal single quote in the filename becomes '\'' (close-quote,
  // escaped-quote, reopen-quote) — the POSIX-correct way to embed one — never
  // a bare `'` that would end the quoted argument early.
  assert.ok(cmd.includes("'\\''"), "a single quote inside a filename must be escaped as '\\'' , not passed through raw");
  // The POSIX idiom for an embedded quote is close-escape-reopen: '\''. Once
  // every occurrence of that idiom is removed, every remaining quote must
  // still pair up — nothing escapes the quoted argument into a bare command.
  const withoutEscapedQuotes = cmd.split("'\\''").join("");
  assert.equal((withoutEscapedQuotes.match(/'/g) || []).length % 2, 0, "quotes must stay balanced — nothing escapes the argument");
});

test("sshArgv never runs a shell — the remote command is one argv element, not concatenated into a string", () => {
  const remoteCmd = buildRemoteCommand("ls", "/mon/t1/2026/09/17");
  const argv = sshArgv(remoteCmd, { keyFile: "/tmp/key" });
  assert.equal(argv[0], "ssh");
  assert.equal(argv[argv.length - 1], remoteCmd, "the remote command is its own argv element");
  assert.ok(argv.includes("-i"));
});

test("the module calls sshArgv only with strings that came from buildRemoteCommand", () => {
  const src = readFileSync(path.join(__dirname, "copy-call-recordings.ts"), "utf8");
  const builtNames = [...src.matchAll(/const\s+(\w+)\s*=\s*buildRemoteCommand\(/g)].map((m) => m[1]);
  assert.ok(builtNames.length >= 2, "expected at least the ls and tar-create call sites");
  const sshArgvCalls = [...src.matchAll(/sshArgv\(\s*(\w+)\s*,/g)].map((m) => m[1]);
  assert.ok(sshArgvCalls.length >= 2);
  for (const arg of sshArgvCalls) {
    assert.ok(builtNames.includes(arg), `sshArgv was called with "${arg}", which is not a buildRemoteCommand() result`);
  }
});

// ── ls -l parsing + size verification ───────────────────────────────────────

test("parseLsOutput reads name and size out of an ls -l listing", () => {
  const stdout =
    "total 24\n" +
    "-rw-r--r-- 1 asterisk asterisk 123456 Sep 17 10:00 1758012345.678901.wav\n" +
    "-rw-r--r-- 1 asterisk asterisk    987 Sep 17 10:05 1758012399.111222.wav\n" +
    "drwxr-xr-x 2 asterisk asterisk   4096 Sep 17 09:00 subdir\n";
  const entries = parseLsOutput(stdout);
  assert.equal(entries.length, 3);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e.size]));
  assert.equal(byName["1758012345.678901.wav"], 123456);
  assert.equal(byName["1758012399.111222.wav"], 987);
});

test("verifyLocalSize passes only on an exact match against a real remote entry", () => {
  assert.equal(verifyLocalSize(100, { name: "a.wav", size: 100 }).ok, true);
  assert.equal(verifyLocalSize(99, { name: "a.wav", size: 100 }).ok, false);
  assert.equal(verifyLocalSize(0, { name: "a.wav", size: 0 }).ok, false, "an empty file never verifies, even if remote agrees");
  assert.equal(verifyLocalSize(100, undefined).ok, false, "no remote listing entry -> refuse");
});

// ── resumable progress file ─────────────────────────────────────────────────

test("progress file round-trips and is resumable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "yc-copy-progress-"));
  const file = path.join(dir, "copy-call-recordings.json");
  try {
    assert.deepEqual(loadProgress(file), emptyProgress(), "missing file reads as empty, not an error");

    let state = emptyProgress();
    state = markDone(state, "call-1", 123456);
    saveProgress(file, state);

    const reloaded = loadProgress(file);
    assert.equal(isDone(reloaded, "call-1"), true);
    assert.equal(isDone(reloaded, "call-2"), false);
    assert.equal(reloaded.done["call-1"].bytes, 123456);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt progress file is treated as empty, never a crash", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "yc-copy-progress-bad-"));
  const file = path.join(dir, "bad.json");
  try {
    require("node:fs").writeFileSync(file, "{ not json");
    assert.deepEqual(loadProgress(file), emptyProgress());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── --max-gb bounding ────────────────────────────────────────────────────────

test("boundGroupsByMaxGb admits groups only up to the cap, but always at least one", () => {
  const gb = 1024 ** 3;
  const groups = [{ bytes: 0.4 * gb }, { bytes: 0.4 * gb }, { bytes: 0.4 * gb }];
  assert.equal(boundGroupsByMaxGb(groups, 1), 2, "0.4 + 0.4 = 0.8 fits under 1 GB; a third would exceed it");
  assert.equal(boundGroupsByMaxGb(groups, null), 3, "no cap = everything");
  assert.equal(boundGroupsByMaxGb(groups, 0), 3, "a zero/negative cap is treated as unbounded");
  const big = [{ bytes: 5 * gb }];
  assert.equal(boundGroupsByMaxGb(big, 1), 1, "a single group larger than the cap is still admitted — never zero progress");
});

// ── the PBX is read-only: the source file must never say otherwise ─────────

test("the CODE (not the doc comments) never deletes or overwrites anything on the PBX", () => {
  const src = readFileSync(path.join(__dirname, "copy-call-recordings.ts"), "utf8");
  // Strip block comments (/** ... */) and line comments so a doc line that
  // NAMES a forbidden flag, to say it is never used, doesn't trip this guard.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["rm -rf", "unlink(", "tar -x -f - ", "--remove-files"]) {
    // Guard against accidentally extracting ON the PBX (`tar -x ... ssh`) or
    // deleting/overwriting remote files. Local tar -x (extraction on THIS PC)
    // is fine and expected — it is spawned locally, never sent to the PBX.
    assert.ok(!code.includes(forbidden), `must not contain "${forbidden}"`);
  }
});
