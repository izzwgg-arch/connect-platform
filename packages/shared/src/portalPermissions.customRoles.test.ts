/**
 * Tests for custom roles permission integration.
 *
 * These tests verify the shared permission layer behavior that custom roles
 * depend on: additive union, grantability bounds, and backward compatibility.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  PORTAL_PERMISSION_KEYS,
  PROTECTED_PLATFORM_ADMIN_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  expandLegacyPortalPermissions,
  isPortalPermissionKey,
  type PortalPermissionKey,
} from "./portalPermissions";

// ── can_view_admin_roles ──────────────────────────────────────────────────────

test("can_view_admin_roles is a valid PortalPermissionKey", () => {
  assert.ok(isPortalPermissionKey("can_view_admin_roles"));
});

test("can_view_admin_roles is in PORTAL_PERMISSION_KEYS", () => {
  assert.ok((PORTAL_PERMISSION_KEYS as string[]).includes("can_view_admin_roles"));
});

test("TENANT_ADMIN default permissions include can_view_admin_roles", () => {
  assert.ok(
    DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN.includes("can_view_admin_roles"),
    "TENANT_ADMIN should inherit can_view_admin_roles via can_view_admin expansion",
  );
});

test("SUPER_ADMIN default permissions include can_view_admin_roles", () => {
  assert.ok(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN.includes("can_view_admin_roles"));
});

test("END_USER default permissions do NOT include can_view_admin_roles", () => {
  assert.ok(!DEFAULT_ROLE_PERMISSIONS.END_USER.includes("can_view_admin_roles"));
});

// ── can_view_admin expansion ──────────────────────────────────────────────────

test("can_view_admin legacy expansion includes can_view_admin_roles", () => {
  const expanded = expandLegacyPortalPermissions(["can_view_admin"]);
  assert.ok(
    expanded.includes("can_view_admin_roles"),
    "can_view_admin should expand to include can_view_admin_roles",
  );
});

// ── PROTECTED_PLATFORM_ADMIN_PERMISSIONS does not include can_view_admin_roles ─

test("can_view_admin_roles is NOT in PROTECTED_PLATFORM_ADMIN_PERMISSIONS", () => {
  assert.ok(
    !(PROTECTED_PLATFORM_ADMIN_PERMISSIONS as string[]).includes("can_view_admin_roles"),
    "TENANT_ADMIN should be able to grant can_view_admin_roles (it is not platform-protected)",
  );
});

// ── Additive-union semantics (pure logic, no DB) ──────────────────────────────

test("union of base perms and custom role perms is additive", () => {
  const base: PortalPermissionKey[] = ["can_view_workspace_overview", "can_view_workspace_voicemail"];
  const custom: PortalPermissionKey[] = ["can_view_pbx_extensions", "can_view_workspace_overview"];
  const union = [...new Set([...base, ...custom])] as PortalPermissionKey[];
  assert.ok(union.includes("can_view_workspace_overview"), "shared key present once");
  assert.ok(union.includes("can_view_workspace_voicemail"), "base-only key present");
  assert.ok(union.includes("can_view_pbx_extensions"), "custom-only key present");
  assert.equal(union.filter((p) => p === "can_view_workspace_overview").length, 1, "no duplicates");
});

test("custom role with empty permissions leaves base perms unchanged", () => {
  const base: PortalPermissionKey[] = ["can_view_workspace_overview"];
  const custom: PortalPermissionKey[] = [];
  const union = [...new Set([...base, ...custom])];
  assert.deepEqual(union, base);
});

// ── Grantability: TENANT_ADMIN cannot grant protected keys ───────────────────

test("PROTECTED_PLATFORM_ADMIN_PERMISSIONS are all valid PortalPermissionKeys", () => {
  for (const key of PROTECTED_PLATFORM_ADMIN_PERMISSIONS) {
    assert.ok(isPortalPermissionKey(key), `${key} should be a valid PortalPermissionKey`);
  }
});

test("SUPER_ADMIN-only keys are not in TENANT_ADMIN defaults", () => {
  const superOnlyKeys: PortalPermissionKey[] = [
    "can_switch_tenants",
    "can_sync_voip_ms_numbers",
    "can_manage_deploys",
    "can_view_admin_deploy_center",
  ];
  for (const key of superOnlyKeys) {
    assert.ok(
      !DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN.includes(key),
      `${key} should not be grantable by TENANT_ADMIN`,
    );
  }
});

// ── isPortalPermissionKey type guard ─────────────────────────────────────────

test("isPortalPermissionKey rejects unknown strings", () => {
  assert.equal(isPortalPermissionKey("can_do_something_fake"), false);
  assert.equal(isPortalPermissionKey(""), false);
  assert.equal(isPortalPermissionKey("SUPER_ADMIN"), false);
});

test("isPortalPermissionKey accepts all PORTAL_PERMISSION_KEYS", () => {
  for (const key of PORTAL_PERMISSION_KEYS) {
    assert.ok(isPortalPermissionKey(key), `${key} should pass isPortalPermissionKey`);
  }
});

// ── Backward compatibility: existing roles unaffected ────────────────────────

test("END_USER default permissions are unchanged (backward compat check)", () => {
  assert.ok(DEFAULT_ROLE_PERMISSIONS.END_USER.includes("can_view_workspace_overview"));
  assert.ok(DEFAULT_ROLE_PERMISSIONS.END_USER.includes("can_view_workspace_voicemail"));
  assert.ok(DEFAULT_ROLE_PERMISSIONS.END_USER.includes("can_view_workspace_call_history"));
  assert.ok(!DEFAULT_ROLE_PERMISSIONS.END_USER.includes("can_view_admin_users"));
  assert.ok(!DEFAULT_ROLE_PERMISSIONS.END_USER.includes("can_manage_tenant_settings"));
});

test("TENANT_ADMIN default permissions include tenant-admin actions", () => {
  assert.ok(DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN.includes("can_view_admin_users"));
  assert.ok(DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN.includes("can_manage_tenant_settings"));
  assert.ok(DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN.includes("can_view_admin_roles"));
  assert.ok(!DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN.includes("can_switch_tenants"));
});
