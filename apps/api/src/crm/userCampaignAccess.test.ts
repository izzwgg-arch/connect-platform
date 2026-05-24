import test from "node:test";
import assert from "node:assert/strict";
import {
  crmCampaignScopeForUser,
  isCrmCampaignIdAllowed,
  resolveCrmCampaignAccess,
} from "./userCampaignAccess";

const allowedId = "campaign-allowed";
const blockedId = "campaign-blocked";

test("isCrmCampaignIdAllowed: platform admin bypasses restriction list", () => {
  assert.equal(isCrmCampaignIdAllowed(blockedId, [allowedId], "TENANT_ADMIN"), true);
  assert.equal(isCrmCampaignIdAllowed(blockedId, [allowedId], "ADMIN"), true);
  assert.equal(isCrmCampaignIdAllowed(blockedId, [allowedId], "SUPER_ADMIN"), true);
});

test("isCrmCampaignIdAllowed: no assignment rows allows any campaign", () => {
  assert.equal(isCrmCampaignIdAllowed(allowedId, null, "EXTENSION_USER"), true);
  assert.equal(isCrmCampaignIdAllowed(blockedId, null, "USER"), true);
});

test("isCrmCampaignIdAllowed: restricted user only sees assigned ids", () => {
  const restriction = [allowedId];
  assert.equal(isCrmCampaignIdAllowed(allowedId, restriction, "EXTENSION_USER"), true);
  assert.equal(isCrmCampaignIdAllowed(blockedId, restriction, "EXTENSION_USER"), false);
});

test("resolveCrmCampaignAccess: cross-tenant / missing campaign is not_found", () => {
  assert.equal(resolveCrmCampaignAccess(false, blockedId, [allowedId], "EXTENSION_USER"), "not_found");
});

test("resolveCrmCampaignAccess: restricted user cannot access unassigned campaign", () => {
  assert.equal(
    resolveCrmCampaignAccess(true, blockedId, [allowedId], "EXTENSION_USER"),
    "forbidden",
  );
});

test("resolveCrmCampaignAccess: restricted user can access assigned campaign", () => {
  assert.equal(
    resolveCrmCampaignAccess(true, allowedId, [allowedId], "EXTENSION_USER"),
    "ok",
  );
});

test("resolveCrmCampaignAccess: no assignment rows allows any tenant campaign", () => {
  assert.equal(resolveCrmCampaignAccess(true, blockedId, null, "EXTENSION_USER"), "ok");
});

test("resolveCrmCampaignAccess: platform admin bypasses assignment rows", () => {
  assert.equal(
    resolveCrmCampaignAccess(true, blockedId, [allowedId], "TENANT_ADMIN"),
    "ok",
  );
});

test("crmCampaignScopeForUser returns empty scope for admin roles", async () => {
  const scope = await crmCampaignScopeForUser("tenant-1", "user-1", "TENANT_ADMIN");
  assert.deepEqual(scope, {});
});
