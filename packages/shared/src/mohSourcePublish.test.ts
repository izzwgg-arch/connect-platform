// Unit tests for the per-source publish folding + timezone-safe schedule
// evaluation. Pure logic — no DB, no AstDB.

import test from "node:test";
import assert from "node:assert/strict";
import {
  MOH_GLOBAL_DEFAULT_FAMILY,
  MOH_GLOBAL_DEFAULT_KEY,
  buildGlobalDefaultKey,
  buildSourcePublishKeys,
  computeActiveScheduleOverrides,
  isScheduleRuleActive,
  type ActiveScheduleOverride,
  type ScheduleRuleRow,
  type StaticSourcePolicy,
} from "./mohSourcePublish";

// ── global default key ──────────────────────────────────────────────────────

test("buildGlobalDefaultKey: class or tombstone", () => {
  assert.deepEqual(buildGlobalDefaultKey("moh7"), {
    family: MOH_GLOBAL_DEFAULT_FAMILY,
    key: MOH_GLOBAL_DEFAULT_KEY,
    value: "moh7",
  });
  assert.deepEqual(buildGlobalDefaultKey(null), {
    family: "connect/system",
    key: "moh_default_class",
    value: "",
  });
});

// ── static-only folding ─────────────────────────────────────────────────────

test("buildSourcePublishKeys: tenant + extension static policies", () => {
  const statics: StaticSourcePolicy[] = [
    { scope: "tenant", extension: "", source: "outbound", vitalPbxMohClassName: "moh2", enabled: true },
    { scope: "tenant", extension: "", source: "internal", vitalPbxMohClassName: "moh1", enabled: true },
    { scope: "extension", extension: "101", source: "outbound", vitalPbxMohClassName: "connect_acme_jazz", enabled: true },
    { scope: "tenant", extension: "", source: "transfer", vitalPbxMohClassName: "x", enabled: false }, // dropped
  ];
  const keys = buildSourcePublishKeys({ slug: "acme", staticPolicies: statics, activeOverrides: [] });
  assert.deepEqual(keys, [
    { family: "connect/t_acme/extensions/101/moh/src", key: "outbound", value: "connect_acme_jazz" },
    { family: "connect/t_acme/moh/src", key: "internal", value: "moh1" },
    { family: "connect/t_acme/moh/src", key: "outbound", value: "moh2" },
  ]);
});

// ── schedule folding precedence ──────────────────────────────────────────────

test("buildSourcePublishKeys: schedule-specific beats schedule-all beats static", () => {
  const statics: StaticSourcePolicy[] = [
    { scope: "extension", extension: "101", source: "outbound", vitalPbxMohClassName: "static_out", enabled: true },
    { scope: "extension", extension: "101", source: "internal", vitalPbxMohClassName: "static_int", enabled: true },
  ];
  const overrides: ActiveScheduleOverride[] = [
    { scope: "extension", extension: "101", source: "all", vitalPbxMohClassName: "moh_holiday", ruleId: "r_all", priority: 0 },
    { scope: "extension", extension: "101", source: "outbound", vitalPbxMohClassName: "moh_special", ruleId: "r_out", priority: 5 },
  ];
  const keys = buildSourcePublishKeys({ slug: "acme", staticPolicies: statics, activeOverrides: overrides });
  const fam = "connect/t_acme/extensions/101/moh/src";
  // outbound → specific schedule; internal → all schedule; every other source → all schedule.
  const map = new Map(keys.map((k) => [k.key, k.value]));
  assert.equal(map.get("outbound"), "moh_special");
  assert.equal(map.get("internal"), "moh_holiday");
  assert.equal(map.get("transfer"), "moh_holiday"); // covered by "all"
  // "all" expands to every source.
  assert.equal(keys.filter((k) => k.family === fam).length, 9);
});

test("buildSourcePublishKeys: highest priority wins within same specificity", () => {
  const overrides: ActiveScheduleOverride[] = [
    { scope: "tenant", extension: "", source: "internal", vitalPbxMohClassName: "low", ruleId: "a", priority: 1 },
    { scope: "tenant", extension: "", source: "internal", vitalPbxMohClassName: "high", ruleId: "b", priority: 9 },
  ];
  const keys = buildSourcePublishKeys({ slug: "acme", staticPolicies: [], activeOverrides: overrides });
  assert.deepEqual(keys, [{ family: "connect/t_acme/moh/src", key: "internal", value: "high" }]);
});

test("buildSourcePublishKeys: empty result when nothing configured", () => {
  assert.deepEqual(buildSourcePublishKeys({ slug: "acme", staticPolicies: [], activeOverrides: [] }), []);
});

// ── schedule active evaluation (timezone-safe) ──────────────────────────────

const baseRule = (over: Partial<ScheduleRuleRow>): ScheduleRuleRow => ({
  id: "r1",
  profileId: "p1",
  ruleType: "weekly",
  weekday: null,
  startTime: null,
  endTime: null,
  startAt: null,
  endAt: null,
  priority: 0,
  isActive: true,
  scope: "tenant",
  extension: "",
  callSource: "",
  ...over,
});

