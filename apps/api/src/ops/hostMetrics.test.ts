import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCpuUsagePct,
  deriveResourceHealth,
  parseProcStatCpuLine,
} from "./hostMetrics";

test("parseProcStatCpuLine parses aggregate cpu line", () => {
  const sample = parseProcStatCpuLine("cpu  10142453 2340 2623853 1902556379 78272 0 125280 0 0 0");
  assert.ok(sample);
  assert.equal(sample!.total, 10142453 + 2340 + 2623853 + 1902556379 + 78272 + 0 + 125280 + 0 + 0 + 0);
  assert.equal(sample!.idle, 1902556379 + 78272);
});

test("computeCpuUsagePct returns bounded percentage", () => {
  const prev = { idle: 100, total: 200 };
  const next = { idle: 120, total: 300 };
  const pct = computeCpuUsagePct(prev, next);
  assert.equal(pct, 80);
});

test("deriveResourceHealth escalates on high utilization", () => {
  assert.equal(deriveResourceHealth(50, 50, []), "ok");
  assert.equal(deriveResourceHealth(86, 50, [{ path: "/", totalBytes: 1, usedBytes: 1, freeBytes: 0, usedPct: 50 }]), "warning");
  assert.equal(
    deriveResourceHealth(96, 50, [{ path: "/", totalBytes: 1, usedBytes: 1, freeBytes: 0, usedPct: 96 }]),
    "critical",
  );
});
