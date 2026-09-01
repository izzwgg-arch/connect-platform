import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNT_OWNER_PERMISSION_KEY,
  DEFAULT_ROLE_PERMISSIONS,
  PORTAL_PERMISSION_KEYS,
  PROTECTED_PLATFORM_ADMIN_PERMISSIONS,
  customRoleGrantsAccountOwner,
} from "@connect/shared";

/**
 * The account-owner custom-role toggle (Izzy, 2026-09-01): a role carrying
 * ACCOUNT_OWNER_PERMISSION_KEY resolves to the LIVE TENANT_ADMIN bucket plus
 * the role's own keys — owner of their account, never of the platform.
 *
 * The wiring lives in resolvePortalPermissionsUncached, which server tests
 * cannot import directly (server-adjacent deps), so the wiring guards read the
 * SOURCE — the defect this feature can regress into is a caller that skips the
 * owner branch, which a pure-function test passes straight through.
 */

const RESOLVER = join(__dirname, "crm", "portalCrmPermissions.ts");
const read = () => readFileSync(RESOLVER, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the owner key is a real portal permission key", () => {
  assert.ok((PORTAL_PERMISSION_KEYS as readonly string[]).includes(ACCOUNT_OWNER_PERMISSION_KEY));
});

test("the owner key sits in NO default bucket — it is granted one role at a time", () => {
  for (const [bucket, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    if (bucket === "SUPER_ADMIN") continue; // the all-keys bucket force-adds everything
    assert.ok(
      !(keys as readonly string[]).includes(ACCOUNT_OWNER_PERMISSION_KEY),
      `${bucket} must not carry owner status by default`,
    );
  }
});

test("the owner key is NOT platform-protected — a tenant owner may delegate ownership of their own account", () => {
  assert.ok(
    !(PROTECTED_PLATFORM_ADMIN_PERMISSIONS as readonly string[]).includes(ACCOUNT_OWNER_PERMISSION_KEY),
  );
});

test("customRoleGrantsAccountOwner is exact", () => {
  assert.equal(customRoleGrantsAccountOwner([]), false);
  assert.equal(customRoleGrantsAccountOwner(["can_view_workspace_chat"]), false);
  assert.equal(customRoleGrantsAccountOwner([ACCOUNT_OWNER_PERMISSION_KEY]), true);
  assert.equal(
    customRoleGrantsAccountOwner(["can_view_workspace_chat", ACCOUNT_OWNER_PERMISSION_KEY]),
    true,
  );
});

test("the resolver has the owner branch, and it resolves the TENANT_ADMIN bucket", () => {
  const src = stripComments(read());
  assert.match(src, /customRoleGrantsAccountOwner\(customPerms\)/, "the resolver must consult the owner key");
  assert.match(
    src,
    /customRoleGrantsAccountOwner\(customPerms\)[\s\S]{0,400}getEffectivePortalPermissionSetForJwtRole\("TENANT_ADMIN"\)/,
    "an owner role must resolve the LIVE TENANT_ADMIN bucket — never the holder's own bucket",
  );
});

test("the owner branch takes precedence over the authoritative-literal branch", () => {
  const src = stripComments(read());
  const ownerIdx = src.indexOf("customRoleGrantsAccountOwner(customPerms)");
  const authIdx = src.indexOf("computeAuthoritativePortalPermissions(bucket, customPerms)");
  assert.ok(ownerIdx > 0 && authIdx > 0);
  assert.ok(
    ownerIdx < authIdx,
    "the owner check must run BEFORE the authoritative-literal return, or an owner role collapses to its literal keys",
  );
});

test("the owner branch falls through to CRM gating instead of returning early", () => {
  const src = stripComments(read());
  // Inside the owner branch there must be no `return` before the closing else —
  // the whole point is falling through to the ordinary bucket path.
  const branch = src.slice(
    src.indexOf("if (customRoleGrantsAccountOwner(customPerms))"),
    src.indexOf("} else {", src.indexOf("if (customRoleGrantsAccountOwner(customPerms))")),
  );
  assert.ok(branch.length > 0, "owner branch must exist");
  assert.doesNotMatch(branch, /return /, "the owner branch must fall through, never return early");
});
