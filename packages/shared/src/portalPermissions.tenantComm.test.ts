import test from "node:test";
import assert from "node:assert/strict";
import { ACTION_PERMISSION_KEYS, PORTAL_PERMISSION_KEYS, isPortalPermissionKey } from "./portalPermissions";

const NEW_KEYS = [
  "can_view_tenant_call_history",
  "can_view_tenant_voicemails",
  "can_view_tenant_chats",
  "can_view_tenant_call_recordings",
];

test("tenant communications keys are valid portal permission keys", () => {
  for (const key of NEW_KEYS) {
    assert.ok(isPortalPermissionKey(key), `${key} should be a valid PortalPermissionKey`);
    assert.ok((PORTAL_PERMISSION_KEYS as string[]).includes(key), `${key} should be in PORTAL_PERMISSION_KEYS`);
    assert.ok((ACTION_PERMISSION_KEYS as readonly string[]).includes(key), `${key} should be in ACTION_PERMISSION_KEYS`);
  }
});
