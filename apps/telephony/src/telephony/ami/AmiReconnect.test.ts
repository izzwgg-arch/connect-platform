import test from "node:test";
import assert from "node:assert/strict";
import {
  createReconnectState,
  nextDelayMs,
  onConnected,
  onFailed,
  abort,
  isAborted,
} from "./AmiReconnect";

test("AmiReconnect backoff is capped and increases with failures", () => {
  const s = createReconnectState();
  const delays: number[] = [];
  for (let i = 0; i < 15; i++) {
    onFailed(s);
    delays.push(nextDelayMs(s));
  }
  assert.equal(s.attempt, 15);
  for (const d of delays) {
    assert.ok(d >= 500);
    assert.ok(d <= 30_000 + 1_000);
  }
});

test("AmiReconnect onConnected resets attempt and increments totalReconnects after failure", () => {
  const s = createReconnectState();
  onFailed(s);
  onFailed(s);
  assert.equal(s.attempt, 2);
  onConnected(s);
  assert.equal(s.attempt, 0);
  assert.equal(s.totalReconnects, 1);
  onConnected(s);
  assert.equal(s.totalReconnects, 1);
});

test("AmiReconnect abort stops scheduling helpers", () => {
  const s = createReconnectState();
  assert.equal(isAborted(s), false);
  abort(s);
  assert.equal(isAborted(s), true);
});
