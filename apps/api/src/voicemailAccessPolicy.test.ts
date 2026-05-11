import test from "node:test";
import assert from "node:assert/strict";
import { isTenantLevelVoicemailAdministrator } from "./voicemailAccessPolicy";

test("isTenantLevelVoicemailAdministrator: TENANT_ADMIN and ADMIN only", () => {
  assert.equal(isTenantLevelVoicemailAdministrator("TENANT_ADMIN"), true);
  assert.equal(isTenantLevelVoicemailAdministrator("ADMIN"), true);
  assert.equal(isTenantLevelVoicemailAdministrator("MANAGER"), false);
  assert.equal(isTenantLevelVoicemailAdministrator("USER"), false);
  assert.equal(isTenantLevelVoicemailAdministrator(undefined), false);
});
