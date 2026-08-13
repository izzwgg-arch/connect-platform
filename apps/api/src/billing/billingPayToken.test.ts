import { test } from "node:test";
import assert from "node:assert/strict";

process.env.BILLING_PAY_TOKEN_SECRET ||= "test-secret-for-pay-tokens";

import {
  createBillingInvoicePayToken,
  createBillingMultiPayToken,
  verifyBillingInvoicePayToken,
  verifyBillingMultiPayToken,
} from "./billingPayToken";

test("multi token round-trips tenant + every invoice id", () => {
  const token = createBillingMultiPayToken("tenant-1", ["inv-a", "inv-b", "inv-c"]);
  const parsed = verifyBillingMultiPayToken(token);
  assert.ok(parsed);
  assert.equal(parsed!.tenantId, "tenant-1");
  assert.deepEqual(parsed!.invoiceIds, ["inv-a", "inv-b", "inv-c"]);
  assert.ok(parsed!.expiresAt > Date.now());
});

test("duplicate and blank ids are dropped at mint time", () => {
  const token = createBillingMultiPayToken("t", ["inv-a", "inv-a", "", "inv-b"]);
  const parsed = verifyBillingMultiPayToken(token);
  assert.deepEqual(parsed!.invoiceIds, ["inv-a", "inv-b"]);
});

test("a combined link over zero invoices cannot be minted", () => {
  assert.throws(() => createBillingMultiPayToken("t", []));
  assert.throws(() => createBillingMultiPayToken("t", ["", "  "].map((s) => s.trim()).filter(Boolean)));
});

test("an expired multi token verifies to null", () => {
  const token = createBillingMultiPayToken("t", ["inv-a"], -1000);
  assert.equal(verifyBillingMultiPayToken(token), null);
});

test("a tampered multi token verifies to null", () => {
  const token = createBillingMultiPayToken("t", ["inv-a"]);
  const [payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ t: "t", ii: ["inv-a", "inv-EVIL"], e: Date.now() + 60_000 }), "utf8").toString("base64url");
  assert.equal(verifyBillingMultiPayToken(`${forged}.${sig}`), null);
  assert.equal(verifyBillingMultiPayToken(`${payload}.AAAA${sig.slice(4)}`), null);
});

test("the two token shapes never accept each other", () => {
  // A single-invoice token must not open the combined page, and a combined
  // token must not open the single page — each verifier demands its own shape.
  const single = createBillingInvoicePayToken("inv-a", "tenant-1");
  const multi = createBillingMultiPayToken("tenant-1", ["inv-a", "inv-b"]);
  assert.equal(verifyBillingMultiPayToken(single), null);
  assert.equal(verifyBillingInvoicePayToken(multi), null);
  // And both still accept themselves.
  assert.ok(verifyBillingInvoicePayToken(single));
  assert.ok(verifyBillingMultiPayToken(multi));
});
