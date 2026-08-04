/**
 * A one-dollar gateway test — on the SAME screen customers pay on.
 *
 * The first version of this shipped its own card form. That was wrong, and
 * Izzy caught it: `/pay/invoice/[token]` already exists, it is the page every
 * customer meets when they pay an invoice, and it already does all of this —
 * signed link, no login, invoice summary, card fields, receipt, "Payment
 * received". Rebuilding the page around the card widget meant the thing being
 * tested was a page nobody uses.
 *
 * So this file no longer touches cards at all. It creates a $1 invoice and
 * mints a pay link for it. Everything after that is the real customer path:
 * the real screen, the real charge, the real receipt. A pass here means the
 * page customers actually use works — which is a stronger claim than the
 * bespoke version could ever have made.
 *
 * The safeguards that still matter:
 *
 *   • The amount is a CONSTANT here, never read from the request. An endpoint
 *     that bills a caller-supplied amount is a payment terminal; this is not.
 *   • Super-admin only, and the invoice belongs to the caller's own tenant, so
 *     a test can never land on a customer's account.
 *
 * The invoice is real and tagged `card_gateway_test`, so it is visible in
 * billing, findable, and refundable. A test that leaves no trace is one you
 * cannot audit.
 */

import { createBillingInvoicePayToken } from "./billingPayToken";
import { createBillingInvoiceRowWithUniqueNumber } from "./invoiceEngine";
import { billingLiveChargesDisabled } from "./solaBillingPayments";

/** One dollar. Not configurable, not from the request body. */
export const CARD_TEST_AMOUNT_CENTS = 100;

/** Short-lived: this is a test link someone is about to click, not an invoice
 *  emailed to a customer who might pay it three weeks from now. */
const TEST_LINK_TTL_MS = 60 * 60 * 1000;

export type CardTestStart =
  | { ok: true; invoiceId: string; invoiceNumber: string; amountCents: number; payPath: string }
  | { ok: false; code: number; error: string; message: string };

export async function startCardGatewayTest(
  db: any,
  tenantId: string,
  actorLabel: string,
): Promise<CardTestStart> {
  if (billingLiveChargesDisabled()) {
    return {
      ok: false,
      code: 503,
      error: "live_charges_disabled",
      message: "Live card charges are switched off on this server, so there is nothing to test.",
    };
  }

  const now = new Date();
  const periodEnd = new Date(now.getTime() + 60_000);

  const invoice = await createBillingInvoiceRowWithUniqueNumber(tenantId, async (invoiceNumber: string) =>
    db.billingInvoice.create({
      data: {
        tenantId,
        invoiceNumber,
        status: "OPEN",
        issuedAt: now,
        dueAt: now,
        periodStart: now,
        periodEnd,
        subtotalCents: CARD_TEST_AMOUNT_CENTS,
        taxCents: 0,
        totalCents: CARD_TEST_AMOUNT_CENTS,
        balanceDueCents: CARD_TEST_AMOUNT_CENTS,
        // Tagged so it is obvious what this was in the invoice list, and so
        // revenue reporting can leave it out.
        metadata: { source: "card_gateway_test", requestedBy: actorLabel },
        lineItems: {
          create: [
            {
              description: "Card processing test",
              quantity: 1,
              unitPriceCents: CARD_TEST_AMOUNT_CENTS,
              amountCents: CARD_TEST_AMOUNT_CENTS,
              metadata: { key: "card_test" },
            },
          ],
        },
      },
    }),
  );

  const token = createBillingInvoicePayToken(invoice.id, tenantId, TEST_LINK_TTL_MS);
  return {
    ok: true,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    amountCents: CARD_TEST_AMOUNT_CENTS,
    payPath: `/pay/invoice/${encodeURIComponent(token)}`,
  };
}
