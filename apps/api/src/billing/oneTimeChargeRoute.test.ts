import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

/** Mirrors POST /admin/billing/platform/tenants/:tenantId/one-time-charges body schema. */
const oneTimeChargeBodySchema = z.object({
  description: z.string().min(1).max(240),
  amountCents: z.number().int().min(1),
  operatorNote: z.string().max(500).optional(),
  invoiceMemo: z.string().max(500).optional(),
  chargeMode: z.enum(["none", "card_on_file", "new_card"]).default("none"),
  paymentMethodId: z.string().optional(),
  xSut: z.string().optional(),
  xExp: z.string().min(4).max(4).optional(),
  cardholderName: z.string().optional(),
  billingZip: z.string().optional(),
  saveCard: z.boolean().optional(),
  makeDefault: z.boolean().optional(),
  confirmLive: z.boolean().optional(),
});

test("one-time charge body accepts xSut token fields only for new_card", () => {
  const parsed = oneTimeChargeBodySchema.parse({
    description: "Rush fee",
    amountCents: 5000,
    chargeMode: "new_card",
    xSut: "sut_token_from_ifields_only",
    xExp: "1228",
    cardholderName: "Jane Smith",
    billingZip: "10950",
    saveCard: true,
    makeDefault: false,
  });
  assert.equal(parsed.xSut, "sut_token_from_ifields_only");
  assert.equal(parsed.xExp, "1228");
  assert.equal((parsed as Record<string, unknown>).cardNumber, undefined);
  assert.equal((parsed as Record<string, unknown>).cvv, undefined);
});

test("one-time charge body rejects non-positive amount", () => {
  assert.throws(() =>
    oneTimeChargeBodySchema.parse({
      description: "Test",
      amountCents: 0,
      chargeMode: "none",
    }),
  );
});
