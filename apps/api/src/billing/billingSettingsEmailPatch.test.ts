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

// ── The same trap on PUT /admin/billing/invoices/:id ─────────────────────────
// That route applies its patch with `if (body.billingEmail !== undefined)`.
// Before the fix the transform ended `: v ?? null`, so zod put billingEmail:null
// on the parsed object even when the client never sent it, and editing only the
// notes erased the invoice's billing email override.

const invoicePatchSchema = z.object({
  notes: z.string().max(2000).nullable().optional(),
  billingEmail: billingEmailField,
  status: z.enum(["DRAFT", "OPEN", "OVERDUE"]).optional(),
});

/** The route's apply block, verbatim. */
function invoiceUpdate(body: Record<string, unknown>): Record<string, unknown> {
  const parsed = invoicePatchSchema.parse(body);
  const update: Record<string, unknown> = {};
  if ("notes" in parsed) update.notes = parsed.notes;
  if (parsed.billingEmail !== undefined) update.billingEmail = parsed.billingEmail;
  if (parsed.status) update.status = parsed.status;
  return update;
}

test("editing only an invoice's notes does not erase its billing email", () => {
  const update = invoiceUpdate({ notes: "spoke to the customer" });
  assert.equal("billingEmail" in update, false);
  assert.deepEqual(update, { notes: "spoke to the customer" });
});

test("changing only an invoice's status does not erase its billing email", () => {
  assert.equal("billingEmail" in invoiceUpdate({ status: "OPEN" }), false);
});

test("an invoice billing email that is sent is still saved", () => {
  assert.equal(invoiceUpdate({ billingEmail: "ap@acme.com" }).billingEmail, "ap@acme.com");
});

test("an invoice billing email can still be cleared on purpose", () => {
  const update = invoiceUpdate({ billingEmail: null });
  assert.equal("billingEmail" in update, true);
  assert.equal(update.billingEmail, null);
});
