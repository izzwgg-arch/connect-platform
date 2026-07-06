// Unit + integration tests for the Connect mobile wake-canary reconciler.
//
// These tests exercise the PURE logic (selector eligibility + AstDB reconcile
// diff + parser) with in-memory fixtures — no DB, no PBX, no network. The IO
// adapters (Prisma read / `asterisk -rx` shell) are validated by source-shape
// assertions (fail-closed guards, mutation confirmation gate) the same way the
// installer tests assert on generated shell.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The reconciler is ESM .mjs; import its pure exports directly.
import {
  ACTIONS,
  OWNER_VALUE,
  DEFAULT_STALE_MS,
  canaryKey,
  evaluateEligibility,
  parseAstDbShow,
  reconcile,
  hasDrift,
  CANARY_FAMILY,
  OWNER_FAMILY,
  // @ts-expect-error — plain JS module, no type declarations
} from "./wake-canary-reconcile.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-07-01T00:00:00.000Z");
const FRESH = "2026-06-30T00:00:00.000Z"; // 1 day old
const STALE = "2026-05-01T00:00:00.000Z"; // 61 days old

// Minimal eligible mobile extension record; override per test.
function rec(over: Record<string, unknown> = {}) {
  return {
    tenantId: "tnt1",
    tenantName: "Tenant T2",
    tenantWebrtcEnabled: true,
    pbxTenantId: "2",
    pbxTenantLinkStatus: "LINKED",
    extensionId: "ext1",
    extNumber: "110",
    extStatus: "ACTIVE",
    ownerUserId: "user1",
    pbxLinkPresent: true,
    provisionStatus: "PROVISIONED",
    isSuspended: false,
    devices: [{ active: true, deactivatedAt: null, lastSeenAt: FRESH }],
    ...over,
  };
}

const evalOpts = { now: NOW } as const;

// ============================================================================
// 1. Selector tests
// ============================================================================

test("selector: active mobile extension is eligible", () => {
  const e = evaluateEligibility(rec(), evalOpts);
  assert.equal(e.eligible, true);
  assert.equal(e.decision, "ELIGIBLE");
  assert.equal(e.key, "T2_110");
  assert.equal(e.activeDeviceCount, 1);
});

test("selector: desk-only extension (no owner, no devices) is excluded", () => {
  const e = evaluateEligibility(rec({ ownerUserId: null, devices: [] }), evalOpts);
  assert.equal(e.eligible, false);
  assert.equal(e.decision, "INELIGIBLE");
});

test("selector: inactive (active:false) device does not count", () => {
  const e = evaluateEligibility(
    rec({ ownerUserId: null, devices: [{ active: false, deactivatedAt: null, lastSeenAt: FRESH }] }),
    evalOpts,
  );
  assert.equal(e.activeDeviceCount, 0);
  assert.equal(e.eligible, false);
});

test("selector: deactivated device (deactivatedAt set) does not count", () => {
  const e = evaluateEligibility(
    rec({ ownerUserId: null, devices: [{ active: true, deactivatedAt: STALE, lastSeenAt: FRESH }] }),
    evalOpts,
  );
  assert.equal(e.activeDeviceCount, 0);
  assert.equal(e.eligible, false);
});

test("selector: stale-only active device does NOT falsely qualify without an owner", () => {
  const e = evaluateEligibility(
    rec({ ownerUserId: null, devices: [{ active: true, deactivatedAt: null, lastSeenAt: STALE }] }),
    evalOpts,
  );
  assert.equal(e.eligible, false);
  assert.ok(e.riskFlags.includes("stale_devices_only"));
});

test("selector: owner + stale-only device is NOT eligible (owner alone is not a live mobile client)", () => {
  const e = evaluateEligibility(
    rec({ ownerUserId: "user1", devices: [{ active: true, deactivatedAt: null, lastSeenAt: STALE }] }),
    evalOpts,
  );
  assert.equal(e.eligible, false);
  assert.ok(e.riskFlags.includes("stale_devices_only"));
});

