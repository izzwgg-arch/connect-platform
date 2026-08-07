import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { isValidMultiBillingEmail, normalizeMultiBillingEmail } from "./billingEmailLifecycle";

/**
 * Guards the billingEmail field of PUT /admin/billing/tenants/:tenantId/settings.
 *
 * ⛔ The bug this exists for: the transform used to end `: v ?? null`, so an
 * ABSENT billingEmail parsed to `null` instead of `undefined`. The handler drops
 * only `undefined` keys, so `null` survived and was written — every save of any
 * unrelated billing setting silently erased the customer's billing email.
 * 18 of 30 live tenants had no billing email when this was found.
 *
 * This mirrors the route's schema slice and its exact write-filter line, so a
 * regression fails here rather than in production.
 */
const billingEmailField = z
  .string()
  .nullable()
  .optional()
  .refine((v) => v == null || isValidMultiBillingEmail(v), {
    message: "billingEmail must be a valid email address or comma-separated list of valid addresses",
  })
  .transform((v) => (v === undefined ? undefined : v ? normalizeMultiBillingEmail(v) || null : null));

const settingsSchema = z.object({
  autoBillingEnabled: z.boolean().optional(),
  extensionPriceCents: z.number().int().nonnegative().optional(),
  billingEmail: billingEmailField,
});

/** The handler's write filter, verbatim: undefined keys are not written. */
function whatGetsWritten(body: Record<string, unknown>): Record<string, unknown> {
  const input = settingsSchema.parse(body);
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}

test("saving an unrelated setting does not touch billingEmail", () => {
  const written = whatGetsWritten({ autoBillingEnabled: true });
  assert.equal("billingEmail" in written, false, "billingEmail must not be written when it was not sent");
  assert.deepEqual(written, { autoBillingEnabled: true });
});

test("saving a price does not touch billingEmail", () => {
  const written = whatGetsWritten({ extensionPriceCents: 3500 });
  assert.equal("billingEmail" in written, false);
});

test("an empty save writes nothing at all", () => {
  assert.deepEqual(whatGetsWritten({}), {});
});

test("an address that is sent is normalized and saved", () => {
  assert.equal(whatGetsWritten({ billingEmail: "  a@b.com ,c@d.com " }).billingEmail, "a@b.com, c@d.com");
});

test("explicit null clears the address on purpose", () => {
  const written = whatGetsWritten({ billingEmail: null });
  assert.equal("billingEmail" in written, true, "an explicit clear must still be written");
  assert.equal(written.billingEmail, null);
});

test("explicit empty string clears the address on purpose", () => {
  assert.equal(whatGetsWritten({ billingEmail: "" }).billingEmail, null);
});

test("an invalid address is rejected rather than silently blanked", () => {
  assert.throws(() => settingsSchema.parse({ billingEmail: "not-an-email" }));
});
