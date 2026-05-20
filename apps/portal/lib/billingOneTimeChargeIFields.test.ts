import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const drawerPath = join(here, "../app/(platform)/admin/billing/_components/adminBillingPaymentDrawers.tsx");

test("OneTimeChargeDrawer uses CardknoxIFieldsForm, not legacy CDN iframes", () => {
  const src = readFileSync(drawerPath, "utf8");
  assert.match(src, /CardknoxIFieldsForm/);
  assert.doesNotMatch(src, /cdn\.cardknox\.com\/ifields/);
  assert.doesNotMatch(src, /ifield\.htm/);
  assert.doesNotMatch(src, /window\.getTokens/);
  assert.doesNotMatch(src, /sola-ifield-frame/);
});

test("OneTimeChargeDrawer posts xSut only (no raw card fields in client body)", () => {
  const src = readFileSync(drawerPath, "utf8");
  assert.match(src, /body\.xSut/);
  assert.match(src, /body\.xExp/);
  assert.doesNotMatch(src, /xCardNum/);
  assert.doesNotMatch(src, /name="cardNumber"/i);
  assert.doesNotMatch(src, /name="cvv"/i);
});