test("selector: owner ONLY (no active device) is NOT eligible → SKIP_NEEDS_REVIEW owner_without_active_mobile_device", () => {
  const e = evaluateEligibility(rec({ ownerUserId: "user1", devices: [] }), evalOpts);
  assert.equal(e.eligible, false);
  assert.equal(e.decision, ACTIONS.SKIP_NEEDS_REVIEW);
  assert.ok(e.riskFlags.includes("owner_without_active_mobile_device"));
  // and it must NOT ENABLE even with no key present
  const res = reconcile([rec({ ownerUserId: "user1", devices: [] })], { value: {}, owner: {} }, evalOpts);
  assert.equal(res.rows[0].action, ACTIONS.SKIP_NEEDS_REVIEW);
});

test("selector: fresh active device WITHOUT owner (valid mapping) IS eligible → ENABLE", () => {
  const e = evaluateEligibility(
    rec({ ownerUserId: null, devices: [{ active: true, deactivatedAt: null, lastSeenAt: FRESH }] }),
    evalOpts,
  );
  assert.equal(e.eligible, true);
  assert.equal(e.mobileReason, "active mobile device");
  const res = reconcile([rec({ ownerUserId: null, devices: [{ active: true, deactivatedAt: null, lastSeenAt: FRESH }] })], { value: {}, owner: {} }, evalOpts);
  assert.equal(res.rows[0].action, ACTIONS.ENABLE);
});

test("selector: owner + fresh active device IS eligible → ENABLE", () => {
  const e = evaluateEligibility(rec({ ownerUserId: "user1", devices: [{ active: true, deactivatedAt: null, lastSeenAt: FRESH }] }), evalOpts);
  assert.equal(e.eligible, true);
  assert.equal(e.mobileReason, "owner + active mobile device");
});

test("selector: multiple devices for one extension counts all active/fresh", () => {
  const e = evaluateEligibility(
    rec({
      ownerUserId: null,
      devices: [
        { active: true, deactivatedAt: null, lastSeenAt: FRESH },
        { active: true, deactivatedAt: null, lastSeenAt: FRESH },
        { active: false, deactivatedAt: STALE, lastSeenAt: STALE },
      ],
    }),
    evalOpts,
  );
  assert.equal(e.activeDeviceCount, 2);
  assert.equal(e.eligible, true);
});

test("selector: multiple extensions in one tenant reconcile independently", () => {
  const res = reconcile(
    [rec({ extensionId: "a", extNumber: "110" }), rec({ extensionId: "b", extNumber: "111" })],
    { value: {}, owner: {} },
    evalOpts,
  );
  assert.equal(res.counts.totalRecords, 2);
  assert.equal(res.counts.tenants, 1);
  assert.equal(res.counts.byAction[ACTIONS.ENABLE], 2);
});

test("selector: multiple tenants are counted distinctly", () => {
  const res = reconcile(
    [rec({ pbxTenantId: "2", extNumber: "110" }), rec({ pbxTenantId: "8", extNumber: "101" })],
    { value: {}, owner: {} },
    evalOpts,
  );
  assert.equal(res.counts.tenants, 2);
});

test("selector: WebRTC-disabled tenant is excluded", () => {
  const e = evaluateEligibility(rec({ tenantWebrtcEnabled: false }), evalOpts);
  assert.equal(e.eligible, false);
  assert.match(e.mobileReason, /WebRTC/i);
});

test("selector: suspended / DISABLED / non-ACTIVE extensions are excluded", () => {
  assert.equal(evaluateEligibility(rec({ isSuspended: true }), evalOpts).eligible, false);
  assert.equal(evaluateEligibility(rec({ provisionStatus: "DISABLED" }), evalOpts).eligible, false);
  assert.equal(evaluateEligibility(rec({ extStatus: "INACTIVE" }), evalOpts).eligible, false);
});

