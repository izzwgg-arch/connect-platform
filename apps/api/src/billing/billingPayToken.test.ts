/**
 * Public pay token: signed, expiring, tenant+invoice bound.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createBillingInvoicePayToken,
  verifyBillingInvoicePayToken,
  BILLING_PAY_TOKEN_TTL_MS,
} from "./billingPayToken";

const ORIGINAL = process.env.BILLING_PAY_TOKEN_SECRET;

test.before(() => {
  process.env.BILLING_PAY_TOKEN_SECRET = "a".repeat(64);
});

test.after(() => {
  if (ORIGINAL === undefined) delete process.env.BILLING_PAY_TOKEN_SECRET;
  else process.env.BILLING_PAY_TOKEN_SECRET = ORIGINAL;
});

test("valid token round-trips invoice and tenant", () => {
  const token = createBillingInvoicePayToken("inv_1", "tenant_a");
  const parsed = verifyBillingInvoicePayToken(token);
  assert.ok(parsed);
  assert.equal(parsed!.invoiceId, "inv_1");
  assert.equal(parsed!.tenantId, "tenant_a");
});

test("tampered token is rejected", () => {
  const token = createBillingInvoicePayToken("inv_1", "tenant_a");
  const bad = token.slice(0, -2) + "xx";
  assert.equal(verifyBillingInvoicePayToken(bad), null);
});

test("wrong tenant in payload cannot be verified with different secret", () => {
  const token = createBillingInvoicePayToken("inv_1", "tenant_a");
  process.env.BILLING_PAY_TOKEN_SECRET = "b".repeat(64);
  assert.equal(verifyBillingInvoicePayToken(token), null);
  process.env.BILLING_PAY_TOKEN_SECRET = "a".repeat(64);
});

test("expired token is rejected", () => {
  const token = createBillingInvoicePayToken("inv_1", "tenant_a", -1000);
  assert.equal(verifyBillingInvoicePayToken(token), null);
  void BILLING_PAY_TOKEN_TTL_MS;
});
