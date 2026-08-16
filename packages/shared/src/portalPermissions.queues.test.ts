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
 * The queue feature's permission wiring.
 *
 * The mistake these tests exist to prevent is the one that was actually made:
 * the Queues nav item hung off `can_view_calls`, which END_USER holds, while
 * the pages and routes required TENANT_ADMIN-level keys. That produces a
 * visible menu item that denies you when you click it — the worst of both, and
 * it looks like a bug rather than a permission.
 */

const QUEUE_ACTION_KEYS = ["can_view_queues", "can_view_queue_wallboard", "can_view_queue_reports"] as const;
const QUEUE_NAV_KEY = "can_view_pbx_queues";

test("the three queue action keys exist and are real permission keys", () => {
  for (const k of QUEUE_ACTION_KEYS) {
    assert.ok((ACTION_PERMISSION_KEYS as readonly string[]).includes(k), `${k} missing from ACTION_PERMISSION_KEYS`);
    assert.ok(isPortalPermissionKey(k), `${k} is not a valid PortalPermissionKey`);
    assert.ok((PORTAL_PERMISSION_KEYS as readonly string[]).includes(k));
  }
});

test("the Queues nav item is registered so it appears in the regular-role editor", () => {
  // /admin/permissions renders SIDEBAR_SECTIONS × SIDEBAR_ITEMS, so a missing
  // entry here means the built-in roles have no toggle at all.
  const item = SIDEBAR_ITEMS.find((i) => i.permission === QUEUE_NAV_KEY);
  assert.ok(item, "no SIDEBAR_ITEMS entry grants can_view_pbx_queues");
  assert.equal(item!.href, "/queues");
  assert.equal(item!.section, "pbx");
});

test("TENANT_ADMIN gets the queue screens; END_USER gets none of them", () => {
  const tenantAdmin = new Set(DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN as readonly string[]);
  const endUser = new Set(DEFAULT_ROLE_PERMISSIONS.END_USER as readonly string[]);
  for (const k of QUEUE_ACTION_KEYS) {
    assert.ok(tenantAdmin.has(k), `TENANT_ADMIN should hold ${k}`);
    assert.ok(!endUser.has(k), `END_USER must NOT hold ${k} by default`);
  }
});

test("⛔ nav visibility and page access agree — no visible door that doesn't open", () => {
  // This is the regression. If a bucket can SEE the Queues item it must also
  // hold at least the live-status key, or clicking it lands on "access denied".
  for (const bucket of ["END_USER", "TENANT_ADMIN", "SUPER_ADMIN"] as const) {
    const perms = new Set(DEFAULT_ROLE_PERMISSIONS[bucket] as readonly string[]);
    if (perms.has(QUEUE_NAV_KEY)) {
      assert.ok(
        perms.has("can_view_queues"),
        `${bucket} can see the Queues nav item but cannot open the page`,
      );
    }
  }
});

test("SUPER_ADMIN holds every queue key without a migration", () => {
  // The SUPER_ADMIN bucket force-adds every key, which is why adding a new
  // permission needs no snapshot backfill.
  const superAdmin = new Set(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN as readonly string[]);
  for (const k of [...QUEUE_ACTION_KEYS, QUEUE_NAV_KEY]) {
    assert.ok(superAdmin.has(k), `SUPER_ADMIN should hold ${k}`);
  }
});

test("the reports key is separable from the live board", () => {
  // Reports rank named people. Granting someone the live queue view must not
  // drag per-agent history along with it, or the split is decorative.
  assert.notEqual("can_view_queues", "can_view_queue_reports");
  const tenantAdmin = new Set(DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN as readonly string[]);
  const withoutReports = new Set(tenantAdmin);
  withoutReports.delete("can_view_queue_reports");
  assert.ok(withoutReports.has("can_view_queues"), "revoking reports must leave the live board intact");
});
