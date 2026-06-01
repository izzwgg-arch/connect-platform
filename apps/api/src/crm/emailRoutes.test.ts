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
  resolveImplicitSenderConnectionOrder,
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

test("canManageTenantSender: platform MANAGER cannot manage", () => {
  assert.equal(canManageTenantSender({ role: "MANAGER" }), false);
});

test("canManageTenantSender: CRM ADMIN can manage", () => {
  assert.equal(canManageTenantSender({ role: "USER" }, "ADMIN"), true);
});

test("canManageTenantSender: CRM MANAGER cannot manage", () => {
  assert.equal(canManageTenantSender({ role: "USER" }, "MANAGER"), false);
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

// ── resolveImplicitSenderConnectionOrder ─────────────────────────────────────

test("resolveImplicitSenderConnectionOrder: tenant default wins over user sender", () => {
  const selected = resolveImplicitSenderConnectionOrder([
    { id: "user", scope: "USER", userId: "agent-1" },
    { id: "tenant-default", scope: "TENANT", isDefaultForTenant: true },
  ], "agent-1");
  assert.equal(selected?.id, "tenant-default");
});

test("resolveImplicitSenderConnectionOrder: lone tenant wins over user sender", () => {
  const selected = resolveImplicitSenderConnectionOrder([
    { id: "user", scope: "USER", userId: "agent-1" },
    { id: "tenant-lone", scope: "TENANT", isDefaultForTenant: false },
  ], "agent-1");
  assert.equal(selected?.id, "tenant-lone");
});

test("resolveImplicitSenderConnectionOrder: ambiguous tenants fall back to user sender", () => {
  const selected = resolveImplicitSenderConnectionOrder([
    { id: "user", scope: "USER", userId: "agent-1" },
    { id: "tenant-a", scope: "TENANT", isDefaultForTenant: false },
    { id: "tenant-b", scope: "TENANT", isDefaultForTenant: false },
  ], "agent-1");
  assert.equal(selected?.id, "user");
});
