// Unit tests for the per-call-source MOH taxonomy, classifier, resolution
// engine, and publish-key builders. Pure logic — no DB, no AstDB, no Fastify.
//
// These directly exercise the Requirement-4 priority order and several of the
// Requirement-12 scenarios at the resolution level (scheduled active, scheduled
// expired/reverted, tenant default fallback, extension override fallback,
// missing → PBX default, isolation of source tokens).

import test from "node:test";
import assert from "node:assert/strict";
import {
  MOH_CALL_SOURCES,
  MOH_CALL_SOURCE_LABELS,
  buildExtensionSourceMohKeys,
  buildTenantSourceMohKeys,
  classifyDialplanMohSource,
  computeSourceKeysClearForRollback,
  extensionSourceMohFamily,
  isMohCallSource,
  normalizeMohCallSource,
  resolveEffectiveMohClass,
  tenantSourceMohFamily,
  type MohCallSource,
  type MohSourcePolicyRow,
} from "./mohCallSource";

// ── Taxonomy ──────────────────────────────────────────────────────────────

test("taxonomy: canonical source list is stable and lowercase", () => {
  assert.deepEqual(
    [...MOH_CALL_SOURCES],
    [
      "inbound_direct",
      "inbound_ivr",
      "inbound_ringgroup",
      "inbound_queue",
      "internal",
      "outbound",
      "transfer",
      "parked",
      "mobile_app",
    ],
  );
  for (const s of MOH_CALL_SOURCES) {
    assert.match(s, /^[a-z_]+$/, `source token ${s} must be [a-z_]`);
    assert.ok(MOH_CALL_SOURCE_LABELS[s], `label missing for ${s}`);
  }
});

test("isMohCallSource / normalizeMohCallSource", () => {
  assert.equal(isMohCallSource("outbound"), true);
  assert.equal(isMohCallSource("OUTBOUND"), false);
  assert.equal(isMohCallSource("nope"), false);
  assert.equal(isMohCallSource(null), false);
  assert.equal(normalizeMohCallSource("  Outbound "), "outbound");
  assert.equal(normalizeMohCallSource("transfer"), "transfer");
  assert.equal(normalizeMohCallSource("bogus"), null);
  assert.equal(normalizeMohCallSource(42 as unknown), null);
});

// ── Classifier ──────────────────────────────────────────────────────────────

test("classifier: priority order (transfer beats everything)", () => {
  assert.equal(
    classifyDialplanMohSource({ transfer: true, queue: true, ringGroup: true, ivr: true, fromTrunk: true }),
    "transfer",
  );
});

test("classifier: park beats queue/ring/ivr", () => {
  assert.equal(classifyDialplanMohSource({ parked: true, queue: true }), "parked");
});

test("classifier: ring group beats queue beats ivr beats trunk (matches installed dialplan order)", () => {
  assert.equal(classifyDialplanMohSource({ ringGroup: true, queue: true, ivr: true, fromTrunk: true }), "inbound_ringgroup");
  assert.equal(classifyDialplanMohSource({ queue: true, ivr: true, fromTrunk: true }), "inbound_queue");
  assert.equal(classifyDialplanMohSource({ ivr: true, fromTrunk: true }), "inbound_ivr");
  assert.equal(classifyDialplanMohSource({ fromTrunk: true }), "inbound_direct");
});

test("classifier: outbound and mobile and internal defaults", () => {
  assert.equal(classifyDialplanMohSource({ toTrunk: true }), "outbound");
  assert.equal(classifyDialplanMohSource({ mobileApp: true }), "mobile_app");
  assert.equal(classifyDialplanMohSource({}), "internal");
  assert.equal(classifyDialplanMohSource(null), "internal");
  assert.equal(classifyDialplanMohSource(undefined), "internal");
});

// ── Resolution priority (Requirement 4) ──────────────────────────────────────

test("resolve: (1) active scheduled extension override wins over everything", () => {
  const r = resolveEffectiveMohClass({
    source: "internal",
    scheduledExtensionClass: "moh9",
    scheduledExtensionRuleId: "rule_1",
    extensionSourceClass: "moh2",
    extensionDefaultClass: "moh3",
    tenantSourceClass: "moh4",
    tenantDefaultClass: "moh5",
    globalDefaultClass: "moh6",
  });
  assert.deepEqual(r, { class: "moh9", reason: "schedule_extension", source: "internal", ruleId: "rule_1" });
});

test("resolve: (2) extension per-source beats ext default + tenant + global", () => {
  const r = resolveEffectiveMohClass({
    source: "outbound",
    extensionSourceClass: "moh2",
    extensionDefaultClass: "moh3",
    tenantSourceClass: "moh4",
    tenantDefaultClass: "moh5",
    globalDefaultClass: "moh6",
  });
  assert.equal(r.class, "moh2");
  assert.equal(r.reason, "extension_source");
});

test("resolve: (2b) extension default when no per-source ext policy", () => {
  const r = resolveEffectiveMohClass({
    source: "outbound",
    extensionDefaultClass: "moh3",
    tenantSourceClass: "moh4",
    tenantDefaultClass: "moh5",
  });
  assert.equal(r.class, "moh3");
  assert.equal(r.reason, "extension_default");
});

test("resolve: (3) tenant per-source beats tenant default + global", () => {
  const r = resolveEffectiveMohClass({
    source: "inbound_ivr",
    tenantSourceClass: "moh4",
    tenantDefaultClass: "moh5",
    globalDefaultClass: "moh6",
  });
  assert.equal(r.class, "moh4");
  assert.equal(r.reason, "tenant_source");
});

