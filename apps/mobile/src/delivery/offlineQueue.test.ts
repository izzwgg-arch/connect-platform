import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeOp, enqueue, syncableOps, markSyncing, applyResult, applyResults,
  unsyncedCount, blockedOps, pruneSynced, retryOp, serialize, deserialize,
  type QueuedOp,
} from "./offlineQueue";

function seed(): QueuedOp[] {
  let q: QueuedOp[] = [];
  q = enqueue(q, makeOp("scan", { token: "A" }, "op-1", 1000));
  q = enqueue(q, makeOp("status", { to: "ARRIVED" }, "op-2", 2000));
  q = enqueue(q, makeOp("proof", { photo: "x" }, "op-3", 3000));
  return q;
}

test("enqueue dedupes by opId (idempotent)", () => {
  let q = seed();
  const before = q.length;
  q = enqueue(q, makeOp("scan", { token: "A" }, "op-1", 9999));
  assert.equal(q.length, before);
});

test("syncableOps returns FIFO by createdAt", () => {
  const q = seed();
  assert.deepEqual(syncableOps(q).map((o) => o.opId), ["op-1", "op-2", "op-3"]);
});

test("successful result marks synced and never regresses", () => {
  let q = seed();
  q = applyResult(q, { opId: "op-1", ok: true });
  assert.equal(q.find((o) => o.opId === "op-1")!.state, "synced");
  // a later spurious failure must not un-sync it
  q = applyResult(q, { opId: "op-1", ok: false, error: "late" });
  assert.equal(q.find((o) => o.opId === "op-1")!.state, "synced");
});

test("failure increments attempts and stays retryable under the cap", () => {
  let q = seed();
  q = applyResult(q, { opId: "op-2", ok: false, error: "network" });
  const op = q.find((o) => o.opId === "op-2")!;
  assert.equal(op.state, "failed");
  assert.equal(op.attempts, 1);
  assert.ok(syncableOps(q).some((o) => o.opId === "op-2"));
});

test("conflict surfaces to the driver and is NOT auto-retried", () => {
  let q = seed();
  q = applyResult(q, { opId: "op-3", ok: false, conflict: true, error: "reassigned" });
  const op = q.find((o) => o.opId === "op-3")!;
  assert.equal(op.state, "conflict");
  assert.equal(syncableOps(q).some((o) => o.opId === "op-3"), false);
  assert.equal(blockedOps(q).length, 1);
});

test("failed op exceeding the cap becomes blocked", () => {
  let q = seed();
  for (let i = 0; i < 5; i++) q = applyResult(q, { opId: "op-2", ok: false });
  assert.equal(syncableOps(q, 5).some((o) => o.opId === "op-2"), false);
  assert.equal(blockedOps(q, 5).some((o) => o.opId === "op-2"), true);
});

test("markSyncing does not touch synced/conflict ops", () => {
  let q = seed();
  q = applyResult(q, { opId: "op-1", ok: true });
  q = applyResult(q, { opId: "op-3", ok: false, conflict: true });
  q = markSyncing(q, ["op-1", "op-2", "op-3"]);
  assert.equal(q.find((o) => o.opId === "op-1")!.state, "synced");
  assert.equal(q.find((o) => o.opId === "op-2")!.state, "syncing");
  assert.equal(q.find((o) => o.opId === "op-3")!.state, "conflict");
});

test("unsyncedCount + applyResults batch", () => {
  let q = seed();
  assert.equal(unsyncedCount(q), 3);
  q = applyResults(q, [{ opId: "op-1", ok: true }, { opId: "op-2", ok: true }]);
  assert.equal(unsyncedCount(q), 1);
});

test("retryOp resets a blocked op to pending", () => {
  let q = seed();
  q = applyResult(q, { opId: "op-3", ok: false, conflict: true });
  q = retryOp(q, "op-3");
  const op = q.find((o) => o.opId === "op-3")!;
  assert.equal(op.state, "pending");
  assert.equal(op.attempts, 0);
});

test("pruneSynced drops old synced ops but keeps recent + unsynced", () => {
  let q = seed();
  q = applyResult(q, { opId: "op-1", ok: true });
  const pruned = pruneSynced(q, 1000 + 6 * 60_000); // op-1 created at 1000, >5min ago
  assert.equal(pruned.some((o) => o.opId === "op-1"), false);
  assert.equal(pruned.length, 2);
});

test("serialize/deserialize roundtrip; killed 'syncing' resets to pending", () => {
  let q = seed();
  q = markSyncing(q, ["op-1"]);
  const restored = deserialize(serialize(q));
  assert.equal(restored.find((o) => o.opId === "op-1")!.state, "pending");
  assert.equal(restored.length, 3);
  assert.deepEqual(deserialize(null), []);
  assert.deepEqual(deserialize("not json"), []);
});
