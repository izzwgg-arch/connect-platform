import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("charge flow reserves idempotent pending transaction before gateway call", () => {
  const src = readFileSync(resolve(__dirname, "solaBillingPayments.ts"), "utf8");
  assert.match(src, /async function reserveChargeAttempt\(/);
  assert.match(src, /status:\s*"PENDING"/);
  assert.match(src, /if \(inProgress\)\s*\{/);
  assert.match(src, /err\.code = "CHARGE_IN_PROGRESS"/);
  assert.match(src, /idempotencyKey = `\$\{prefix\}\$\{prior\.length \+ 1\}`/);
  assert.match(src, /buildConnectBillingGatewayXInvoice\([^)]*idempotencyKey\)/);
  assert.doesNotMatch(src, /billing:sale:\$\{invoice\.id\}:\$\{Date\.now\(\)\}/);
});

test("durable charge keys are server-derived, not client operation or SUT derived", () => {
  const paymentsSrc = readFileSync(resolve(__dirname, "solaBillingPayments.ts"), "utf8");
  const operationsSrc = readFileSync(resolve(__dirname, "billingChargeOperations.ts"), "utf8");
  const routesSrc = readFileSync(resolve(__dirname, "routes.ts"), "utf8");
  const publicSrc = readFileSync(resolve(__dirname, "publicPayRoutes.ts"), "utf8");
  const workerSrc = readFileSync(resolve(__dirname, "../../../worker/src/main.ts"), "utf8");

  assert.match(operationsSrc, /model|buildSavedCardInvoiceChargeBusinessKey|buildSutInvoiceChargeBusinessKey|buildOneTimeChargeBusinessKey/s);
  assert.match(paymentsSrc, /serverOperationKey/);
  assert.doesNotMatch(paymentsSrc, /operationKey/);
  assert.doesNotMatch(paymentsSrc, /toSutHash|sut:\$\{toSutHash/);
  assert.match(routesSrc, /reserveBillingChargeOperation/);
  assert.match(routesSrc, /attachBillingChargeOperationInvoice/);
  assert.match(publicSrc, /billingLiveChargesDisabled\(\)/);
  assert.match(routesSrc, /input\.chargeMode !== "none" && billingLiveChargesDisabled\(\)/);
  assert.match(workerSrc, /BILLING_LIVE_CHARGES_DISABLED/);
});
