import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundRequest, readShellLogTail, MAX_LINES, MAX_LINE_CHARS, MAX_SINCE_MS } from "./shellLog";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const stamp = (secsAgo: number) => new Date(NOW - secsAgo * 1000).toISOString();

function tmpLog(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ct-shelllog-"));
  const file = join(dir, "connect.log");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("⛔ the request is BOUNDED whatever the renderer asks for", () => {
  const b = boundRequest({ sinceMs: 0, maxLines: 10_000 }, NOW);
  assert.equal(b.since, NOW - MAX_SINCE_MS, "since is clamped to the last 15 minutes");
  assert.equal(b.maxLines, MAX_LINES);
  assert.equal(boundRequest({ maxLines: -5 }, NOW).maxLines, 1);
  assert.equal(boundRequest("garbage", NOW).maxLines, MAX_LINES);
  assert.equal(boundRequest({ sinceMs: "yesterday" }, NOW).since, NOW - MAX_SINCE_MS);
});

test("returns only lines stamped inside the window, newest last, and counts what it cut", () => {
  const file = tmpLog([
    `[${stamp(3600)}] [main] old line`,
    `[${stamp(120)}] [audio] power-save blocker started for call`,
    `[${stamp(60)}] [engine] console.warn: [SipPhone] setSinkId failed: NotFoundError`,
    "    continuation line with no stamp",
    `[${stamp(10)}] [main] render-process-gone: crashed exit=5`,
  ]);
  const t = readShellLogTail(file, { sinceMs: NOW - 300_000, maxLines: 3 }, NOW);
  assert.equal(t.truncated, 1);
  assert.equal(t.lines.length, 3);
  assert.match(t.lines[0]!, /setSinkId failed/);
  assert.match(t.lines[1]!, /continuation line/);
  assert.match(t.lines[2]!, /render-process-gone/);
});

test("a continuation line inherits the previous stamp and is dropped with it when out of range", () => {
  const file = tmpLog([
    `[${stamp(3600)}] [main] old`,
    "    old continuation",
    `[${stamp(5)}] [main] new`,
  ]);
  const t = readShellLogTail(file, {}, NOW);
  assert.deepEqual(t.lines.map((l) => l.slice(-3)), ["new"]);
});

test("long lines are cut, a missing file is an empty tail, never a throw", () => {
  const file = tmpLog([`[${stamp(1)}] [main] ${"x".repeat(1000)}`]);
  const t = readShellLogTail(file, {}, NOW);
  assert.equal(t.lines[0]!.length, MAX_LINE_CHARS + 1);
  const missing = readShellLogTail(join(tmpdir(), "does-not-exist-" + Date.now(), "connect.log"), {}, NOW);
  assert.deepEqual(missing, { lines: [], truncated: 0, fileBytes: 0 });
});
