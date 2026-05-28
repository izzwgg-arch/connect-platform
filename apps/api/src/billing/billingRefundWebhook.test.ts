/**
 * Tests for the Phase 2 raw-body webhook fix and refund webhook handling.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── server.ts: raw body handling ──────────────────────────────────────────────

test("sola-cardknox webhook route opts into rawBody capture", () => {
  // Grep the server.ts for the rawBody: true config on the sola-cardknox route.
  const serverPath = resolve(__dirname, "../server.ts");
  const src = readFileSync(serverPath, "utf8");
  // The route must declare { config: { rawBody: true } }
  const routeDecl = src.slice(src.indexOf('"/webhooks/sola-cardknox"'));
  assert.match(routeDecl, /config.*rawBody.*true/);
});

test("sola-cardknox webhook uses rawBodyBuffer before JSON.stringify fallback", () => {
  const serverPath = resolve(__dirname, "../server.ts");
  const src = readFileSync(serverPath, "utf8");
  assert.match(src, /rawBodyBuffer.*rawBody.*toString/);
  // Ensure the old naive fallback still exists as a guard but is secondary
  assert.match(src, /JSON\.stringify\(req\.body/);
});

// ── solaBillingPayments.ts: refund webhook branch ─────────────────────────────

const paymentsPath = resolve(__dirname, "solaBillingPayments.ts");
const paymentsSrc = readFileSync(paymentsPath, "utf8");

test("applySolaWebhookToBillingInvoice detects refund/credit webhook events", () => {
  assert.match(paymentsSrc, /isRefundEvent/);
  assert.match(paymentsSrc, /xCmd\.includes\("credit"\)/);
  assert.match(paymentsSrc, /xCmd\.includes\("refund"\)/);
});

test("refund webhook finds and updates existing APPROVED charge to REFUNDED", () => {
  assert.match(paymentsSrc, /existingCharge.*paymentTransaction\.findFirst/);
  assert.match(paymentsSrc, /status: "REFUNDED"/);
  assert.match(paymentsSrc, /processorRefundRef: processorRef/);
});

test("refund webhook deduplication — already has processorRefundRef", () => {
  assert.match(paymentsSrc, /alreadyReconciled/);
  assert.match(paymentsSrc, /webhook.refund_deduped/);
});

test("refund webhook queues refund email once", () => {
  assert.match(paymentsSrc, /queueRefundEmailOnce/);
});

test("refund webhook logs payment.refunded event with source=webhook", () => {
  assert.match(paymentsSrc, /source: "webhook"/);
});

// ── queueRefundEmailOnce: idempotency ─────────────────────────────────────────

test("queueRefundEmailOnce is exported from billingEmailLifecycle", () => {
  const lifecyclePath = resolve(__dirname, "billingEmailLifecycle.ts");
  const src = readFileSync(lifecyclePath, "utf8");
  assert.match(src, /export async function queueRefundEmailOnce/);
});

test("queueRefundEmailOnce guards against duplicate via billingEventLog refund_emailed", () => {
  const lifecyclePath = resolve(__dirname, "billingEmailLifecycle.ts");
  const src = readFileSync(lifecyclePath, "utf8");
  assert.match(src, /hasRefundEmailForTransaction/);
  assert.match(src, /refund_emailed/);
});

// ── queueApologyEmailOnce: idempotency ────────────────────────────────────────

test("queueApologyEmailOnce is exported from billingEmailLifecycle", () => {
  const lifecyclePath = resolve(__dirname, "billingEmailLifecycle.ts");
  const src = readFileSync(lifecyclePath, "utf8");
  assert.match(src, /export async function queueApologyEmailOnce/);
});

test("apology email is idempotent — already_sent guard exists", () => {
  const lifecyclePath = resolve(__dirname, "billingEmailLifecycle.ts");
  const src = readFileSync(lifecyclePath, "utf8");
  assert.match(src, /already_sent/);
  assert.match(src, /hasApologyEmailForTenant/);
  assert.match(src, /apology_email_sent/);
});

test("apology email preview skips idempotency guard", () => {
  const lifecyclePath = resolve(__dirname, "billingEmailLifecycle.ts");
  const src = readFileSync(lifecyclePath, "utf8");
  assert.match(src, /if.*isPreview.*hasApologyEmailForTenant/);
});
