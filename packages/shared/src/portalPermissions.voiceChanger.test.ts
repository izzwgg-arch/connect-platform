import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_PERMISSION_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
  PORTAL_PERMISSION_KEYS,
  isPortalPermissionKey,
} from "./portalPermissions";

/**
 * The voice changer's permission wiring.
 *
 * `can_use_voice_changer` lets someone upload a recording of a real person
 * speaking and have it come back in a different voice. Two reasons it is never
 * handed out by a default bucket, and both matter:
 *
 *   1. Money. It is billed per MINUTE of audio against Connect's own ElevenLabs
 *      account — not per character like the greeting generator — so a single
 *      long upload costs more than a day of ordinary greeting-making.
 *   2. Judgement. Re-voicing a recording of a person is something to hand to
 *      named people deliberately, not to switch on for everyone who happens to
 *      be able to manage prompts.
 *
 * ⛔ If a future change adds this key to TENANT_ADMIN "so admins can use it
 * too", every tenant admin on the platform silently gains a metered feature
 * that spends our money. That is the regression this file exists to make loud.
 *
 * It follows `can_use_amazon_polly` exactly: absent from both default buckets,
 * granted one custom role at a time, and reaching SUPER_ADMIN only because that
 * bucket contains every key — which is why no snapshot migration is needed.
 */

const KEY = "can_use_voice_changer";

test("the key exists and is a real permission key", () => {
  assert.ok((ACTION_PERMISSION_KEYS as readonly string[]).includes(KEY), `${KEY} missing from ACTION_PERMISSION_KEYS`);
  assert.ok(isPortalPermissionKey(KEY), `${KEY} is not a valid PortalPermissionKey`);
  assert.ok((PORTAL_PERMISSION_KEYS as readonly string[]).includes(KEY));
});

test("⛔ it is in NEITHER default bucket — not even TENANT_ADMIN", () => {
  for (const bucket of ["END_USER", "TENANT_ADMIN"] as const) {
    const keys = (DEFAULT_ROLE_PERMISSIONS as Record<string, readonly string[]>)[bucket] ?? [];
    assert.ok(
      !keys.includes(KEY),
      `${KEY} must not be in the ${bucket} bucket — it is metered per minute against our own account`,
    );
  }
});

test("SUPER_ADMIN still receives it, so no permission-snapshot migration is needed", () => {
  const keys = (DEFAULT_ROLE_PERMISSIONS as Record<string, readonly string[]>).SUPER_ADMIN ?? [];
  assert.ok(keys.includes(KEY), "the platform owner must be able to use it without granting themselves anything");
});

test("it sits in ACTION_PERMISSION_KEYS, which is what makes it appear in the custom-role editor", () => {
  // The built-in-role editor (/admin/permissions) renders sidebar items only;
  // the custom-role editor (/admin/roles/[id]) renders ACTION_PERMISSION_KEYS
  // as well. Being in this list is precisely what makes the key grantable to a
  // named person, which is the whole delivery mechanism for this feature.
  assert.ok((ACTION_PERMISSION_KEYS as readonly string[]).includes(KEY));
});

test("it is a separate key from the Polly one — the two features are independent", () => {
  // Sharing a key would mean granting the voice changer also grants a second
  // paid provider, and revoking one would silently revoke the other.
  assert.notEqual(KEY, "can_use_amazon_polly");
  assert.ok((ACTION_PERMISSION_KEYS as readonly string[]).includes("can_use_amazon_polly"));
});
