/**
 * Tests for admin add-card via iFields SUT (saveAdminCardWithSut).
 *
 * Five cases:
 *   1. xSut missing/too short → validation error (code 400)
 *   2. valid xSut → calls adapter.saveCardWithSut with that token
 *   3. declined response → 402 card_save_failed, storeMethod never called
 *   4. approved response → calls storeMethod + logEvent, returns masked card info;
 *      xSut must NOT appear in logEvent metadata (PCI rule)
 *   5. auth gate: only SUPER_ADMIN may use the route
 */

import test from "node:test";
import assert from "node:assert/strict";
import { saveAdminCardWithSut, type AdminCardSaveDeps } from "./adminCardSave";
import { canAccessPlatformAdminBillingRoutes } from "./billingAuth";
import type { CardknoxTransactionResponse } from "@connect/integrations";

// ── helpers ──────────────────────────────────────────────────────────────────

function approvedResponse(overrides: Partial<CardknoxTransactionResponse> = {}): CardknoxTransactionResponse {
  return {
    approved: true,
    status: "APPROVED" as any,
    xToken: "tok_good",
    xMaskedCardNumber: "XXXX4242",
    xCardType: "Visa",
    xExp: "1228",
    safePayload: {},
    ...overrides,
  };
}

function declinedResponse(): CardknoxTransactionResponse {
  return { approved: false, status: "DECLINED" as any, xResult: "D", xError: "Declined", safePayload: {} };
}

function stubDeps(overrides: Partial<AdminCardSaveDeps> = {}): AdminCardSaveDeps {
  return {
    findTenant: async (id) => ({ id }),
    getAdapter: async () => ({ saveCardWithSut: async () => approvedResponse() }),
    storeMethod: async () => ({ id: "pm_1", brand: "Visa", last4: "4242", expMonth: "12", expYear: "28", isDefault: false }),
    logEvent: async () => {},
    ...overrides,
  };
}

// ── 1. xSut missing / too short ──────────────────────────────────────────────

test("xSut missing returns sola_token_too_short (code 400)", async () => {
  const result = await saveAdminCardWithSut("tenant-1", { xSut: "" }, "admin-1", stubDeps());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 400);
    assert.equal(result.error, "sola_token_too_short");
  }
});

test("xSut shorter than 8 chars returns sola_token_too_short (code 400)", async () => {
  const result = await saveAdminCardWithSut("tenant-1", { xSut: "short" }, "admin-1", stubDeps());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 400);
    assert.equal(result.error, "sola_token_too_short");
  }
});

// ── 2. valid xSut is forwarded to adapter.saveCardWithSut ────────────────────

test("valid xSut calls adapter.saveCardWithSut with the correct token", async () => {
  // Use an object container so TypeScript control-flow analysis can track the assignment
  const captured: { input: { sut: string; cardholderName?: string; zip?: string } | null } = { input: null };

  const result = await saveAdminCardWithSut(
    "tenant-2",
    { xSut: "sut_valid_token_abc", cardholderName: "Jane Smith", billingZip: "10950" },
    "admin-2",
    stubDeps({
      getAdapter: async () => ({
        saveCardWithSut: async (input) => {
          captured.input = input;
          return approvedResponse();
        },
      }),
    }),
  );

  assert.ok(captured.input !== null, "saveCardWithSut was not called");
  assert.equal(captured.input.sut, "sut_valid_token_abc");
  assert.equal(captured.input.cardholderName, "Jane Smith");
  assert.equal(captured.input.zip, "10950");
  assert.equal(result.ok, true);
});

// ── 3. declined response → 402, storeMethod never called ─────────────────────

test("declined saveCardWithSut response returns 402 card_save_failed without storing", async () => {
  let storeCalled = false;

  const result = await saveAdminCardWithSut(
    "tenant-3",
    { xSut: "sut_declined_token" },
    "admin-3",
    stubDeps({
      getAdapter: async () => ({ saveCardWithSut: async () => declinedResponse() }),
      storeMethod: async () => { storeCalled = true; return { id: "x", brand: null, last4: null, expMonth: null, expYear: null, isDefault: false }; },
    }),
  );

  assert.equal(storeCalled, false, "storeMethod must not be called on decline");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 402);
    assert.equal(result.error, "card_save_failed");
  }
});

// ── 4. approved → storeMethod called, returns masked info; xSut not logged ───

test("approved response: storeMethod called, returns masked card info, xSut absent from log", async () => {
  let storeCalled = false;
  let loggedMetadata: Record<string, unknown> | undefined;

  const result = await saveAdminCardWithSut(
    "tenant-4",
    { xSut: "sut_approved_tokenXYZ", makeDefault: true },
    "admin-4",
    {
      findTenant: async (id) => ({ id }),
      getAdapter: async () => ({
        saveCardWithSut: async () => approvedResponse({ xCardType: "MC", xMaskedCardNumber: "XXXX1111", xExp: "0930" }),
      }),
      storeMethod: async (opts) => {
        storeCalled = true;
        assert.equal(opts.tenantId, "tenant-4");
        assert.equal(opts.makeDefault, true);
        return { id: "pm_42", brand: "MC", last4: "1111", expMonth: "09", expYear: "30", isDefault: true };
      },
      logEvent: async (opts) => {
        loggedMetadata = opts.metadata;
        assert.equal(opts.type, "payment_method.saved");
        assert.equal(opts.tenantId, "tenant-4");
      },
    },
  );

  assert.equal(storeCalled, true, "storeMethod was not called");
  assert.ok(loggedMetadata !== undefined, "logEvent was not called");

  // PCI guard: xSut must not appear in any logged metadata value
  const loggedStr = JSON.stringify(loggedMetadata);
  assert.ok(!loggedStr.includes("sut_approved_tokenXYZ"), "xSut must NOT appear in log metadata");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.id, "pm_42");
    assert.equal(result.brand, "MC");
    assert.equal(result.last4, "1111");
    assert.equal(result.expMonth, "09");
    assert.equal(result.expYear, "30");
    assert.equal(result.isDefault, true);
  }
});

// ── 5. route is SUPER_ADMIN only ─────────────────────────────────────────────

test("admin card save route requires SUPER_ADMIN (canAccessPlatformAdminBillingRoutes)", () => {
  assert.equal(canAccessPlatformAdminBillingRoutes("SUPER_ADMIN"), true);
  assert.equal(canAccessPlatformAdminBillingRoutes("TENANT_ADMIN"), false);
  assert.equal(canAccessPlatformAdminBillingRoutes("BILLING_ADMIN"), false);
  assert.equal(canAccessPlatformAdminBillingRoutes("ADMIN"), false);
  assert.equal(canAccessPlatformAdminBillingRoutes("BILLING"), false);
  assert.equal(canAccessPlatformAdminBillingRoutes(undefined), false);
});
