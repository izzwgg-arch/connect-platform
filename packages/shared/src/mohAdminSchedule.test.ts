// Admin (multi-tenant) MOH schedule — priority + restore + stale-key proofs.
//
// These encode the Option-C priority the owner approved (2026-07-01):
//   1. Admin multi-tenant active schedule   (global takeover for selected tenants)
//   2. Extension active schedule
//   3. Extension static override
//   4. Tenant active schedule   (folded into tenant keys → per-scope, never
//      surprises a pinned extension)
//   5. Tenant static override
//   6. Global/admin default if enabled
//   7. PBX / native control
//
// and the hard restore rule: when an admin schedule ends we ONLY tombstone the
// admin-overlay keys, so the exact prior effective state (extension overrides,
// tenant defaults, PBX-control) returns with zero stale AstDB keys.

import test from "node:test";
import assert from "node:assert/strict";
import {
  adminOverlayKeyIdsForExtension,
  adminOverlayKeyIdsForTenant,
  buildExtensionAdminOverlayKeys,
  buildTenantAdminOverlayKeys,
  buildTenantSourceMohKeys,
  computeForwardKeyClears,
  extensionAdminDefaultKey,
  isClearableForwardKey,
  resolveEffectiveMohClass,
  tenantAdminDefaultKey,
  tenantDefaultClassKeys,
  type MohAstDbKey,
  type MohCallSource,
  type MohSourcePolicyRow,
} from "./mohCallSource";
import {
  buildAdminFallbackTenantClassKeys,
  buildAdminOverlayKeysForTenant,
  computeActiveAdminOverrides,
  isAdminScheduleActive,
  planAdminScheduleFallback,
  resolveAdminScheduleFallback,
  selectAdminFallbackTenantClass,
  type AdminScheduleRow,
} from "./mohSourcePublish";

// ─────────────────────────────────────────────────────────────────────────────
// Priority proofs
// ─────────────────────────────────────────────────────────────────────────────

test("REQUIRED: extension static override beats a tenant schedule", () => {
  // A tenant schedule is folded into the tenant keys upstream, so at resolution
  // time it arrives as tenantSourceClass/tenantDefaultClass. A pinned extension
  // must still win — a normal tenant schedule never surprises a pinned ext.
  const r = resolveEffectiveMohClass({
    source: "internal",
    extensionSourceClass: "ext_pinned",
    tenantSourceClass: "tenant_schedule_folded", // the active tenant schedule value
    tenantDefaultClass: "tenant_default",
  });
  assert.equal(r.class, "ext_pinned");
  assert.equal(r.reason, "extension_source");
});

test("REQUIRED: admin multi-tenant schedule beats an extension static override", () => {
  const r = resolveEffectiveMohClass({
    source: "internal",
    adminScheduleTenantClass: "yom_tov",
    adminScheduleTenantRuleId: "admin_1",
    scheduledExtensionClass: "ext_schedule",
    extensionSourceClass: "ext_pinned",
    tenantDefaultClass: "tenant_default",
  });
  assert.equal(r.class, "yom_tov");
  assert.equal(r.reason, "admin_schedule_tenant");
  assert.equal(r.ruleId, "admin_1");
});

test("admin extension-target beats admin tenant-target (more specific)", () => {
  const r = resolveEffectiveMohClass({
    source: "internal",
    adminScheduleExtensionClass: "admin_ext_music",
    adminScheduleExtensionRuleId: "admin_ext_1",
    adminScheduleTenantClass: "admin_tenant_music",
  });
  assert.equal(r.class, "admin_ext_music");
  assert.equal(r.reason, "admin_schedule_extension");
});

test("admin schedule beats an active per-tenant extension schedule too", () => {
  const r = resolveEffectiveMohClass({
    source: "internal",
    adminScheduleTenantClass: "yom_tov",
    scheduledExtensionClass: "ext_holiday", // ext schedule loses to admin
  });
  assert.equal(r.class, "yom_tov");
  assert.equal(r.reason, "admin_schedule_tenant");
});

// ─────────────────────────────────────────────────────────────────────────────
// Restore proofs — admin schedule ends → tombstone ONLY admin keys
// ─────────────────────────────────────────────────────────────────────────────

