import { test } from "node:test";
import assert from "node:assert/strict";
import { rankHypotheses } from "./engine";
import type { ExtensionStatusResult, CdrSummary } from "../tools/readTools";

const cdrBase: CdrSummary = { totalCalls: 20, answered: 15, missed: 4, failed: 1, shortAnsweredCalls: 0, lastCallAt: new Date(), windowHours: 48, recent: [] };
const reg = (status: string): ExtensionStatusResult => ({ extension: "101", registered: status === "REGISTERED", status });

test("unknown extension → not-found hypothesis", () => {
  const h = rankHypotheses([], cdrBase, "phone broken");
  assert.match(h[0].cause, /not found/);
  assert.ok(h[0].confidence > 0.9);
});

test("unregistered device → offline hypothesis ranked first", () => {
  const h = rankHypotheses([reg("UNREGISTERED")], cdrBase, "no calls coming in");
  assert.match(h[0].cause, /offline|not registered/i);
  assert.equal(h[0].fixPath, "client_side");
});

test("registered + 'not ringing' complaint → routing diversion hypothesis", () => {
  const h = rankHypotheses([reg("REGISTERED")], cdrBase, "my phone is not ringing");
  assert.match(h[0].cause, /forwarding, DND, time condition/i);
  assert.equal(h[0].fixPath, "agent_catalog");
});

test("Yiddish 'not ringing' complaint triggers same rule", () => {
  const h = rankHypotheses([reg("REGISTERED")], cdrBase, "דער טעלעפאן קלינגט נישט");
  assert.match(h[0].cause, /forwarding, DND/i);
});

test("short-call pattern → SIP ALG hypothesis", () => {
  const h = rankHypotheses([reg("REGISTERED")], { ...cdrBase, shortAnsweredCalls: 5 }, "callers can't hear us");
  assert.ok(h.some((x) => /ALG|one-way/i.test(x.cause)));
});

test("registered + zero CDRs → routing/carrier hypothesis", () => {
  const h = rankHypotheses([reg("REGISTERED")], { ...cdrBase, totalCalls: 0, answered: 0, missed: 0, failed: 0, lastCallAt: null }, null);
  assert.ok(h.some((x) => /No calls reaching/i.test(x.cause)));
});

test("clean bill of health → info hypothesis, never empty", () => {
  const h = rankHypotheses([reg("REGISTERED")], cdrBase, null);
  assert.ok(h.length >= 1);
  assert.equal(h[h.length - 1].fixPath === "info" || h[0].fixPath === "info", true);
});
