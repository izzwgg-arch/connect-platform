import test from "node:test";
import assert from "node:assert/strict";
import { computeAuthoritativePortalPermissions } from "./portalCrmPermissions";
import type { PortalPermissionKey } from "@connect/shared";

/**
 * Proves the authoritative custom-role decision used by
 * resolvePortalPermissionsWithCrmUserAccess:
 *
 *  1. A non-SUPER_ADMIN user with custom-role permissions resolves to EXACTLY
 *     those permissions — the built-in bucket leaks nothing extra (OFF = hidden).
 *  2. A user with NO custom roles falls back to the normal bucket logic (null).
 *  3. SUPER_ADMIN is never weakened by a custom role (always null -> keeps full set).
 */

const sorted = (a: readonly string[]) => [...a].sort();

test("authoritative: END_USER with a custom role resolves to EXACTLY the role's permissions", () => {
  const customPerms = [
    "can_view_section_workspace",
    "can_view_workspace_overview",
  ] as PortalPermissionKey[];
  const out = computeAuthoritativePortalPermissions("END_USER", customPerms);
  assert.ok(out, "should be authoritative");
  assert.deepEqual(sorted(out!), sorted(customPerms));
  assert.ok(!out!.includes("can_view_admin_users" as PortalPermissionKey), "no bucket admin leakage");
});

test("authoritative: deduplicates the role's permissions", () => {
  const out = computeAuthoritativePortalPermissions("TENANT_ADMIN", [
    "can_view_section_crm",
    "can_view_section_crm",
    "can_view_crm_dashboard",
  ] as PortalPermissionKey[]);
  assert.deepEqual(sorted(out!), ["can_view_crm_dashboard", "can_view_section_crm"]);
});

test("no custom roles: not authoritative (falls back to bucket)", () => {
  assert.equal(computeAuthoritativePortalPermissions("END_USER", []), null);
  assert.equal(computeAuthoritativePortalPermissions("TENANT_ADMIN", []), null);
});

test("SUPER_ADMIN is never made authoritative (never weakened)", () => {
  const out = computeAuthoritativePortalPermissions("SUPER_ADMIN", [
    "can_view_section_workspace",
  ] as PortalPermissionKey[]);
  assert.equal(out, null, "SUPER_ADMIN must fall through and keep its full bucket");
});
