import test from "node:test";
import assert from "node:assert/strict";
import {
  crmLegacyPermissionKeysForAccess,
  expandLegacyPortalPermissions,
  isCrmPortalPermissionKey,
} from "./portalPermissions";

test("isCrmPortalPermissionKey matches CRM section and page keys", () => {
  assert.equal(isCrmPortalPermissionKey("can_view_section_crm"), true);
  assert.equal(isCrmPortalPermissionKey("can_view_crm_dashboard"), true);
  assert.equal(isCrmPortalPermissionKey("can_view_crm_settings"), true);
  assert.equal(isCrmPortalPermissionKey("can_view_workspace_overview"), false);
});

test("crmLegacyPermissionKeysForAccess grants manage for admin/manager", () => {
  assert.deepEqual(crmLegacyPermissionKeysForAccess("ADMIN"), ["can_manage_crm"]);
  assert.deepEqual(crmLegacyPermissionKeysForAccess("manager"), ["can_manage_crm"]);
});

test("crmLegacyPermissionKeysForAccess grants view for agents", () => {
  assert.deepEqual(crmLegacyPermissionKeysForAccess("AGENT"), ["can_view_crm"]);
  assert.deepEqual(crmLegacyPermissionKeysForAccess(null), ["can_view_crm"]);
});

test("can_manage_crm expands to CRM section keys", () => {
  const expanded = expandLegacyPortalPermissions(["can_manage_crm"]);
  assert.ok(expanded.includes("can_view_section_crm"));
  assert.ok(expanded.every(isCrmPortalPermissionKey));
});
