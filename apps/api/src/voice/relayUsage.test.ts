import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRelayUsage,
  breachingTenants,
  type RelayUsageRow,
} from "./relayUsage";

function rows(tenantId: string, relay: number, noRelay: number): RelayUsageRow[] {
  const out: RelayUsageRow[] = [];
  for (let i = 0; i < relay; i++) out.push({ tenantId, payload: { isUsingRelay: true } });
  for (let i = 0; i < noRelay; i++) out.push({ tenantId, payload: { isUsingRelay: false, candidateType: "prflx" } });
  return out;
}

test("computeRelayUsage: aggregates per tenant", () => {
  const r = computeRelayUsage([...rows("t1", 3, 1), ...rows("t2", 0, 5)]);
  const t1 = r.find((x) => x.tenantId === "t1")!;
  const t2 = r.find((x) => x.tenantId === "t2")!;
  assert.equal(t1.attempts, 4);
  assert.equal(t1.relayCount, 3);
  assert.equal(t2.relayCount, 0);
  assert.equal(t2.ratio, 0);
});

test("breaching: 0% relay over enough attempts is flagged (the 2026-06-08 signature)", () => {
  const breach = breachingTenants(rows("t1", 0, 12));
  assert.equal(breach.length, 1);
  assert.equal(breach[0].tenantId, "t1");
  assert.equal(breach[0].ratio, 0);
});

test("not breaching: too few attempts (avoids noise)", () => {
  const breach = breachingTenants(rows("t1", 0, 3));
  assert.equal(breach.length, 0);
});

test("not breaching: healthy relay usage", () => {
  const breach = breachingTenants(rows("t1", 10, 2));
  assert.equal(breach.length, 0);
});

test("candidateType=relay counts as relay even when isUsingRelay missing", () => {
  const r = computeRelayUsage([
    { tenantId: "t1", payload: { candidateType: "relay" } },
    { tenantId: "t1", payload: { candidateType: "relay" } },
  ]);
  assert.equal(r[0].relayCount, 2);
});

test("breaching list sorted worst-first", () => {
  const all = [...rows("a", 1, 19), ...rows("b", 0, 20)];
  const breach = breachingTenants(all);
  assert.deepEqual(breach.map((t) => t.tenantId), ["b", "a"]);
});
