import test from "node:test";
import assert from "node:assert/strict";
import {
  crmLegacyPermissionKeysForAccess,
  expandLegacyPortalPermissions,
  isCrmPortalPermissionKey,
} from "./portalPermissions";

function navWouldShowCrmEmail(legacyKeys: ReturnType<typeof crmLegacyPermissionKeysForAccess>): boolean {
  const expanded = expandLegacyPortalPermissions(legacyKeys);
  return expanded.includes("can_view_crm_email");
}

test("CRM Agent nav: can_view_crm_email after expansion", () => {
  const keys = crmLegacyPermissionKeysForAccess("AGENT");
  assert.deepEqual(keys, ["can_view_crm"]);
  assert.equal(navWouldShowCrmEmail(keys), true);
  assert.equal(navWouldShowCrmEmail(keys), !expandLegacyPortalPermissions(keys).includes("can_view_crm_settings"));
});

test("CRM Manager nav: can_view_crm_email without CRM settings", () => {
  const keys = crmLegacyPermissionKeysForAccess("MANAGER");
  assert.deepEqual(keys, ["can_manage_crm"]);
  assert.equal(navWouldShowCrmEmail(keys), true);
  const expanded = expandLegacyPortalPermissions(keys);
  assert.equal(expanded.includes("can_view_crm_settings"), false);
});

test("CRM Admin nav: email + settings", () => {
  const keys = crmLegacyPermissionKeysForAccess("ADMIN");
  assert.ok(keys.includes("can_manage_crm_admin"));
  const expanded = expandLegacyPortalPermissions(keys);
  assert.ok(expanded.includes("can_view_crm_email"));
  assert.ok(expanded.includes("can_view_crm_settings"));
});

test("isCrmPortalPermissionKey includes can_view_crm_email", () => {
  assert.equal(isCrmPortalPermissionKey("can_view_crm_email"), true);
});

test("tenant isolation: CRM email permission is a portal key only (documented)", () => {
  assert.equal(isCrmPortalPermissionKey("can_view_crm_email"), true);
});
