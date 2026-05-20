import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("worker charge path reuses API charge idempotency guard", () => {
  const src = readFileSync(resolve(__dirname, "main.ts"), "utf8");
  assert.match(src, /import\s+\{\s*chargeBillingInvoice\s*\}\s+from\s+"..\/..\/api\/src\/billing\/solaBillingPayments"/);
  assert.match(src, /await chargeBillingInvoice\(/);
});
