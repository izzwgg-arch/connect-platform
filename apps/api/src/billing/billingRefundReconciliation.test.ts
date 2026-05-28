/**
 * Tests for reconcileBillingTransactionFromPortalRefund (Phase 1).
 *
 * These are static/structural tests — they verify the shape and logic of the
 * reconciliation function without a live database, following the existing
 * pattern in solaBillingWebhookIdempotency.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "solaBillingPayments.ts"), "utf8");

test("reconcileBillingTransactionFromPortalRefund is exported", () => {
  assert.match(src, /export async function reconcileBillingTransactionFromPortalRefund/);
});

test("reconciliation checks for APPROVED status via processorTransactionId guard", () => {
  assert.match(src, /PROCESSOR_REF_MISSING/);
  assert.match(src, /TRANSACTION_NOT_FOUND/);
});

test("reconciliation stores processorRefundRef and rawResponseSafeJson.refund", () => {
  assert.match(src, /processorRefundRef: params\.processorRefundRef/);
  assert.match(src, /manual_sola_portal_reconciliation/);
  assert.match(src, /refundVerifiedAt/);
  assert.match(src, /originalProcessorTransactionId/);
});

test("reconciliation logs payment.refunded event", () => {
  assert.match(src, /type: "payment\.refunded"/);
  assert.match(src, /source: "manual_sola_portal_reconciliation"/);
});

test("reconciliation queues refund email via queueRefundEmailOnce", () => {
  assert.match(src, /queueRefundEmailOnce/);
  assert.match(src, /isDuplicateChargeRefund: true/);
});

test("reconciliation is idempotent — already_reconciled branch exists", () => {
  assert.match(src, /already_reconciled/);
  assert.match(src, /isAlreadyReconciled/);
});

test("reconciliation supports dryRun mode", () => {
  assert.match(src, /dryRun/);
  assert.match(src, /action: "dry_run"/);
});

test("reconciliation does NOT call refundTransaction (no processor call)", () => {
  // Ensure no call to adapter.refundTransaction in the reconcile function body.
  const reconcileFn = src.slice(src.indexOf("reconcileBillingTransactionFromPortalRefund"));
  // The function body should not contain refundTransaction call
  assert.doesNotMatch(reconcileFn, /adapter\.refundTransaction/);
});
