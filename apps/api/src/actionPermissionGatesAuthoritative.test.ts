import test from "node:test";
import assert from "node:assert/strict";
import { computeAuthoritativePortalPermissions } from "./crm/portalCrmPermissions";
import type { PortalPermissionKey } from "@connect/shared";

/**
 * End-to-end intent for the wired action permissions: when a non-SUPER_ADMIN
 * user has a custom role, the resolver is authoritative — they get EXACTLY the
 * keys the role grants and nothing else. This is what makes each editor toggle
 * actually control the matching server gate (OFF = the key is absent = 403).
 */

const sorted = (a: readonly string[]) => [...a].sort();

const WIRED_ACTION_KEYS: PortalPermissionKey[] = [
  "can_manage_integrations",
  "can_manage_tenant_settings",
  "can_publish_ivr_routing",
  "can_override_ivr_routing",
  "can_publish_moh",
  "can_override_moh",
  "can_download_recordings",
  "can_delete_voicemail",
  "can_manage_contacts",
  "can_view_live_calls",
];

test("each wired action key is granted authoritatively and in isolation", () => {
  for (const key of WIRED_ACTION_KEYS) {
    const out = computeAuthoritativePortalPermissions("TENANT_ADMIN", [key]);
    assert.ok(out, `${key}: should resolve authoritatively for a custom-role user`);
    assert.deepEqual(out, [key], `${key}: resolves to exactly itself, no bucket leakage`);
  }
});

test("a custom role WITHOUT a given action key does not grant it (toggle OFF = denied)", () => {
  // Role grants integrations but NOT contacts/voicemail-delete/etc.
  const out = computeAuthoritativePortalPermissions("END_USER", [
    "can_manage_integrations",
  ] as PortalPermissionKey[]);
  assert.ok(out);
  for (const key of WIRED_ACTION_KEYS.filter((k) => k !== "can_manage_integrations")) {
    assert.ok(!out!.includes(key), `${key} must be absent when the role does not grant it`);
  }
});

test("a custom role granting a publish key does not imply the override key (and vice versa)", () => {
  const publishOnly = computeAuthoritativePortalPermissions("TENANT_ADMIN", [
    "can_publish_ivr_routing",
  ] as PortalPermissionKey[]);
  assert.ok(publishOnly);
  assert.ok(!publishOnly!.includes("can_override_ivr_routing" as PortalPermissionKey));

  const overrideOnly = computeAuthoritativePortalPermissions("TENANT_ADMIN", [
    "can_override_moh",
  ] as PortalPermissionKey[]);
  assert.ok(overrideOnly);
  assert.ok(!overrideOnly!.includes("can_publish_moh" as PortalPermissionKey));
});

test("SUPER_ADMIN keeps full access (never made authoritative by a custom role)", () => {
  assert.equal(
    computeAuthoritativePortalPermissions("SUPER_ADMIN", ["can_manage_contacts"] as PortalPermissionKey[]),
    null,
  );
});
