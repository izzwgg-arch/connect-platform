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
