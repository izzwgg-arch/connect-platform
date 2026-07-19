import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditLog, FileAuditSink, type AuditSink } from "./audit";

test("audit rows are appended as hashed JSONL", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-audit-"));
  const log = new AuditLog([new FileAuditSink(dir)]);
  const ok = await log.record({ actor: "system", event: "test.event", payload: { x: 1 } });
  assert.equal(ok, true);
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  const row = JSON.parse((await readFile(path.join(dir, files[0]), "utf8")).trim());
  assert.equal(row.event, "test.event");
  assert.equal(typeof row.hash, "string");
  assert.equal(row.hash.length, 64);
});

test("one failing sink does not lose the row if another accepts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-audit-"));
  const failing: AuditSink = {
    async write() {
      throw new Error("db down");
    },
  };
  const log = new AuditLog([failing, new FileAuditSink(dir)]);
  const ok = await log.record({ actor: "system", event: "resilience.test" });
  assert.equal(ok, true);
});

test("all sinks failing reports false (caller must escalate, not proceed)", async () => {
  const failing: AuditSink = {
    async write() {
      throw new Error("down");
    },
  };
  const log = new AuditLog([failing]);
  const ok = await log.record({ actor: "system", event: "resilience.test2" });
  assert.equal(ok, false);
});
