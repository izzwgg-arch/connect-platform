import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSmsDedupeKey,
  canSendSmsByPortalPermission,
  isEligibleSharedSmsInboxParticipant,
  isExtensionWithoutOwnerFallback,
  isSharedTenantSmsInbox,
  resolveSmsInboxScope,
} from "./smsInbox";
import type { PortalPermissionKey } from "./portalPermissions";

test("resolveSmsInboxScope: tenant-wide when no user and no extension owner", () => {
  assert.equal(resolveSmsInboxScope({ assignedUserId: null, extensionOwnerUserId: null }), "");
  assert.equal(resolveSmsInboxScope({}), "");
});

test("resolveSmsInboxScope: user assignment is personal", () => {
  assert.equal(resolveSmsInboxScope({ assignedUserId: "u1" }), "u1");
});

test("resolveSmsInboxScope: extension owner is personal", () => {
  assert.equal(resolveSmsInboxScope({ assignedExtensionId: "e1", extensionOwnerUserId: "u2" }), "u2");
});

test("resolveSmsInboxScope: extension without owner falls back to tenant-wide", () => {
  assert.equal(resolveSmsInboxScope({ assignedExtensionId: "e1", extensionOwnerUserId: null }), "");
  assert.ok(isExtensionWithoutOwnerFallback({ assignedExtensionId: "e1", extensionOwnerUserId: null }));
});

test("buildSmsDedupeKey keeps empty inboxScope for shared tenant inbox", () => {
  assert.equal(
    buildSmsDedupeKey("t1", "+15551234567", "+15559876543", ""),
    "sms:t1:+15551234567:+15559876543:",
  );
});

test("shared inbox participant eligibility respects SMS/chat permissions", () => {
  const sendOnly: PortalPermissionKey[] = ["can_send_sms"];
  const viewOnly: PortalPermissionKey[] = ["can_view_tenant_chats"];
  const neither: PortalPermissionKey[] = ["can_view_chat"];
  assert.ok(isEligibleSharedSmsInboxParticipant(sendOnly));
  assert.ok(isEligibleSharedSmsInboxParticipant(viewOnly));
  assert.ok(!isEligibleSharedSmsInboxParticipant(neither));
});

test("canSendSmsByPortalPermission", () => {
  assert.ok(canSendSmsByPortalPermission(["can_send_sms"]));
  assert.ok(!canSendSmsByPortalPermission(["can_view_tenant_chats"]));
});

test("isSharedTenantSmsInbox", () => {
  assert.ok(isSharedTenantSmsInbox(""));
  assert.ok(!isSharedTenantSmsInbox("u1"));
});
