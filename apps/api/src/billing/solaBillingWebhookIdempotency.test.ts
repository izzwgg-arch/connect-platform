import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("webhook path keeps xRef/xEvent dedupe before insert", () => {
  const src = readFileSync(resolve(__dirname, "solaBillingPayments.ts"), "utf8");
  assert.match(src, /buildBillingWebhookDedupeOrClause/);
  assert.match(src, /idempotencyKey: `webhook:ref:\$\{params\.processorRef\}`/);
  assert.match(src, /const existingTx = await \(db as any\)\.paymentTransaction\.findFirst/);
  assert.match(src, /if \(existingTx\)\s*\{/);
  assert.match(src, /return \{ ok: true, deduped: true, invoiceId: platformInvoice\.id \}/);
});
