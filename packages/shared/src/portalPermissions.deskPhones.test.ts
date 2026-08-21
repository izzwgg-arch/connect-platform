import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_PERMISSION_KEYS, DEFAULT_ROLE_PERMISSIONS, PORTAL_PERMISSION_KEYS,
} from "./portalPermissions";

/**
 * ⛔⛔ The desk-phone keys must NOT be in a default bucket — not even TENANT_ADMIN.
 * A key that quietly reached every tenant admin would mean anybody who can log in to
 * a customer account can erase the phones on their colleagues' desks. This is the
 * same discipline can_use_amazon_polly and the remote-support pair already use, and
 * it is checked rather than trusted because a bucket is one edit away from changing.
 */

test("both desk-phone keys exist", () => {
  for (const key of ["can_setup_desk_phones", "can_authorize_phone_reset"] as const) {
    assert.ok((ACTION_PERMISSION_KEYS as readonly string[]).includes(key), `${key} missing`);
    assert.ok((PORTAL_PERMISSION_KEYS as readonly string[]).includes(key));
  }
});

test("neither key is granted by default to an ordinary user", () => {
  for (const key of ["can_setup_desk_phones", "can_authorize_phone_reset"]) {
    assert.ok(!DEFAULT_ROLE_PERMISSIONS.END_USER.includes(key as any), `END_USER must not hold ${key}`);
  }
});

test("neither key is granted by default to a tenant admin", () => {
  for (const key of ["can_setup_desk_phones", "can_authorize_phone_reset"]) {
    assert.ok(
      !DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN.includes(key as any),
      `TENANT_ADMIN must not hold ${key} by default - it would mean anybody who can log in can wipe a desk phone`,
    );
  }
});

test("Loopcom staff still get them automatically, so no snapshot migration is needed", () => {
  for (const key of ["can_setup_desk_phones", "can_authorize_phone_reset"]) {
    assert.ok(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN.includes(key as any));
  }
});

test("running the wizard and erasing a phone are two separate grants", () => {
  // ⛔ One combined key would mean "let them set up phones" silently included
  // "let them wipe phones", which is not a trade anyone would knowingly make.
  assert.notEqual("can_setup_desk_phones", "can_authorize_phone_reset");
  const both = new Set([...ACTION_PERMISSION_KEYS]);
  assert.equal(both.has("can_setup_desk_phones") && both.has("can_authorize_phone_reset"), true);
});
