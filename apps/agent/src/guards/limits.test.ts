import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, DEFAULT_LIMITS } from "./limits";

test("message cap enforced per tenant per day", () => {
  const rl = new RateLimiter({ ...DEFAULT_LIMITS, maxMessagesPerDay: 3 });
  const t0 = Date.now();
  assert.equal(rl.check("t1", "messages", { now: t0 }), null);
  assert.equal(rl.check("t1", "messages", { now: t0 }), null);
  assert.equal(rl.check("t1", "messages", { now: t0 }), null);
  assert.match(rl.check("t1", "messages", { now: t0 })!, /Daily message limit/);
  // different tenant unaffected
  assert.equal(rl.check("t2", "messages", { now: t0 }), null);
});

test("window rolls over after a day", () => {
  const rl = new RateLimiter({ ...DEFAULT_LIMITS, maxMessagesPerDay: 1 });
  const t0 = Date.now();
  assert.equal(rl.check("t1", "messages", { now: t0 }), null);
  assert.match(rl.check("t1", "messages", { now: t0 })!, /limit/);
  assert.equal(rl.check("t1", "messages", { now: t0 + 86400_001 }), null); // new day
});

test("action + hourly LLM + spend caps", () => {
  const rl = new RateLimiter({ maxMessagesPerDay: 99, maxActionsPerDay: 1, maxLlmCallsPerHour: 1, maxLlmSpendUsdPerDay: 1 });
  const t0 = Date.now();
  assert.equal(rl.check("t1", "actions", { now: t0 }), null);
  assert.match(rl.check("t1", "actions", { now: t0 })!, /action limit/);
  assert.equal(rl.check("t1", "llm_calls", { now: t0 }), null);
  assert.match(rl.check("t1", "llm_calls", { now: t0 })!, /AI-call limit/);
  assert.equal(rl.check("t1", "llm_spend", { now: t0, spendUsd: 1.5 }), null);
  assert.match(rl.check("t1", "llm_spend", { now: t0, spendUsd: 0.1 })!, /spend cap/);
});

test("per-tenant limit override via opts", () => {
  const rl = new RateLimiter();
  const t0 = Date.now();
  assert.match(rl.check("vip", "actions", { now: t0, limits: { maxActionsPerDay: 0 } })!, /action limit/);
});
