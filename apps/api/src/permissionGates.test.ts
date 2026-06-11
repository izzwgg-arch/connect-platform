import test from "node:test";
import assert from "node:assert/strict";
import { decideActionGate } from "./permissionGates";

/**
 * Proves the pure policy used by the action-permission gates wired across the
 * API (provider/settings writes, IVR/MOH publish+override, recording download,
 * voicemail delete, contacts, live calls).
 *
 * Patterns:
 *  - Additive-OR (admin actions): allow when the legacy role check passes OR the
 *    user effectively holds the key. Never narrows existing role access.
 *  - Owner carve-out (personal data): allow when the user owns the resource OR
 *    holds the key. Self-service is always preserved.
 *  - SUPER_ADMIN is always allowed.
 */

test("blocked when no condition is satisfied", () => {
  assert.equal(decideActionGate({}), false);
  assert.equal(
    decideActionGate({ isSuperAdmin: false, roleAllowed: false, isOwner: false, hasKey: false }),
    false,
  );
});

test("super admin is always allowed", () => {
  assert.equal(decideActionGate({ isSuperAdmin: true }), true);
  assert.equal(
    decideActionGate({ isSuperAdmin: true, roleAllowed: false, isOwner: false, hasKey: false }),
    true,
  );
});

test("additive-OR: legacy role check alone allows (zero regression for admins)", () => {
  assert.equal(decideActionGate({ roleAllowed: true, hasKey: false }), true);
});

test("additive-OR: holding the key alone allows (custom role grant)", () => {
  assert.equal(decideActionGate({ roleAllowed: false, hasKey: true }), true);
});

test("owner carve-out: owner alone allows even without the key", () => {
  assert.equal(decideActionGate({ isOwner: true, hasKey: false }), true);
});

test("authoritative gate (no role fallback): only the key allows", () => {
  // requirePortalActionPermission passes roleAllowed:false, so the key is the
  // sole non-owner, non-super path — exactly the contacts-style gate.
  assert.equal(decideActionGate({ roleAllowed: false, hasKey: false }), false);
  assert.equal(decideActionGate({ roleAllowed: false, hasKey: true }), true);
});

test("non-owner without the key is blocked (e.g. tenant-wide voicemail viewer deleting others)", () => {
  assert.equal(decideActionGate({ isSuperAdmin: false, isOwner: false, hasKey: false }), false);
});
