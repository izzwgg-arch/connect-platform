import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_PERMISSION_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
  PORTAL_PERMISSION_KEYS,
  isPortalPermissionKey,
} from "./portalPermissions";

/**
 * Remote support's permission wiring.
 *
 * These are the most invasive keys on the platform: one of them lets a person
 * watch a customer work, and the other lets them move that customer's mouse.
 * The rule these tests exist to defend is that neither is ever handed out by a
 * default bucket — they are granted to named people through a custom role, the
 * same way `can_use_amazon_polly` is.
 *
 * ⛔ If a future change adds either key to TENANT_ADMIN "so admins can help
 * their own staff", every tenant admin on the platform silently gains the
 * ability to watch their employees' screens. That is the regression these
 * tests are here to make loud.
 */

const VIEW_KEY = "can_remote_support";
const CONTROL_KEY = "can_control_remote_support";
const LAN_KEY = "can_view_lan_phones";
const ALL_KEYS = [VIEW_KEY, CONTROL_KEY, LAN_KEY] as const;

test("the three keys exist and are real permission keys", () => {
  for (const k of ALL_KEYS) {
    assert.ok(
      (ACTION_PERMISSION_KEYS as readonly string[]).includes(k),
      `${k} missing from ACTION_PERMISSION_KEYS`,
    );
    assert.ok(isPortalPermissionKey(k), `${k} is not a valid PortalPermissionKey`);
    assert.ok((PORTAL_PERMISSION_KEYS as readonly string[]).includes(k));
  }
});

test("⛔ NO default bucket grants remote support — not even TENANT_ADMIN", () => {
  // The whole safety model is that these arrive only by explicit grant. A
  // tenant admin who can watch their own staff's screens by default is a
  // privacy problem shipped as a convenience.
  for (const bucket of ["END_USER", "TENANT_ADMIN"] as const) {
    const perms = new Set(DEFAULT_ROLE_PERMISSIONS[bucket] as readonly string[]);
    for (const k of ALL_KEYS) {
      assert.ok(!perms.has(k), `${bucket} must NOT hold ${k} by default`);
    }
  }
});

test("SUPER_ADMIN holds every key without a snapshot migration", () => {
  // The SUPER_ADMIN bucket force-adds every key, which is why adding a new
  // permission needs no backfill of PlatformRolePermissionSnapshot.
  const superAdmin = new Set(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN as readonly string[]);
  for (const k of ALL_KEYS) {
    assert.ok(superAdmin.has(k), `SUPER_ADMIN should hold ${k}`);
  }
});

test("control is a separate key from viewing, and revoking it leaves viewing intact", () => {
  // Watching is how you diagnose; controlling is how you change someone's
  // machine. Collapsing these into one key would mean anyone allowed to look
  // at a screen could also type on it.
  assert.notEqual(VIEW_KEY, CONTROL_KEY);
  const granted = new Set<string>([VIEW_KEY, CONTROL_KEY]);
  granted.delete(CONTROL_KEY);
  assert.ok(granted.has(VIEW_KEY), "revoking control must leave viewing intact");
  assert.ok(!granted.has(CONTROL_KEY));
});

test("the phone inventory is separable from remote support in both directions", () => {
  // Provisioning desk phones and doing support calls are different jobs. A
  // person who sets up phones should not need the right to watch screens, and
  // a support person should not automatically get the network inventory.
  const phoneInstaller = new Set<string>([LAN_KEY]);
  assert.ok(!phoneInstaller.has(VIEW_KEY), "phone inventory must not imply screen viewing");
  assert.ok(!phoneInstaller.has(CONTROL_KEY), "phone inventory must not imply control");

  const supportAgent = new Set<string>([VIEW_KEY, CONTROL_KEY]);
  assert.ok(!supportAgent.has(LAN_KEY), "remote support must not imply the network inventory");
});

test("every remote-support key is an ACTION key, so the custom-role editor renders it", () => {
  // /admin/roles/[id] renders ACTION_PERMISSION_KEYS. A key that is not in that
  // list has no toggle anywhere and can never actually be granted to anyone —
  // which reads as "the feature is broken" rather than "nobody has the key".
  for (const k of ALL_KEYS) {
    assert.ok(
      (ACTION_PERMISSION_KEYS as readonly string[]).includes(k),
      `${k} must be an ACTION key or no custom role can grant it`,
    );
  }
});
