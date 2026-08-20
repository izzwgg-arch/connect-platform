import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_PERMISSION_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
  PORTAL_PERMISSION_KEYS,
  SIDEBAR_ITEMS,
  isPortalPermissionKey,
} from "./portalPermissions";

/**
 * The conference feature's permission wiring — the queues template applied.
 *
 * Same regression these tests guard against there: a nav item whose key a
 * bucket holds while the page's own key is missing is a visible door that
 * doesn't open, and it reads as a bug rather than a permission.
 */

const CONFERENCE_ACTION_KEYS = ["can_view_conferences", "can_manage_conferences"] as const;
const CONFERENCE_NAV_KEY = "can_view_pbx_conference";

test("both conference action keys exist and are real permission keys", () => {
  for (const k of CONFERENCE_ACTION_KEYS) {
    assert.ok((ACTION_PERMISSION_KEYS as readonly string[]).includes(k), `${k} missing from ACTION_PERMISSION_KEYS`);
    assert.ok(isPortalPermissionKey(k), `${k} is not a valid PortalPermissionKey`);
    assert.ok((PORTAL_PERMISSION_KEYS as readonly string[]).includes(k));
  }
});

test("the Conference nav item is registered so it appears in the regular-role editor", () => {
  // /admin/permissions renders SIDEBAR_SECTIONS × SIDEBAR_ITEMS, so a missing
  // entry here means the built-in roles have no toggle at all.
  const item = SIDEBAR_ITEMS.find((i) => i.permission === CONFERENCE_NAV_KEY);
  assert.ok(item, "no SIDEBAR_ITEMS entry grants can_view_pbx_conference");
  assert.equal(item!.href, "/conference");
  assert.equal(item!.section, "pbx");
});

test("TENANT_ADMIN gets the Conference page and management; END_USER gets neither by default", () => {
  const tenantAdmin = new Set(DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN as readonly string[]);
  const endUser = new Set(DEFAULT_ROLE_PERMISSIONS.END_USER as readonly string[]);
  for (const k of CONFERENCE_ACTION_KEYS) {
    assert.ok(tenantAdmin.has(k), `TENANT_ADMIN should hold ${k}`);
    assert.ok(!endUser.has(k), `END_USER must NOT hold ${k} by default`);
  }
});

test("⛔ nav visibility and page access agree — no visible door that doesn't open", () => {
  for (const bucket of ["END_USER", "TENANT_ADMIN", "SUPER_ADMIN"] as const) {
    const perms = new Set(DEFAULT_ROLE_PERMISSIONS[bucket] as readonly string[]);
    if (perms.has(CONFERENCE_NAV_KEY)) {
      assert.ok(
        perms.has("can_view_conferences"),
        `${bucket} can see the Conference nav item but cannot open the page`,
      );
    }
  }
});

test("the nav key rides can_view_conferences, so the two switch on together", () => {
  // The expansion is what keeps a TENANT_ADMIN's sidebar and page in step —
  // if can_view_conferences ever stops implying the nav key, the page becomes
  // reachable only by typed URL for the default buckets.
  const tenantAdmin = new Set(DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN as readonly string[]);
  assert.ok(tenantAdmin.has(CONFERENCE_NAV_KEY), "TENANT_ADMIN should see the Conference nav item");
  assert.ok(tenantAdmin.has("can_view_section_pbx"), "the PBX section must open for TENANT_ADMIN");
});

test("SUPER_ADMIN holds every conference key without a migration", () => {
  const superAdmin = new Set(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN as readonly string[]);
  for (const k of [...CONFERENCE_ACTION_KEYS, CONFERENCE_NAV_KEY]) {
    assert.ok(superAdmin.has(k), `SUPER_ADMIN should hold ${k}`);
  }
});

test("managing rooms is its own key, separate from knowing the dial-in details", () => {
  // Managing writes to the PBX by panel replay. Someone who shares the room
  // number and PIN all day should not automatically be able to rebuild rooms.
  const tenantAdmin = new Set(DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN as readonly string[]);
  const withoutManage = new Set(tenantAdmin);
  withoutManage.delete("can_manage_conferences");
  assert.ok(withoutManage.has("can_view_conferences"), "revoking manage must leave the page view intact");
  assert.ok(!(DEFAULT_ROLE_PERMISSIONS.END_USER as readonly string[]).includes("can_manage_conferences"));
});