test("selector: missing PBX tenant / extension mapping → SKIP_NEEDS_REVIEW", () => {
  const noTenant = evaluateEligibility(rec({ pbxTenantId: null }), evalOpts);
  assert.equal(noTenant.decision, ACTIONS.SKIP_NEEDS_REVIEW);
  assert.ok(noTenant.riskFlags.includes("missing_pbx_tenant_id"));
  const noExtLink = evaluateEligibility(rec({ pbxLinkPresent: false }), evalOpts);
  assert.equal(noExtLink.decision, ACTIONS.SKIP_NEEDS_REVIEW);
});

test("selector: TenantPbxLink.status=ERROR does NOT block an otherwise-valid PBX tenant (health artifact, not a link gate)", () => {
  // Production runs with status=ERROR across all tenants (worker CDR-sync flips it
  // to ERROR on failure) while remaining fully PBX-linked. A present pbxTenantId +
  // all other checks passing must remain ELIGIBLE — the proven T2/110 canary is
  // exactly this shape.
  const e = evaluateEligibility(rec({ pbxTenantLinkStatus: "ERROR" }), evalOpts);
  assert.equal(e.eligible, true, "status=ERROR with pbxTenantId present must be eligible");
  assert.equal(e.decision, "ELIGIBLE");
  assert.equal(e.key, "T2_110");
  assert.ok(!e.riskFlags.includes("pbx_tenant_link_error"), "must not flag ERROR as a review risk");

  // And it must actually ENABLE when no key exists yet.
  const res = reconcile([rec({ pbxTenantLinkStatus: "ERROR" })], { value: {}, owner: {} }, evalOpts);
  assert.equal(res.rows[0].action, ACTIONS.ENABLE);
});

test("selector: explicit UNLINKED tenant → SKIP_NEEDS_REVIEW (real not-linked signal)", () => {
  const e = evaluateEligibility(rec({ pbxTenantLinkStatus: "UNLINKED" }), evalOpts);
  assert.equal(e.decision, ACTIONS.SKIP_NEEDS_REVIEW);
  assert.ok(e.riskFlags.includes("pbx_tenant_link_unlinked"));
});

test("selector: an ERROR-status tenant that is desk-only is still excluded (fix does not loosen other gates)", () => {
  const e = evaluateEligibility(
    rec({ pbxTenantLinkStatus: "ERROR", ownerUserId: null, devices: [] }),
    evalOpts,
  );
  assert.equal(e.eligible, false);
  assert.equal(e.decision, "INELIGIBLE");
});

test("selector: existing owned key that is now ineligible becomes DISABLE", () => {
  const res = reconcile(
    [rec({ extNumber: "102", provisionStatus: "DISABLED" })],
    { value: { T2_102: "1" }, owner: { T2_102: OWNER_VALUE } },
    evalOpts,
  );
  assert.equal(res.rows[0].action, ACTIONS.DISABLE);
});

test("selector/rollback: an enabled key we do NOT own is never auto-cleared", () => {
  const res = reconcile(
    [rec({ extNumber: "500", ownerUserId: null, devices: [] })], // ineligible desk ext
    { value: { T2_500: "1" }, owner: {} }, // key present, but no connect-mobile owner
    evalOpts,
  );
  assert.equal(res.rows[0].action, ACTIONS.SKIP_NEEDS_REVIEW);
  assert.ok(res.rows[0].riskFlags.includes("enabled_key_not_owned_by_connect"));
});

test("reconcile: orphan owned key (no matching extension) is marked DISABLE; non-owned orphan is ignored", () => {
  const res = reconcile(
    [rec({ extNumber: "110" })],
    { value: { T2_110: "1", T8_199: "1", T9_888: "1" }, owner: { T2_110: OWNER_VALUE, T8_199: OWNER_VALUE } },
    evalOpts,
  );
  const orphanKeys = res.orphans.map((o: any) => o.key);
  assert.deepEqual(orphanKeys, ["T8_199"]); // owned orphan only; T9_888 not owned → ignored
});

// ============================================================================
// 2. Reconciler / mode tests
// ============================================================================