test("REQUIRED: after admin schedule ends, extension static override comes back", () => {
  // While active the ext admin key is present; after end it is "" (tombstone).
  const active = resolveEffectiveMohClass({
    source: "internal",
    adminScheduleTenantClass: "yom_tov",
    extensionSourceClass: "ext_pinned",
  });
  assert.equal(active.class, "yom_tov");
  const afterEnd = resolveEffectiveMohClass({
    source: "internal",
    adminScheduleTenantClass: "", // cleared
    adminScheduleExtensionClass: "", // cleared
    extensionSourceClass: "ext_pinned",
  });
  assert.equal(afterEnd.class, "ext_pinned");
  assert.equal(afterEnd.reason, "extension_source");
});

test("REQUIRED: after admin schedule ends, tenant defaults come back", () => {
  const afterEnd = resolveEffectiveMohClass({
    source: "inbound_direct",
    adminScheduleTenantClass: "",
    tenantDefaultClass: "tenant_default",
  });
  assert.equal(afterEnd.class, "tenant_default");
  assert.equal(afterEnd.reason, "tenant_default");
});

test("REQUIRED: PBX-control settings restore — no keys → pbx_default", () => {
  // A PBX-controlled tenant has no Connect keys. An admin schedule can still
  // take it over (adminScheduleTenantClass set). When it ends and its overlay
  // keys are cleared, resolution falls all the way through to pbx_default —
  // i.e. native VitalPBX MOH — with nothing left behind.
  const during = resolveEffectiveMohClass({ source: "internal", adminScheduleTenantClass: "yom_tov" });
  assert.equal(during.class, "yom_tov");
  const restored = resolveEffectiveMohClass({ source: "internal", adminScheduleTenantClass: "" });
  assert.equal(restored.class, null);
  assert.equal(restored.reason, "pbx_default");
});

// ─────────────────────────────────────────────────────────────────────────────
// Stale-key proofs — computeForwardKeyClears
// ─────────────────────────────────────────────────────────────────────────────

test("REQUIRED: ending an admin takeover leaves no stale AstDB keys", () => {
  const slug = "acme";
  const prev: MohAstDbKey[] = [
    ...buildTenantAdminOverlayKeys(slug, "yom_tov"), // admin default key present
    ...buildExtensionAdminOverlayKeys(slug, "101", "yom_tov"),
    { family: `connect/t_${slug}`, key: "moh_class", value: "tenant_default" }, // always-rewritten, not cleared
  ];
  // Next publish: admin ended → no admin keys, tenant default re-emitted.
  const next: MohAstDbKey[] = [{ family: `connect/t_${slug}`, key: "moh_class", value: "tenant_default" }];
  const clears = computeForwardKeyClears(prev, next);
  const cleared = new Set(clears.map((k) => `${k.family}\u0000${k.key}`));
  // Admin default keys are tombstoned.
  const td = tenantAdminDefaultKey(slug);
  const ed = extensionAdminDefaultKey(slug, "101");
  assert.ok(cleared.has(`${td.family}\u0000${td.key}`), "tenant admin default cleared");
  assert.ok(cleared.has(`${ed.family}\u0000${ed.key}`), "extension admin default cleared");
  // Every clear is an empty-string tombstone.
  for (const k of clears) assert.equal(k.value, "");
  // The always-rewritten tenant moh_class was NOT tombstoned.
  assert.ok(!cleared.has(`connect/t_${slug}\u0000moh_class`), "tenant default must not be cleared");
});

test("REQUIRED: tenant switch A→B→A leaves no stale per-source keys", () => {
  const slug = "acme";
  const rowsA: MohSourcePolicyRow[] = [
    { source: "outbound" as MohCallSource, vitalPbxMohClassName: "A_out", enabled: true },
    { source: "internal" as MohCallSource, vitalPbxMohClassName: "A_int", enabled: true },
  ];
  const prev = buildTenantSourceMohKeys(slug, rowsA);
  // Switch to B which only sets 'internal' — 'outbound' must be tombstoned.
  const rowsB: MohSourcePolicyRow[] = [{ source: "internal" as MohCallSource, vitalPbxMohClassName: "B_int", enabled: true }];
  const next = buildTenantSourceMohKeys(slug, rowsB);
  const clears = computeForwardKeyClears(prev, next);
  assert.deepEqual(clears, [{ family: "connect/t_acme/moh/src", key: "outbound", value: "" }]);
});

