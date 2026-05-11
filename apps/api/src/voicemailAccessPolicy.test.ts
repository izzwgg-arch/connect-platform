import test from "node:test";
import assert from "node:assert/strict";
import {
  isTenantLevelVoicemailAdministrator,
  voicemailForceOwnedExtensionScope,
  voicemailNonSuperAdminUsesOwnedMailboxesOnly,
  userMayAccessVoicemailRowAfterTenantMatch,
} from "./voicemailAccessPolicy";

test("isTenantLevelVoicemailAdministrator: TENANT_ADMIN and ADMIN only", () => {
  assert.equal(isTenantLevelVoicemailAdministrator("TENANT_ADMIN"), true);
  assert.equal(isTenantLevelVoicemailAdministrator("ADMIN"), true);
  assert.equal(isTenantLevelVoicemailAdministrator("MANAGER"), false);
  assert.equal(isTenantLevelVoicemailAdministrator("USER"), false);
  assert.equal(isTenantLevelVoicemailAdministrator(undefined), false);
});

test("voicemailForceOwnedExtensionScope: defaults true when env unset", () => {
  delete process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE;
  assert.equal(voicemailForceOwnedExtensionScope(), true);
});

test("voicemailForceOwnedExtensionScope: false only when explicitly false", () => {
  process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE = "false";
  assert.equal(voicemailForceOwnedExtensionScope(), false);
  delete process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE;
});

test("voicemailNonSuperAdminUsesOwnedMailboxesOnly: SUPER_ADMIN never owned-only mode", () => {
  delete process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE;
  assert.equal(voicemailNonSuperAdminUsesOwnedMailboxesOnly("TENANT_ADMIN", true), false);
  process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE = "false";
  assert.equal(voicemailNonSuperAdminUsesOwnedMailboxesOnly("TENANT_ADMIN", true), false);
  delete process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE;
});

test("voicemailNonSuperAdminUsesOwnedMailboxesOnly: USER always owned-only", () => {
  process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE = "false";
  assert.equal(voicemailNonSuperAdminUsesOwnedMailboxesOnly("USER", false), true);
  delete process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE;
  assert.equal(voicemailNonSuperAdminUsesOwnedMailboxesOnly("USER", false), true);
});

test("voicemailNonSuperAdminUsesOwnedMailboxesOnly: TENANT_ADMIN follows env (containment default)", () => {
  delete process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE;
  assert.equal(voicemailNonSuperAdminUsesOwnedMailboxesOnly("TENANT_ADMIN", false), true);
  process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE = "false";
  assert.equal(voicemailNonSuperAdminUsesOwnedMailboxesOnly("TENANT_ADMIN", false), false);
  delete process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE;
});

test("userMayAccessVoicemailRowAfterTenantMatch: TENANT_ADMIN cannot use other extension under containment", () => {
  delete process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE;
  assert.equal(
    userMayAccessVoicemailRowAfterTenantMatch({
      vmExtension: "200",
      userRole: "TENANT_ADMIN",
      ownedExtensions: ["100"],
    }),
    false,
  );
});

test("userMayAccessVoicemailRowAfterTenantMatch: TENANT_ADMIN any extension when legacy env", () => {
  process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE = "false";
  assert.equal(
    userMayAccessVoicemailRowAfterTenantMatch({
      vmExtension: "200",
      userRole: "TENANT_ADMIN",
      ownedExtensions: ["100"],
    }),
    true,
  );
  delete process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE;
});

test("userMayAccessVoicemailRowAfterTenantMatch: USER same-tenant other extension denied", () => {
  process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE = "false";
  assert.equal(
    userMayAccessVoicemailRowAfterTenantMatch({
      vmExtension: "200",
      userRole: "USER",
      ownedExtensions: ["100"],
    }),
    false,
  );
  delete process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE;
});

test("userMayAccessVoicemailRowAfterTenantMatch: USER owned extension allowed", () => {
  assert.equal(
    userMayAccessVoicemailRowAfterTenantMatch({
      vmExtension: "100",
      userRole: "USER",
      ownedExtensions: ["100", "101"],
    }),
    true,
  );
});

test("userMayAccessVoicemailRowAfterTenantMatch: playback-style deny when mailbox not owned (containment)", () => {
  delete process.env.VOICEMAIL_FORCE_OWNED_EXTENSION_SCOPE;
  assert.equal(
    userMayAccessVoicemailRowAfterTenantMatch({
      vmExtension: "999",
      userRole: "ADMIN",
      ownedExtensions: ["100"],
    }),
    false,
  );
});
