import assert from "node:assert/strict";
import { test } from "node:test";
import { startDeployPolling, deployPollFailure, type DeployPollResult } from "./deployPolling";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness(poll: () => Promise<DeployPollResult>, initialVisible = true) {
  let visible = initialVisible;
  let listener: (() => void) | undefined;
  const timers = new Map<number, { fn: () => void; delay: number }>(); let next = 0;
  const stop = startDeployPolling(poll, {
    visible: () => visible,
    schedule: (fn, delay) => { const id = ++next; timers.set(id, { fn, delay }); return id; },
    cancel: (id) => { timers.delete(id as number); },
    onVisible: (fn) => { listener = fn; return () => { listener = undefined; }; },
  });
  return { stop, timers, show(value: boolean) { visible = value; listener?.(); },
    async tick() { const [id, timer] = timers.entries().next().value!; timers.delete(id); timer.fn(); await flush(); return timer.delay; } };
}
test("slow requests never overlap, including repeated visibility events", async () => {
  let calls = 0; let complete!: (result: DeployPollResult) => void;
  const h = harness(() => { calls++; return new Promise((resolve) => { complete = resolve; }); });
  h.show(true); h.show(true);
  assert.equal(calls, 1); assert.equal(h.timers.size, 0);
  complete("ok"); await flush();
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].delay, 10_000);
  h.stop();
});
test("hidden tabs do not poll and resume once when visible", async () => {
  let calls = 0; const h = harness(async () => { calls++; return "ok"; }, false);
  assert.equal(calls, 0); h.show(true); await flush(); assert.equal(calls, 1);
  h.show(false); assert.equal(h.timers.size, 0); h.show(true); await flush(); assert.equal(calls, 2); h.stop();
});
test("failure retries back off to 30 seconds", async () => {
  const h = harness(async () => "retry"); await flush();
  assert.equal([...h.timers.values()][0].delay, 30_000); h.stop();
});
test("queued, finished, unauthorized and missing resources can stop polling permanently", async () => {
  let calls = 0; const h = harness(async () => { calls++; return "stop"; }); await flush();
  h.show(false); h.show(true); await flush(); assert.equal(calls, 1); assert.equal(h.timers.size, 0); h.stop();
  for (const status of [401, 403, 404]) assert.equal(deployPollFailure({ status }), "stop");
  for (const status of [429, 500, 502, 504]) assert.equal(deployPollFailure({ status }), "retry");
});
test("closing a page during a request cannot restart its polling", async () => {
  let complete!: (result: DeployPollResult) => void;
  const h = harness(() => new Promise((resolve) => { complete = resolve; }));
  h.stop(); complete("ok"); await flush(); assert.equal(h.timers.size, 0);
});
test("five minutes of successful polling is bounded to 31 requests per loop", async () => {
  let calls = 0; const h = harness(async () => { calls++; return "ok"; }); await flush();
  for (let i = 0; i < 30; i++) assert.equal(await h.tick(), 10_000);
  assert.equal(calls, 31); h.stop();
});