test("isScheduleRuleActive: one_time window (UTC)", () => {
  const rule = baseRule({
    ruleType: "one_time",
    startAt: new Date("2026-06-30T00:00:00Z"),
    endAt: new Date("2026-07-01T00:00:00Z"),
  });
  assert.equal(isScheduleRuleActive(rule, "UTC", new Date("2026-06-30T12:00:00Z")), true);
  assert.equal(isScheduleRuleActive(rule, "UTC", new Date("2026-07-02T12:00:00Z")), false);
});

test("isScheduleRuleActive: weekly window respects tenant timezone", () => {
  // Monday 09:00–17:00 local. 2026-06-29 is a Monday.
  const rule = baseRule({ ruleType: "weekly", weekday: 1, startTime: "09:00", endTime: "17:00" });
  // 14:00 UTC = 10:00 America/New_York (EDT, -4) → Monday, inside window.
  assert.equal(isScheduleRuleActive(rule, "America/New_York", new Date("2026-06-29T14:00:00Z")), true);
  // 02:00 UTC Monday = 22:00 Sunday NY → outside window (also wrong day).
  assert.equal(isScheduleRuleActive(rule, "America/New_York", new Date("2026-06-29T02:00:00Z")), false);
});

test("isScheduleRuleActive: holiday matches local date", () => {
  const rule = baseRule({ ruleType: "holiday", startTime: "2026-12-25" });
  assert.equal(isScheduleRuleActive(rule, "America/New_York", new Date("2026-12-25T15:00:00Z")), true);
  assert.equal(isScheduleRuleActive(rule, "America/New_York", new Date("2026-12-26T15:00:00Z")), false);
});

test("isScheduleRuleActive: inactive rule never active", () => {
  const rule = baseRule({ isActive: false, ruleType: "one_time", startAt: new Date(0), endAt: new Date("2999-01-01") });
  assert.equal(isScheduleRuleActive(rule, "UTC", new Date()), false);
});

test("computeActiveScheduleOverrides: projects active rules, maps classes, drops bad ones", () => {
  const now = new Date("2026-06-30T12:00:00Z");
  const rules: ScheduleRuleRow[] = [
    baseRule({ id: "active_all", ruleType: "one_time", startAt: new Date("2026-06-29T00:00:00Z"), endAt: new Date("2026-07-05T00:00:00Z"), scope: "extension", extension: "101", callSource: "" }),
    baseRule({ id: "active_src", ruleType: "one_time", startAt: new Date("2026-06-29T00:00:00Z"), endAt: new Date("2026-07-05T00:00:00Z"), callSource: "outbound", priority: 3 }),
    baseRule({ id: "expired", ruleType: "one_time", startAt: new Date("2026-01-01T00:00:00Z"), endAt: new Date("2026-01-02T00:00:00Z") }),
    baseRule({ id: "bad_source", ruleType: "one_time", startAt: new Date("2026-06-29T00:00:00Z"), endAt: new Date("2026-07-05T00:00:00Z"), callSource: "nonsense" }),
    baseRule({ id: "no_class", profileId: "missing", ruleType: "one_time", startAt: new Date("2026-06-29T00:00:00Z"), endAt: new Date("2026-07-05T00:00:00Z") }),
  ];
  const classFor = (pid: string) => (pid === "p1" ? "moh_sched" : null);
  const overrides = computeActiveScheduleOverrides(rules, classFor, "UTC", now);
  const ids = overrides.map((o) => o.ruleId).sort();
  assert.deepEqual(ids, ["active_all", "active_src"]);
  const all = overrides.find((o) => o.ruleId === "active_all")!;
  assert.equal(all.scope, "extension");
  assert.equal(all.extension, "101");
  assert.equal(all.source, "all");
  const src = overrides.find((o) => o.ruleId === "active_src")!;
  assert.equal(src.source, "outbound");
  assert.equal(src.vitalPbxMohClassName, "moh_sched");
});

test("integration: expired schedule reverts to static (via empty overrides)", () => {
  const statics: StaticSourcePolicy[] = [
    { scope: "extension", extension: "101", source: "internal", vitalPbxMohClassName: "static_int", enabled: true },
  ];
  // While active, an "all" override covers internal.
  const active = buildSourcePublishKeys({
    slug: "acme",
    staticPolicies: statics,
    activeOverrides: [{ scope: "extension", extension: "101", source: "all", vitalPbxMohClassName: "moh_holiday", ruleId: "r", priority: 0 }],
  });
  assert.equal(new Map(active.map((k) => [k.key, k.value])).get("internal"), "moh_holiday");
  // After expiry (no active overrides) it reverts to the static policy.
  const reverted = buildSourcePublishKeys({ slug: "acme", staticPolicies: statics, activeOverrides: [] });
  assert.deepEqual(reverted, [{ family: "connect/t_acme/extensions/101/moh/src", key: "internal", value: "static_int" }]);
});
