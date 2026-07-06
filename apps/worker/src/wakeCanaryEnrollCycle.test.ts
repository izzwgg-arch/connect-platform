// Pure unit tests for the wake auto-enroll cycle's decision logic: enable-target
// selection + the coded safety valve. No DB, no PBX, no HTTP — the reconcile()
// result shape is constructed in-memory (mirroring the reconciler's output).
import test from "node:test";
import assert from "node:assert/strict";
import { selectWakeEnableTargets, assessWakeEnrollSafety } from "./wakeCanaryEnrollCycle";

// The reconciler's ACTIONS.ENABLE literal (kept in sync with wake-canary-reconcile.mjs).
const ENABLE = "ENABLE";
const KEEP_ENABLED = "KEEP_ENABLED";
const DISABLE = "DISABLE";
const SKIP = "SKIP_NEEDS_REVIEW";

function result(rows: any[], extra: Partial<any> = {}) {
  const byAction: Record<string, number> = {};
  for (const r of rows) byAction[r.action] = (byAction[r.action] ?? 0) + 1;
  return {
    rows,
    orphans: extra.orphans ?? [],
    counts: {
      totalRecords: rows.length,
      byAction,
      orphanDisable: (extra.orphans ?? []).length,
      ...(extra.counts ?? {}),
    },
  };
}

function row(pbxTenantId: string, extNumber: string, action = ENABLE) {
  return { pbxTenantId, extNumber, key: `T${pbxTenantId}_${extNumber}`, action };
}

test("selects only ENABLE rows with numeric tenant + extension", () => {
  const res = result([
    row("2", "110", ENABLE),
    row("2", "111", KEEP_ENABLED), // already enabled → not a target
    row("8", "200", ENABLE),
    row("2", "112", SKIP), // needs review → never enabled
  ]);
  const { targets, malformed } = selectWakeEnableTargets(res);
  assert.deepEqual(targets.map((t) => t.key).sort(), ["T2_110", "T8_200"]);
  assert.equal(malformed.length, 0);
});

test("malformed (non-numeric) enable rows are surfaced, not enabled", () => {
  const res = result([
    row("2", "110", ENABLE),
    row("2", "1a0", ENABLE), // bad ext
    row("x", "200", ENABLE), // bad tenant
  ]);
  const { targets, malformed } = selectWakeEnableTargets(res);
  assert.deepEqual(targets.map((t) => t.key), ["T2_110"]);
  assert.equal(malformed.length, 2);
});

test("safe: a normal enable batch passes the valve", () => {
  const res = result([row("2", "110", ENABLE), row("8", "200", ENABLE)]);
  const { targets, malformed } = selectWakeEnableTargets(res);
  const s = assessWakeEnrollSafety(res, targets, malformed, { maxEnable: 1000, requireCanaryKey: "T2_110" });
  assert.equal(s.safe, true);
  assert.deepEqual(s.reasons, []);
  assert.deepEqual(s.warnings, []);
});

test("valve fails closed when a malformed enable key is present", () => {
  const res = result([row("2", "110", ENABLE), row("x", "200", ENABLE)]);
  const { targets, malformed } = selectWakeEnableTargets(res);
  const s = assessWakeEnrollSafety(res, targets, malformed, {});
  assert.equal(s.safe, false);
  assert.ok(s.reasons.some((r) => r.startsWith("malformed_enable_key")));
});

test("valve fails closed when the enable count exceeds the cap", () => {
  const rows = Array.from({ length: 5 }, (_, i) => row("2", String(100 + i), ENABLE));
  const res = result(rows);
  const { targets, malformed } = selectWakeEnableTargets(res);
  const s = assessWakeEnrollSafety(res, targets, malformed, { maxEnable: 3 });
  assert.equal(s.safe, false);
  assert.ok(s.reasons.some((r) => r.startsWith("enable_count_exceeds_cap")));
});

test("valve fails closed on any destructive action (DISABLE row) — append-only invariant", () => {
  const res = result([row("2", "110", ENABLE), row("2", "500", DISABLE)]);
  const { targets, malformed } = selectWakeEnableTargets(res);
  const s = assessWakeEnrollSafety(res, targets, malformed, {});
  assert.equal(s.safe, false);
  assert.ok(s.reasons.some((r) => r.startsWith("unexpected_destructive_action")));
});

test("valve fails closed on any owned-orphan clear", () => {
  const res = result([row("2", "110", ENABLE)], { orphans: [{ key: "T8_199", action: DISABLE }] });
  const { targets, malformed } = selectWakeEnableTargets(res);
  const s = assessWakeEnrollSafety(res, targets, malformed, {});
  assert.equal(s.safe, false);
  assert.ok(s.reasons.some((r) => r.startsWith("unexpected_destructive_action")));
});

test("warns (but stays safe) when the canary extension exists but is not being enabled", () => {
  // Canary present in records as a needs-review row (not an ENABLE target).
  const res = result([row("2", "110", SKIP), row("8", "200", ENABLE)]);
  const { targets, malformed } = selectWakeEnableTargets(res);
  const s = assessWakeEnrollSafety(res, targets, malformed, { requireCanaryKey: "T2_110" });
  assert.equal(s.safe, true);
  assert.ok(s.warnings.some((w) => w.startsWith("canary_not_enabled")));
});

test("no canary warning when the canary is in the enable set", () => {
  const res = result([row("2", "110", ENABLE)]);
  const { targets, malformed } = selectWakeEnableTargets(res);
  const s = assessWakeEnrollSafety(res, targets, malformed, { requireCanaryKey: "T2_110" });
  assert.equal(s.safe, true);
  assert.deepEqual(s.warnings, []);
});

test("empty plan is safe and publishes nothing", () => {
  const res = result([]);
  const { targets, malformed } = selectWakeEnableTargets(res);
  const s = assessWakeEnrollSafety(res, targets, malformed, {});
  assert.equal(s.safe, true);
  assert.equal(targets.length, 0);
});
