/**
 * report-state.ts — CLI arg parsing only (pure). The actual DB write is
 * `reportPipelineState`, already covered by
 * `../yiddish-shared/pipelineState.test.ts`; this file only proves the
 * flag-parsing contract `auto-launch-training.sh` (and any other bash
 * caller) relies on.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseReportArgs } from "./report-state";

test("parseReportArgs: minimal required flags, no progress/detail", () => {
  const parsed = parseReportArgs(["--key", "training.run.v1", "--kind", "training", "--status", "running", "--headline", "Uploading dataset."]);
  assert.equal(parsed.key, "training.run.v1");
  assert.equal(parsed.kind, "training");
  assert.equal(parsed.status, "running");
  assert.equal(parsed.headline, "Uploading dataset.");
  assert.equal(parsed.progress, null);
  assert.equal(parsed.detail, undefined);
});

test("parseReportArgs: --current/--total/--unit build a progress object with pct computed", () => {
  const parsed = parseReportArgs([
    "--key", "training.run.v1", "--kind", "training", "--status", "running", "--headline", "x",
    "--current", "3", "--total", "12", "--unit", "clips",
  ]);
  assert.deepEqual(parsed.progress, { current: 3, total: 12, unit: "clips", pct: 25 });
});

test("parseReportArgs: --unit defaults to 'items' when omitted", () => {
  const parsed = parseReportArgs(["--key", "k", "--kind", "runner", "--status", "idle", "--headline", "x", "--current", "1", "--total", "4"]);
  assert.equal(parsed.progress?.unit, "items");
});

test("parseReportArgs: --detail-json parses into an object", () => {
  const parsed = parseReportArgs([
    "--key", "k", "--kind", "training", "--status", "error", "--headline", "x",
    "--detail-json", '{"kernelRef":"izzywein/loopcom-yiddish-whisper-finetune","reason":"push failed"}',
  ]);
  assert.deepEqual(parsed.detail, { kernelRef: "izzywein/loopcom-yiddish-whisper-finetune", reason: "push failed" });
});

test("parseReportArgs: invalid --detail-json throws a clear error", () => {
  assert.throws(
    () => parseReportArgs(["--key", "k", "--kind", "training", "--status", "error", "--headline", "x", "--detail-json", "{not json"]),
    /not valid JSON/,
  );
});

test("parseReportArgs: missing a required flag throws naming it", () => {
  assert.throws(() => parseReportArgs(["--kind", "training", "--status", "running", "--headline", "x"]), /--key is required/);
  assert.throws(() => parseReportArgs(["--key", "k", "--status", "running", "--headline", "x"]), /--kind is required/);
  assert.throws(() => parseReportArgs(["--key", "k", "--kind", "training", "--headline", "x"]), /--status is required/);
  assert.throws(() => parseReportArgs(["--key", "k", "--kind", "training", "--status", "running"]), /--headline is required/);
});

test("parseReportArgs: rejects an unrecognised --kind or --status", () => {
  assert.throws(() => parseReportArgs(["--key", "k", "--kind", "bogus", "--status", "running", "--headline", "x"]), /--kind must be one of/);
  assert.throws(() => parseReportArgs(["--key", "k", "--kind", "training", "--status", "bogus", "--headline", "x"]), /--status must be one of/);
});
