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

// The customer Payment Methods page used to hand-roll its own CDN-iframe card
// form — a second, different-looking card entry beside the platform's standard
// Sola payment surface. Adding a card now routes to /billing/payments/add-card,
// which renders the SAME CardknoxIFieldsForm + PaymentTrustBadge the pay pages
// use. These guards keep a second form from coming back.
const paymentsPagePath = join(here, "../app/(platform)/billing/payments/page.tsx");
const addCardPagePath = join(here, "../app/(platform)/billing/payments/add-card/page.tsx");

test("customer Payment Methods page no longer hand-rolls a card form", () => {
  const src = readFileSync(paymentsPagePath, "utf8");
  assert.doesNotMatch(src, /cdn\.cardknox\.com\/ifields/);
  assert.doesNotMatch(src, /ifield\.htm/);
  assert.doesNotMatch(src, /window\.getTokens/);
  assert.doesNotMatch(src, /sola-ifield-frame/);
  assert.doesNotMatch(src, /xCardNum/);
  assert.match(src, /\/billing\/payments\/add-card/);
});

test("customer add-card page is the standard Sola payment surface", () => {
  const src = readFileSync(addCardPagePath, "utf8");
  assert.match(src, /CardknoxIFieldsForm/);
  assert.match(src, /PaymentTrustBadge/);
  assert.match(src, /pay-invoice\.css/);
  assert.match(src, /billing\/payment-methods\/sola\/save/);
  assert.doesNotMatch(src, /cdn\.cardknox\.com\/ifields/);
  assert.doesNotMatch(src, /window\.getTokens/);
});
