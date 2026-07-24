import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DELIVERY_PERMISSIONS,
  hasDeliveryPermission,
  resolveDeliveryPermissions,
  isPlatformAdminRole,
} from "./permissions";

test("platform admins get the full delivery key set", () => {
  const set = resolveDeliveryPermissions("SUPER_ADMIN", null);
  for (const key of Object.values(DELIVERY_PERMISSIONS)) {
    assert.ok(set.has(key), `admin missing ${key}`);
  }
  assert.equal(isPlatformAdminRole("TENANT_ADMIN"), true);
  assert.equal(isPlatformAdminRole("END_USER"), false);
});

test("dispatcher can dispatch but not manage config", () => {
  assert.equal(hasDeliveryPermission("USER", "DISPATCHER", DELIVERY_PERMISSIONS.DISPATCH), true);
  assert.equal(hasDeliveryPermission("USER", "DISPATCHER", DELIVERY_PERMISSIONS.MANAGE_CONFIG), false);
});

test("driver can view only", () => {
  const set = resolveDeliveryPermissions("USER", "DRIVER");
  assert.deepEqual([...set], [DELIVERY_PERMISSIONS.VIEW]);
});

test("store manager manages drivers; reporting user does not dispatch", () => {
  assert.equal(hasDeliveryPermission("USER", "STORE_MANAGER", DELIVERY_PERMISSIONS.MANAGE_DRIVERS), true);
  assert.equal(hasDeliveryPermission("USER", "REPORTING", DELIVERY_PERMISSIONS.DISPATCH), false);
  assert.equal(hasDeliveryPermission("USER", "REPORTING", DELIVERY_PERMISSIONS.VIEW_REPORTS), true);
});

test("unknown/absent delivery role grants nothing (non-admin)", () => {
  assert.equal(resolveDeliveryPermissions("USER", null).size, 0);
  assert.equal(resolveDeliveryPermissions("USER", undefined).size, 0);
});
