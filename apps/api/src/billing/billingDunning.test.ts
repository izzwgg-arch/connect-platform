import test from "node:test";
import assert from "node:assert/strict";
import { mergeDunningAfterFailure, clearDunningSlice, readDunningSlice } from "./billingDunning";

test("mergeDunningAfterFailure increments from empty metadata", () => {
  const r = mergeDunningAfterFailure({});
  assert.equal(r.attempts, 1);
  assert.equal(r.exhausted, false);
  assert.ok(r.nextRetryAt instanceof Date);
  assert.ok((r.metadata as any).dunning);
});

test("clearDunningSlice removes dunning", () => {
  const cleared = clearDunningSlice({ dunning: { attempts: 2 }, other: 1 });
  assert.equal((cleared as any).dunning, undefined);
  assert.equal((cleared as any).other, 1);
});

test("readDunningSlice reads nested dunning", () => {
  const d = readDunningSlice({ dunning: { attempts: 2, maxAttempts: 5, nextRetryAt: "2099-01-01T00:00:00.000Z" } });
  assert.equal(d.attempts, 2);
  assert.equal(d.maxAttempts, 5);
});
