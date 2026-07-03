import test from "node:test";
import assert from "node:assert/strict";
import { buildDndReportPayload, reportDndWithBoundedRetry } from "./dndReportPolicy";

test("buildDndReportPayload wraps the boolean as-is", () => {
  assert.deepEqual(buildDndReportPayload(true), { dnd: true });
  assert.deepEqual(buildDndReportPayload(false), { dnd: false });
});

test("reportDndWithBoundedRetry succeeds on the first attempt without sleeping", async () => {
  let calls = 0;
  let slept = 0;
  const ok = await reportDndWithBoundedRetry(
    async () => {
      calls++;
    },
    { sleep: async () => { slept++; } },
  );
  assert.equal(ok, true);
  assert.equal(calls, 1);
  assert.equal(slept, 0);
});

test("reportDndWithBoundedRetry retries once on failure, then succeeds, within the bound", async () => {
  let calls = 0;
  let slept = 0;
  const ok = await reportDndWithBoundedRetry(
    async () => {
      calls++;
      if (calls === 1) throw new Error("network blip");
    },
    { maxAttempts: 2, sleep: async () => { slept++; } },
  );
  assert.equal(ok, true);
  assert.equal(calls, 2);
  assert.equal(slept, 1);
});

test("reportDndWithBoundedRetry NEVER throws — returns false when every attempt fails", async () => {
  let calls = 0;
  const ok = await reportDndWithBoundedRetry(
    async () => {
      calls++;
      throw new Error("always fails");
    },
    { maxAttempts: 3, sleep: async () => {} },
  );
  assert.equal(ok, false);
  assert.equal(calls, 3);
});

test("reportDndWithBoundedRetry respects maxAttempts=1 (no retry) and does not sleep", async () => {
  let calls = 0;
  let slept = 0;
  const ok = await reportDndWithBoundedRetry(
    async () => {
      calls++;
      throw new Error("fails");
    },
    { maxAttempts: 1, sleep: async () => { slept++; } },
  );
  assert.equal(ok, false);
  assert.equal(calls, 1);
  assert.equal(slept, 0);
});

test("reportDndWithBoundedRetry defaults to a bounded number of attempts (does not retry forever)", async () => {
  let calls = 0;
  const ok = await reportDndWithBoundedRetry(
    async () => {
      calls++;
      throw new Error("fails");
    },
    { sleep: async () => {} },
  );
  assert.equal(ok, false);
  assert.ok(calls <= 3, `expected a small bounded attempt count, got ${calls}`);
  assert.ok(calls >= 1);
});
