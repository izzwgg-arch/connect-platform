/**
 * The ONE public projection of an invoice and its breakdown.
 *
 * Three public pay surfaces render this — the single-invoice token
 * (/pay/invoice/[token]), the combined token (/pay/invoices/[token]) and the
 * short pay-link code (/p/[code]) — and they must agree to the cent. A customer
 * who opens two links for the same invoice must not be shown two answers.
 *
 * ⛔ `metadata` is deliberately NOT projected. Line-item metadata carries
 * internal bookkeeping (extensionIds, phoneNumberIds, didId, quantityMode) that
 * no pay page renders and that a customer has no use for. Nothing outside our
 * own bookkeeping should ride an unauthenticated response.
 */

export type PublicInvoiceLine = {
  type: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
};

/** The breakdown rows a customer sees. Never throws — a missing relation
 *  costs the breakdown, never the ability to pay. */
export function publicInvoiceLines(invoice: any): PublicInvoiceLine[] {
  const rows = Array.isArray(invoice?.lineItems) ? invoice.lineItems : [];
  return rows.map((li: any) => ({
    type: String(li?.type ?? ""),
    description: String(li?.description ?? ""),
    quantity: Number(li?.quantity ?? 1),
    unitPriceCents: Number(li?.unitPriceCents ?? 0),
    amountCents: Number(li?.amountCents ?? 0),
  }));
}

/** The dates and sub-totals the breakdown is headed with.
 *  ⛔ Deliberately no `totalCents` — every caller already emits its own, and a
 *  second one here would silently overwrite it. */
export function publicInvoiceTotals(invoice: any) {
  return {
    issueDate: invoice?.issueDate ?? null,
    periodStart: invoice?.periodStart ?? null,
    periodEnd: invoice?.periodEnd ?? null,
    subtotalCents: Number(invoice?.subtotalCents ?? 0),
    taxCents: Number(invoice?.taxCents ?? 0),
  };
}