test("computeForwardKeyClears never tombstones announcement / hold-mode keys", () => {
  const prev: MohAstDbKey[] = [
    { family: "connect/t_acme", key: "hold_mode", value: "ringback" },
    { family: "connect/t_acme", key: "hold_announcement_ref", value: "greeting" },
    { family: "connect/t_acme/moh/src", key: "outbound", value: "moh2" },
  ];
  const next: MohAstDbKey[] = [];
  const clears = computeForwardKeyClears(prev, next);
  // Only the /moh/src key is clearable; hold_mode + announcement keys are not.
  assert.deepEqual(clears, [{ family: "connect/t_acme/moh/src", key: "outbound", value: "" }]);
});

test("isClearableForwardKey classification", () => {
  assert.equal(isClearableForwardKey("connect/t_acme/moh/src", "outbound"), true);
  assert.equal(isClearableForwardKey("connect/t_acme/moh/admin_src", "internal"), true);
  assert.equal(isClearableForwardKey("connect/t_acme/extensions/101", "moh_class"), true);
  assert.equal(isClearableForwardKey("connect/t_acme/extensions/101", "admin_moh_class"), true);
  assert.equal(isClearableForwardKey("connect/t_acme", "admin_moh_class"), true);
  assert.equal(isClearableForwardKey("connect/pbx_tenant_map/3", "moh_class"), true);
  // Not clearable:
  assert.equal(isClearableForwardKey("connect/t_acme", "moh_class"), false);
  assert.equal(isClearableForwardKey("connect/t_acme", "hold_mode"), false);
  assert.equal(isClearableForwardKey("connect/system", "moh_default_class"), false);
});