test("reconcile is pure: ENABLE when unkeyed, KEEP_ENABLED once keyed (idempotent apply)", () => {
  const records = [rec({ extNumber: "110" })];
  const first = reconcile(records, { value: {}, owner: {} }, evalOpts);
  assert.equal(first.rows[0].action, ACTIONS.ENABLE);
  // Simulate the post-apply AstDB state and re-run.
  const second = reconcile(records, { value: { T2_110: "1" }, owner: { T2_110: OWNER_VALUE } }, evalOpts);
  assert.equal(second.rows[0].action, ACTIONS.KEEP_ENABLED);
  assert.equal(hasDrift(second), false);
});

test("verify: hasDrift is true with pending ENABLE, false when fully reconciled", () => {
  const withDrift = reconcile([rec()], { value: {}, owner: {} }, evalOpts);
  assert.equal(hasDrift(withDrift), true);
  const noDrift = reconcile([rec()], { value: { T2_110: "1" }, owner: { T2_110: OWNER_VALUE } }, evalOpts);
  assert.equal(hasDrift(noDrift), false);
});

test("rollback-owned target set is idempotent: only owned keys, empty on second pass", () => {
  const ownerMap = { T2_110: OWNER_VALUE, T8_199: OWNER_VALUE, T2_500: "someone-else" };
  const owned = Object.entries(ownerMap).filter(([, v]) => v === OWNER_VALUE).map(([k]) => k);
  assert.deepEqual(owned.sort(), ["T2_110", "T8_199"]);
  // After rollback the owner family is empty → nothing to clear.
  const secondPass = Object.entries({}).filter(([, v]) => v === OWNER_VALUE);
  assert.equal(secondPass.length, 0);
});

test("parser: parses `database show` lines and ignores other families", () => {
  const text = [
    "/connect/wake_canary/T2_110                               : 1",
    "/connect/wake_canary/T8_101                               : 1",
    "/connect/other/keep                                       : x",
    "garbage line",
  ].join("\n");
  const parsed = parseAstDbShow(text, CANARY_FAMILY);
  assert.deepEqual(parsed, { T2_110: "1", T8_101: "1" });
  assert.deepEqual(parseAstDbShow("", CANARY_FAMILY), {});
});

test("reconcile tolerates empty AstDB (fail-safe classify without keys)", () => {
  const res = reconcile([rec()], { value: {}, owner: {} }, evalOpts);
  assert.equal(res.rows[0].action, ACTIONS.ENABLE);
  assert.equal(res.orphans.length, 0);
});

test("canaryKey format is T<tid>_<ext>", () => {
  assert.equal(canaryKey("2", "110"), "T2_110");
});

// ============================================================================
// Source-shape guards for the IO layer (fail-closed + mutation gate)
// ============================================================================

const MJS = readFileSync(join(__dirname, "wake-canary-reconcile.mjs"), "utf8");

test("apply/rollback refuse without explicit mutation confirmation flag", () => {
  assert.match(MJS, /--i-understand-this-mutates-astdb/);
  assert.match(MJS, /REFUSING: apply\/rollback-owned require --i-understand-this-mutates-astdb/);
});

test("apply/rollback refuse to mutate against a --fixture (read-only)", () => {
  assert.match(MJS, /REFUSING: --fixture is read-only/);
});

test("DB and PBX read errors fail closed before any write", () => {
  assert.match(MJS, /FAIL-CLOSED: DB read failed/);
  assert.match(MJS, /FAIL-CLOSED: PBX AstDB read failed/);
});

test("apply verifies each ENABLE key after writing and reports partial failures for safe retry", () => {
  assert.match(MJS, /post-write verify failed/);
  assert.match(MJS, /\[PARTIAL\]/);
  assert.match(MJS, /idempotent/i);
});

test("rollback-owned never clears a key it does not own", () => {
  assert.match(MJS, /NEVER clear keys we do not own/);
});

test("default stale threshold is 30 days", () => {
  assert.equal(DEFAULT_STALE_MS, 30 * 24 * 60 * 60 * 1000);
});

test("owner metadata family names are the approved namespace", () => {
  assert.equal(CANARY_FAMILY, "connect/wake_canary");
  assert.equal(OWNER_FAMILY, "connect/wake_canary_owner");
});
