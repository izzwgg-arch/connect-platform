/**
 * Recurring named custom charges on the monthly cycle invoice (e.g. a hosted
 * server, a per-person add-on priced outside the extension catalog).
 *
 * Stored on `TenantBillingSettings.metadata.billingRecurringCustomLines` — no
 * Prisma migration. Opt-in per tenant: the key is absent on every other
 * tenant, so their invoices build byte-identically with this feature present.
 *
 * `taxable` defaults to false so the configured amount is FINAL — it adds to
 * the invoice total without entering the tax/fee engines or the all-inclusive
 * pricing solver. Set `taxable: true` only when the amount should join the
 * taxable service subtotal like a catalog line.
 */

export const BILLING_RECURRING_CUSTOM_LINES_METADATA_KEY = "billingRecurringCustomLines";

const MAX_LINES = 20;
const MAX_DESCRIPTION_LENGTH = 200;
/** Same ceiling the billing plan catalog applies to recurring unit prices. */
const MAX_AMOUNT_CENTS = 25_000_000;

export type BillingRecurringCustomLine = {
  description: string;
  amountCents: number;
  taxable?: boolean;
};

export function parseBillingRecurringCustomLines(metadata: unknown): BillingRecurringCustomLine[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const raw = (metadata as Record<string, unknown>)[BILLING_RECURRING_CUSTOM_LINES_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  const out: BillingRecurringCustomLine[] = [];
  for (const entry of raw.slice(0, MAX_LINES)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const o = entry as Record<string, unknown>;
    const description =
      typeof o.description === "string" ? o.description.trim().slice(0, MAX_DESCRIPTION_LENGTH) : "";
    const amountCents = Math.round(Number(o.amountCents));
    if (!description) continue;
    if (!Number.isFinite(amountCents) || amountCents < 1 || amountCents > MAX_AMOUNT_CENTS) continue;
    out.push({ description, amountCents, taxable: o.taxable === true });
  }
  return out;
}

export type RecurringCustomInvoiceLine = {
  type: "CUSTOM";
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  taxable: boolean;
  metadata: Record<string, unknown>;
};

export function buildRecurringCustomInvoiceLines(metadata: unknown): RecurringCustomInvoiceLine[] {
  return parseBillingRecurringCustomLines(metadata).map((line) => ({
    type: "CUSTOM",
    description: line.description,
    quantity: 1,
    unitPriceCents: line.amountCents,
    amountCents: line.amountCents,
    taxable: line.taxable === true,
    metadata: { lineItemKind: "recurring_custom" },
  }));
}