test("resolve: (3b) tenant default fallback", () => {
  const r = resolveEffectiveMohClass({ source: "internal", tenantDefaultClass: "moh5", globalDefaultClass: "moh6" });
  assert.equal(r.class, "moh5");
  assert.equal(r.reason, "tenant_default");
});

test("resolve: (4) global default fallback", () => {
  const r = resolveEffectiveMohClass({ source: "internal", globalDefaultClass: "moh6" });
  assert.equal(r.class, "moh6");
  assert.equal(r.reason, "global_default");
});

test("resolve: (5) nothing configured → pbx_default (null, never throws)", () => {
  const r = resolveEffectiveMohClass({ source: "internal" });
  assert.equal(r.class, null);
  assert.equal(r.reason, "pbx_default");
});

test("resolve: empty/whitespace values are treated as unset (tombstone-safe)", () => {
  const r = resolveEffectiveMohClass({
    source: "transfer",
    scheduledExtensionClass: "   ",
    extensionSourceClass: "",
    extensionDefaultClass: null,
    tenantSourceClass: "  ",
    tenantDefaultClass: "moh5",
  });
  assert.equal(r.class, "moh5");
  assert.equal(r.reason, "tenant_default");
});

test("resolve: scheduled expired (empty schedule input) reverts to next level", () => {
  // The caller passes an empty scheduledExtensionClass once the rule expires;
  // resolution must fall to the static extension/tenant value.
  const active = resolveEffectiveMohClass({
    source: "internal",
    scheduledExtensionClass: "moh_holiday",
    extensionSourceClass: "moh_normal",
  });
  assert.equal(active.class, "moh_holiday");
  const expired = resolveEffectiveMohClass({
    source: "internal",
    scheduledExtensionClass: "",
    extensionSourceClass: "moh_normal",
  });
  assert.equal(expired.class, "moh_normal");
  assert.equal(expired.reason, "extension_source");
});

// ── AstDB families ────────────────────────────────────────────────────────

test("families: deterministic and tenant/extension scoped", () => {
  assert.equal(tenantSourceMohFamily("acme"), "connect/t_acme/moh/src");
  assert.equal(extensionSourceMohFamily("acme", "101"), "connect/t_acme/extensions/101/moh/src");
});

test("families: reject unsafe slug/extension (isolation defence)", () => {
  assert.throws(() => tenantSourceMohFamily("../evil"));
  assert.throws(() => tenantSourceMohFamily("a/b"));
  assert.throws(() => extensionSourceMohFamily("acme", "10/1"));
  assert.throws(() => extensionSourceMohFamily("acme", "a".repeat(33)));
});

// ── Key builders ────────────────────────────────────────────────────────────

const rows = (r: Array<Partial<MohSourcePolicyRow>>): MohSourcePolicyRow[] =>
  r.map((x) => ({ source: x.source as MohCallSource, vitalPbxMohClassName: x.vitalPbxMohClassName ?? "", enabled: x.enabled ?? true }));

test("buildTenantSourceMohKeys: emits sorted, valid, enabled rows only", () => {
  const keys = buildTenantSourceMohKeys(
    "acme",
    rows([
      { source: "outbound", vitalPbxMohClassName: "moh2" },
      { source: "internal", vitalPbxMohClassName: "moh1" },
      { source: "transfer", vitalPbxMohClassName: "moh3", enabled: false }, // dropped
      { source: "inbound_ivr", vitalPbxMohClassName: "" }, // dropped (empty)
      { source: "bogus" as MohCallSource, vitalPbxMohClassName: "moh4" }, // dropped (invalid)
    ]),
  );
  assert.deepEqual(keys, [
    { family: "connect/t_acme/moh/src", key: "internal", value: "moh1" },
    { family: "connect/t_acme/moh/src", key: "outbound", value: "moh2" },
  ]);
});

test("buildTenantSourceMohKeys: de-dupes on source (first wins)", () => {
  const keys = buildTenantSourceMohKeys(
    "acme",
    rows([
      { source: "internal", vitalPbxMohClassName: "moh1" },
      { source: "internal", vitalPbxMohClassName: "moh9" },
    ]),
  );
  assert.deepEqual(keys, [{ family: "connect/t_acme/moh/src", key: "internal", value: "moh1" }]);
});

test("buildExtensionSourceMohKeys: extension-scoped family", () => {
  const keys = buildExtensionSourceMohKeys("acme", "101", rows([{ source: "outbound", vitalPbxMohClassName: "moh2" }]));
  assert.deepEqual(keys, [{ family: "connect/t_acme/extensions/101/moh/src", key: "outbound", value: "moh2" }]);
});

// ── Rollback tombstones ───────────────────────────────────────────────────

test("computeSourceKeysClearForRollback: clears only newly-added per-source keys", () => {
  const prev = [{ family: "connect/t_acme/moh/src", key: "internal", value: "moh1" }];
  const target = [
    { family: "connect/t_acme/moh/src", key: "internal", value: "moh1" }, // existed before → not cleared
    { family: "connect/t_acme/moh/src", key: "outbound", value: "moh2" }, // added → cleared
    { family: "connect/t_acme/extensions/101/moh/src", key: "transfer", value: "moh3" }, // added → cleared
    { family: "connect/t_acme", key: "moh_class", value: "moh5" }, // not a /moh/src family → ignored
  ];
  const clears = computeSourceKeysClearForRollback(target, prev);
  assert.deepEqual(clears, [
    { family: "connect/t_acme/extensions/101/moh/src", key: "transfer", value: "" },
    { family: "connect/t_acme/moh/src", key: "outbound", value: "" },
  ]);
});