test("adminOverlayKeyIds cover every source + the default key", () => {
  const t = adminOverlayKeyIdsForTenant("acme");
  // 9 sources + 1 default.
  assert.equal(t.length, 10);
  assert.deepEqual(t[t.length - 1], tenantAdminDefaultKey("acme"));
  const e = adminOverlayKeyIdsForExtension("acme", "101");
  assert.equal(e.length, 10);
  assert.deepEqual(e[e.length - 1], extensionAdminDefaultKey("acme", "101"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin schedule time evaluation + fan-out
// ─────────────────────────────────────────────────────────────────────────────

const adminBase = (over: Partial<AdminScheduleRow>): AdminScheduleRow => ({
  id: "as1",
  enabled: true,
  scheduleKind: "one_time",
  timezone: "America/New_York",
  vitalPbxMohClassName: "yom_tov",
  priority: 0,
  startAt: null,
  endAt: null,
  startWeekday: null,
  startTime: null,
  endWeekday: null,
  endTime: null,
  targets: [],
  ...over,
});

test("isAdminScheduleActive: one_time span (Fri 2PM → Sun 11PM)", () => {
  const s = adminBase({
    scheduleKind: "one_time",
    startAt: new Date("2026-07-03T18:00:00Z"), // Fri 14:00 EDT
    endAt: new Date("2026-07-06T03:00:00Z"), // Sun 23:00 EDT
  });
  assert.equal(isAdminScheduleActive(s, new Date("2026-07-04T12:00:00Z")), true); // Sat
  assert.equal(isAdminScheduleActive(s, new Date("2026-07-02T12:00:00Z")), false); // before
  assert.equal(isAdminScheduleActive(s, new Date("2026-07-06T12:00:00Z")), false); // after
});

test("isAdminScheduleActive: recurring wrap-around window (Fri 22:00 → Mon 06:00)", () => {
  const s = adminBase({
    scheduleKind: "recurring",
    startWeekday: 5, // Fri
    startTime: "22:00",
    endWeekday: 1, // Mon
    endTime: "06:00",
    timezone: "UTC",
  });
  // Saturday noon UTC is inside the wrap window.
  assert.equal(isAdminScheduleActive(s, new Date("2026-07-04T12:00:00Z")), true);
  // Wednesday noon UTC is outside.
  assert.equal(isAdminScheduleActive(s, new Date("2026-07-01T12:00:00Z")), false);
});

test("isAdminScheduleActive: disabled schedule never active", () => {
  const s = adminBase({ enabled: false, scheduleKind: "one_time", startAt: new Date(0), endAt: new Date("2999-01-01") });
  assert.equal(isAdminScheduleActive(s, new Date()), false);
});

test("computeActiveAdminOverrides: fans out to all targets, highest priority wins", () => {
  const now = new Date("2026-07-04T12:00:00Z");
  const win = { scheduleKind: "one_time", startAt: new Date("2026-07-03T00:00:00Z"), endAt: new Date("2026-07-07T00:00:00Z") } as const;
  const scheds: AdminScheduleRow[] = [
    adminBase({ id: "low", priority: 1, vitalPbxMohClassName: "low_music", ...win, targets: [{ tenantSlug: "t2", extension: "" }, { tenantSlug: "t3", extension: "" }] }),
    adminBase({ id: "high", priority: 9, vitalPbxMohClassName: "yom_tov", ...win, targets: [{ tenantSlug: "t2", extension: "" }, { tenantSlug: "t21", extension: "101" }] }),
  ];
  const active = computeActiveAdminOverrides(scheds, now);
  // t2 appears once, resolved to the higher-priority schedule.
  const t2 = active.filter((o) => o.tenantSlug === "t2");
  assert.equal(t2.length, 1);
  assert.equal(t2[0].vitalPbxMohClassName, "yom_tov");
  // t3 (only from low), t21/101 (from high).
  assert.ok(active.find((o) => o.tenantSlug === "t3" && o.vitalPbxMohClassName === "low_music"));
  const t21 = active.find((o) => o.tenantSlug === "t21");
  assert.equal(t21?.extension, "101");
});

// ─────────────────────────────────────────────────────────────────────────────
// End-of-window fallback decision (design choice C: restore_previous | fallback_class)
// ─────────────────────────────────────────────────────────────────────────────

test("REQUIRED: fallback default is restore_previous (exact snapshot)", () => {
  assert.deepEqual(resolveAdminScheduleFallback({ fallbackMode: "restore_previous", fallbackClass: null }), {
    action: "restore_previous",
  });
  // Unset / unknown / empty mode all fail safe to restore_previous.
  assert.deepEqual(resolveAdminScheduleFallback({ fallbackMode: "", fallbackClass: null }), { action: "restore_previous" });
  assert.deepEqual(resolveAdminScheduleFallback({ fallbackMode: null, fallbackClass: null }), { action: "restore_previous" });
  assert.deepEqual(resolveAdminScheduleFallback({ fallbackMode: "weird", fallbackClass: "x" }), { action: "restore_previous" });
});

test("REQUIRED: explicit fallback_class returns the class to set", () => {
  assert.deepEqual(resolveAdminScheduleFallback({ fallbackMode: "fallback_class", fallbackClass: "lobby_music" }), {
    action: "set_class",
    vitalPbxMohClassName: "lobby_music",
  });
  // Case/whitespace tolerant on mode; class is trimmed by firstNonEmpty upstream.
  assert.deepEqual(resolveAdminScheduleFallback({ fallbackMode: "FALLBACK_CLASS", fallbackClass: "moh2" }), {
    action: "set_class",
    vitalPbxMohClassName: "moh2",
  });
});

test("fallback_class with empty class fails safe to restore_previous", () => {
  assert.deepEqual(resolveAdminScheduleFallback({ fallbackMode: "fallback_class", fallbackClass: "" }), {
    action: "restore_previous",
  });
  assert.deepEqual(resolveAdminScheduleFallback({ fallbackMode: "fallback_class", fallbackClass: "   " }), {
    action: "restore_previous",
  });
});

test("buildAdminOverlayKeysForTenant: tenant + extension targets", () => {
  const active = computeActiveAdminOverrides(
    [
      adminBase({
        id: "h",
        vitalPbxMohClassName: "yom_tov",
        scheduleKind: "one_time",
        startAt: new Date("2026-07-03T00:00:00Z"),
        endAt: new Date("2026-07-07T00:00:00Z"),
        targets: [{ tenantSlug: "t2", extension: "" }, { tenantSlug: "t2", extension: "205" }],
      }),
    ],
    new Date("2026-07-04T12:00:00Z"),
  );
  const keys = buildAdminOverlayKeysForTenant("t2", active);
  const map = new Map(keys.map((k) => [`${k.family}\u0000${k.key}`, k.value]));
  const td = tenantAdminDefaultKey("t2");
  const ed = extensionAdminDefaultKey("t2", "205");
  assert.equal(map.get(`${td.family}\u0000${td.key}`), "yom_tov");
  assert.equal(map.get(`${ed.family}\u0000${ed.key}`), "yom_tov");
});

// ─────────────────────────────────────────────────────────────────────────────
// Explicit fallback LIVE wiring (design choice C, 2026-07-01)
//
// The persisted/API mode token is "explicit" (NOT "fallback_class"). These prove
// the live worker/reconcile decisions: token mapping, validity gating, PBX-safe
// skip, multi-tenant selection, tenant-level publish, and that extension pins
// return afterwards.
// ─────────────────────────────────────────────────────────────────────────────

test("REQUIRED: 'explicit' is the live token → set_class (mode alias mapping)", () => {
  // The real DB/API value is "explicit"; "fallback_class" stays a tolerated alias.
  assert.deepEqual(resolveAdminScheduleFallback({ fallbackMode: "explicit", fallbackClass: "moh2" }), {
    action: "set_class",
    vitalPbxMohClassName: "moh2",
  });
  assert.deepEqual(resolveAdminScheduleFallback({ fallbackMode: "EXPLICIT", fallbackClass: "connect_t2_lobby" }), {
    action: "set_class",
    vitalPbxMohClassName: "connect_t2_lobby",
  });
  // Alias still works so older callers/tests do not break.
  assert.deepEqual(resolveAdminScheduleFallback({ fallbackMode: "fallback_class", fallbackClass: "moh3" }), {
    action: "set_class",
    vitalPbxMohClassName: "moh3",
  });
});

test("REQUIRED: planAdminScheduleFallback gates on publish validation", () => {
  // Valid native + connect classes → applied.
  assert.deepEqual(planAdminScheduleFallback({ fallbackMode: "explicit", fallbackClass: "moh5" }), {
    action: "set_class",
    vitalPbxMohClassName: "moh5",
  });
  assert.deepEqual(planAdminScheduleFallback({ fallbackMode: "explicit", fallbackClass: "connect_acme_jazz" }), {
    action: "set_class",
    vitalPbxMohClassName: "connect_acme_jazz",
  });
  // Invalid/unsafe class → refused, fails safe to restore_previous (design C).
  assert.deepEqual(planAdminScheduleFallback({ fallbackMode: "explicit", fallbackClass: "../etc/passwd" }), {
    action: "restore_previous",
    refusedClass: "../etc/passwd",
  });
  assert.deepEqual(planAdminScheduleFallback({ fallbackMode: "explicit", fallbackClass: "not a class" }), {
    action: "restore_previous",
    refusedClass: "not a class",
  });
  assert.deepEqual(planAdminScheduleFallback({ fallbackMode: "explicit", fallbackClass: "randomName" }), {
    action: "restore_previous",
    refusedClass: "randomName",
  });
});

test("REQUIRED: missing / restore_previous fallback → restore_previous (no refusal)", () => {
  assert.deepEqual(planAdminScheduleFallback({ fallbackMode: "explicit", fallbackClass: "" }), { action: "restore_previous" });
  assert.deepEqual(planAdminScheduleFallback({ fallbackMode: "explicit", fallbackClass: null }), { action: "restore_previous" });
  assert.deepEqual(planAdminScheduleFallback({ fallbackMode: "restore_previous", fallbackClass: "moh2" }), { action: "restore_previous" });
});

test("planAdminScheduleFallback: custom validity predicate honored", () => {
  const only = (c: string) => c === "lobby";
  assert.deepEqual(planAdminScheduleFallback({ fallbackMode: "explicit", fallbackClass: "lobby", isValidClass: only }), {
    action: "set_class",
    vitalPbxMohClassName: "lobby",
  });
  assert.deepEqual(planAdminScheduleFallback({ fallbackMode: "explicit", fallbackClass: "moh2", isValidClass: only }), {
    action: "restore_previous",
    refusedClass: "moh2",
  });
});

test("REQUIRED: fallback publishes at TENANT level (moh_class + active_moh_class)", () => {
  const keys = buildAdminFallbackTenantClassKeys("t2", "moh5");
  assert.deepEqual(keys, tenantDefaultClassKeys("t2", "moh5"));
  const map = new Map(keys.map((k) => [k.key, k.value]));
  assert.equal(map.get("moh_class"), "moh5");
  assert.equal(map.get("active_moh_class"), "moh5");
  assert.ok(keys.every((k) => k.family === "connect/t_t2"), "fallback is a tenant-default key, never an overlay/extension key");
  // Empty class → no keys (nothing to publish).
  assert.deepEqual(buildAdminFallbackTenantClassKeys("t2", "   "), []);
});

test("fallback key set is deterministic (idempotent double-run)", () => {
  assert.deepEqual(buildAdminFallbackTenantClassKeys("t2", "moh5"), buildAdminFallbackTenantClassKeys("t2", "moh5"));
});

test("REQUIRED: after explicit fallback, an extension pin still beats the tenant fallback", () => {
  // Fallback set the tenant default to moh5; the overlay keys are gone. A pinned
  // extension (read before tenant default) must still win.
  const withPin = resolveEffectiveMohClass({
    source: "internal",
    adminScheduleTenantClass: "", // overlay cleared
    extensionSourceClass: "ext_pinned",
    tenantDefaultClass: "moh5", // fallback published here
  });
  assert.equal(withPin.class, "ext_pinned");
  assert.equal(withPin.reason, "extension_source");
  // With no pin, the tenant now sits on the explicit fallback class.
  const noPin = resolveEffectiveMohClass({
    source: "internal",
    adminScheduleTenantClass: "",
    tenantDefaultClass: "moh5",
  });
  assert.equal(noPin.class, "moh5");
  assert.equal(noPin.reason, "tenant_default");
});

test("REQUIRED: selectAdminFallbackTenantClass — highest-priority valid explicit wins", () => {
  const sel = selectAdminFallbackTenantClass({
    tenantControlMode: "connect",
    candidates: [
      { scheduleId: "a", extension: "", fallbackMode: "explicit", fallbackClass: "moh2", priority: 1 },
      { scheduleId: "b", extension: "", fallbackMode: "explicit", fallbackClass: "moh5", priority: 9 },
      { scheduleId: "c", extension: "", fallbackMode: "restore_previous", fallbackClass: null, priority: 100 },
    ],
  });
  assert.equal(sel.appliedClass, "moh5");
  assert.deepEqual(sel.refusedClasses, []);
  assert.equal(sel.skippedForPbx, false);
  assert.deepEqual(sel.blockedExtensionScoped, []);
});

test("REQUIRED: selectAdminFallbackTenantClass — PBX-controlled tenant is never forced", () => {
  const sel = selectAdminFallbackTenantClass({
    tenantControlMode: "pbx",
    candidates: [{ scheduleId: "a", extension: "", fallbackMode: "explicit", fallbackClass: "moh5", priority: 5 }],
  });
  assert.equal(sel.appliedClass, null); // no Connect class forced onto a PBX tenant
  assert.equal(sel.skippedForPbx, true);
});

test("selectAdminFallbackTenantClass — invalid class refused, falls back to restore_previous", () => {
  const sel = selectAdminFallbackTenantClass({
    tenantControlMode: "connect",
    candidates: [{ scheduleId: "a", extension: "", fallbackMode: "explicit", fallbackClass: "bad name", priority: 5 }],
  });
  assert.equal(sel.appliedClass, null);
  assert.deepEqual(sel.refusedClasses, ["bad name"]);
  assert.equal(sel.skippedForPbx, false);
});

test("REQUIRED: multi-tenant explicit fallback resolves per tenant independently", () => {
  // Two tenants ending at once, each with its own explicit fallback class; the
  // per-tenant key sets are distinct and land only under that tenant's family.
  const t2 = selectAdminFallbackTenantClass({
    tenantControlMode: "connect",
    candidates: [{ scheduleId: "s1", extension: "", fallbackMode: "explicit", fallbackClass: "moh2", priority: 0 }],
  });
  const t3 = selectAdminFallbackTenantClass({
    tenantControlMode: "connect",
    candidates: [{ scheduleId: "s1", extension: "", fallbackMode: "explicit", fallbackClass: "connect_t3_holiday", priority: 0 }],
  });
  const k2 = buildAdminFallbackTenantClassKeys("t2", t2.appliedClass!);
  const k3 = buildAdminFallbackTenantClassKeys("t3", t3.appliedClass!);
  assert.ok(k2.every((k) => k.family === "connect/t_t2"));
  assert.ok(k3.every((k) => k.family === "connect/t_t3"));
  assert.equal(new Map(k2.map((k) => [k.key, k.value])).get("moh_class"), "moh2");
  assert.equal(new Map(k3.map((k) => [k.key, k.value])).get("moh_class"), "connect_t3_holiday");
});

test("selectAdminFallbackTenantClass — no ending explicit candidates → restore_previous (null)", () => {
  const sel = selectAdminFallbackTenantClass({ tenantControlMode: "connect", candidates: [] });
  assert.equal(sel.appliedClass, null);
  assert.deepEqual(sel.refusedClasses, []);
  assert.equal(sel.skippedForPbx, false);
  assert.deepEqual(sel.blockedExtensionScoped, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Target-scope fallback correction — extension-scoped explicit NEVER touches tenant
// ─────────────────────────────────────────────────────────────────────────────

test("REQUIRED: tenant-scoped target explicit fallback DOES write tenant-level class", () => {
  const sel = selectAdminFallbackTenantClass({
    tenantControlMode: "connect",
    candidates: [{ scheduleId: "s1", extension: "", fallbackMode: "explicit", fallbackClass: "moh5", priority: 0 }],
  });
  assert.equal(sel.appliedClass, "moh5");
  assert.deepEqual(sel.blockedExtensionScoped, []);
});

test("REQUIRED: extension-scoped target explicit fallback does NOT write tenant-level class", () => {
  const sel = selectAdminFallbackTenantClass({
    tenantControlMode: "connect",
    candidates: [{ scheduleId: "s1", extension: "101", fallbackMode: "explicit", fallbackClass: "moh5", priority: 9 }],
  });
  assert.equal(sel.appliedClass, null); // tenant default untouched
  assert.deepEqual(sel.blockedExtensionScoped, ["s1"]); // blocked → restore_previous
  assert.equal(sel.skippedForPbx, false);
});

test("REQUIRED: mixed targets — only the whole-tenant explicit fallback lands at tenant level", () => {
  const sel = selectAdminFallbackTenantClass({
    tenantControlMode: "connect",
    candidates: [
      { scheduleId: "ext", extension: "205", fallbackMode: "explicit", fallbackClass: "moh9", priority: 100 },
      { scheduleId: "ten", extension: "", fallbackMode: "explicit", fallbackClass: "moh2", priority: 1 },
    ],
  });
  // The extension-scoped one is blocked even though it has higher priority; the
  // whole-tenant one wins the tenant-level class.
  assert.equal(sel.appliedClass, "moh2");
  assert.deepEqual(sel.blockedExtensionScoped, ["ext"]);
});

test("extension-scoped restore_previous is NOT flagged as blocked (only explicit is)", () => {
  const sel = selectAdminFallbackTenantClass({
    tenantControlMode: "connect",
    candidates: [{ scheduleId: "s1", extension: "101", fallbackMode: "restore_previous", fallbackClass: null, priority: 0 }],
  });
  assert.equal(sel.appliedClass, null);
  assert.deepEqual(sel.blockedExtensionScoped, []); // restore_previous, nothing to block
});
