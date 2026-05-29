/**
 * Unit tests for pure helper functions exported from emailRoutes.ts.
 *
 * These tests cover:
 *  - hasReadonlyScope: detects gmail.readonly presence in OAuth scope list
 *  - canManageTenantSender: permission guard for shared-mailbox management
 *  - replyTrackingStatus: derives human-readable tracking state from connection fields
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GMAIL_READONLY_SCOPE,
  hasReadonlyScope,
  canManageTenantSender,
  replyTrackingStatus,
} from "./crmEmailHelpers.js";

// ── hasReadonlyScope ───────────────────────────────────────────────────────────

test("hasReadonlyScope: true when gmail.readonly scope present", () => {
  assert.equal(
    hasReadonlyScope(["https://www.googleapis.com/auth/gmail.send", GMAIL_READONLY_SCOPE]),
    true,
  );
});

test("hasReadonlyScope: false when only send scope present", () => {
  assert.equal(
    hasReadonlyScope(["https://www.googleapis.com/auth/gmail.send"]),
    false,
  );
});

test("hasReadonlyScope: false on empty array", () => {
  assert.equal(hasReadonlyScope([]), false);
});

test("hasReadonlyScope: exact match only — prefix not sufficient", () => {
  // A scope that starts with the same prefix but is different should not match.
  assert.equal(hasReadonlyScope(["https://www.googleapis.com/auth/gmail"]), false);
});

// ── canManageTenantSender ──────────────────────────────────────────────────────

test("canManageTenantSender: ADMIN can manage", () => {
  assert.equal(canManageTenantSender({ role: "ADMIN" }), true);
});

test("canManageTenantSender: SUPER_ADMIN can manage", () => {
  assert.equal(canManageTenantSender({ role: "SUPER_ADMIN" }), true);
});

test("canManageTenantSender: MANAGER can manage", () => {
  assert.equal(canManageTenantSender({ role: "MANAGER" }), true);
});

test("canManageTenantSender: TENANT_ADMIN can manage", () => {
  assert.equal(canManageTenantSender({ role: "TENANT_ADMIN" }), true);
});

test("canManageTenantSender: AGENT cannot manage", () => {
  assert.equal(canManageTenantSender({ role: "AGENT" }), false);
});

test("canManageTenantSender: EXTENSION_USER cannot manage", () => {
  assert.equal(canManageTenantSender({ role: "EXTENSION_USER" }), false);
});

test("canManageTenantSender: undefined role cannot manage", () => {
  assert.equal(canManageTenantSender({}), false);
});

test("canManageTenantSender: role comparison is case-insensitive", () => {
  assert.equal(canManageTenantSender({ role: "admin" }), true);
  assert.equal(canManageTenantSender({ role: "Admin" }), true);
});

// ── replyTrackingStatus ────────────────────────────────────────────────────────

test("replyTrackingStatus: healthy when tracking on and scope present", () => {
  assert.equal(
    replyTrackingStatus({ replyTrackingEnabled: true, scopes: [GMAIL_READONLY_SCOPE] }),
    "healthy",
  );
});

test("replyTrackingStatus: no_scope when scope not granted regardless of flag", () => {
  assert.equal(
    replyTrackingStatus({ replyTrackingEnabled: false, scopes: ["https://www.googleapis.com/auth/gmail.send"] }),
    "no_scope",
  );
});

test("replyTrackingStatus: no_scope when flag is true but scope missing (token drift)", () => {
  assert.equal(
    replyTrackingStatus({ replyTrackingEnabled: true, scopes: [] }),
    "no_scope",
  );
});

test("replyTrackingStatus: disabled when scope present but tracking off (backfill edge-case)", () => {
  assert.equal(
    replyTrackingStatus({ replyTrackingEnabled: false, scopes: [GMAIL_READONLY_SCOPE] }),
    "disabled",
  );
});

test("replyTrackingStatus: no_scope on empty scopes with tracking off", () => {
  assert.equal(
    replyTrackingStatus({ replyTrackingEnabled: false, scopes: [] }),
    "no_scope",
  );
});
