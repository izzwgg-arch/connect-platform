/**
 * The Watchman — the standing checks that gate the support agent's work.
 *
 * The property that matters most here is the FAIL-SAFE direction: a check that
 * cannot run must block work exactly like a failed one. This repo has shipped
 * a watchdog that had never completed once and a knowledge base that was empty
 * for its whole life; both looked healthy because nothing asserted otherwise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateWatchman, runWatchman } from "./supportWatchman";

const HEALTHY = {
  rules: { found: 2, missing: [] as string[] },
  server: { healthy: 2, unhealthy: [] as string[] },
  pbx: { reachable: true, readOnly: true },
};

test("all three checks healthy → safe to work", () => {
  const v = evaluateWatchman(HEALTHY);
  assert.equal(v.safeToWork, true);
  assert.deepEqual(v.blockers, []);
  assert.equal(v.checks.length, 3);
  assert.ok(v.checks.every((c) => c.status === "ok"));
});

test("⛔ a check that could not RUN blocks work — unknown is never 'probably fine'", () => {
  for (const missing of ["rules", "server", "pbx"] as const) {
    const input: any = { ...HEALTHY, [missing]: null };
    const v = evaluateWatchman(input);
    assert.equal(v.safeToWork, false, `${missing} unknown must block`);
    assert.equal(v.checks.find((c) => c.id === missing)?.status, "unknown");
    assert.equal(v.blockers.length, 1);
  }
});

test("⛔ the agent may not work when it cannot read its own rules", () => {
  const v = evaluateWatchman({ ...HEALTHY, rules: { found: 1, missing: ["CLAUDE.md"] } });
  assert.equal(v.safeToWork, false);
  assert.match(v.blockers[0], /can't read its own rules/);
  assert.match(v.checks[0].detail, /CLAUDE\.md/);
});

test("an unhealthy service blocks work and names what is down", () => {
  const v = evaluateWatchman({ ...HEALTHY, server: { healthy: 1, unhealthy: ["portal"] } });
  assert.equal(v.safeToWork, false);
  assert.match(v.blockers[0], /portal/);
});

test("⛔⛔ a PBX that is NOT read-only is a stop-everything, not a warning", () => {
  const v = evaluateWatchman({ ...HEALTHY, pbx: { reachable: true, readOnly: false, detail: 'Connected as "root"' } });
  assert.equal(v.safeToWork, false);
  assert.equal(v.checks.find((c) => c.id === "pbx")?.status, "bad");
  assert.match(v.blockers[0], /not read-only/);
});

test("an unreachable PBX is only a WARNING — read-only means nothing can be harmed", () => {
  const v = evaluateWatchman({ ...HEALTHY, pbx: { reachable: false, readOnly: true } });
  assert.equal(v.safeToWork, true, "Connect-side work can continue while the PBX is unreachable");
  assert.equal(v.checks.find((c) => c.id === "pbx")?.status, "warn");
});

test("every blocker is listed, not just the first", () => {
  const v = evaluateWatchman({ rules: null, server: { healthy: 0, unhealthy: ["api"] }, pbx: null });
  assert.equal(v.safeToWork, false);
  assert.equal(v.blockers.length, 3);
});

test("⛔ runWatchman turns a THROWING probe into a blocker, never a pass", async () => {
  const v = await runWatchman({
    rules: async () => { throw new Error("disk gone"); },
    server: async () => ({ healthy: 2, unhealthy: [] }),
    pbx: async () => ({ reachable: true, readOnly: true }),
  });
  assert.equal(v.safeToWork, false);
  assert.equal(v.checks.find((c) => c.id === "rules")?.status, "unknown");
});

test("runWatchman passes a fully healthy set through", async () => {
  const v = await runWatchman({
    rules: async () => ({ found: 2, missing: [] }),
    server: async () => ({ healthy: 2, unhealthy: [] }),
    pbx: async () => ({ reachable: true, readOnly: true }),
  });
  assert.equal(v.safeToWork, true);
  assert.ok(Date.parse(v.checkedAt) > 0);
});
