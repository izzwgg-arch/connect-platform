/**
 * A one-dollar gateway test.
 *
 * The onboarding wizard cannot do this: its amount comes from the same
 * server-side quote the customer agreed to, deliberately, so the figure shown
 * and the figure charged can never drift apart. That makes it the wrong tool
 * for "does the card processor actually take money", where the answer matters
 * and the amount does not.
 *
 * So this is a separate, deliberately boring path that exercises the SAME
 * gateway call the wizard uses — one-time iFields token → cc:save → cc:sale →
 * a real transaction row against a real invoice. Nothing is stubbed. If this
 * succeeds, the wizard's payment step works, because it is the same code.
 *
 * Two things are load-bearing about how it is locked down:
 *
 *   • The amount is a CONSTANT here, never read from the request. An endpoint
 *     that charges a client-supplied amount to a client-supplied card is a
 *     payment terminal, and this is not one.
 *   • Super-admin only, and it charges against the caller's own tenant, so a
 *     test can never land on a customer's account.
 *
 * The invoice it creates is real and visible in billing on purpose — a test
 * that leaves no trace is a test you cannot audit or refund.
 */

import { chargeBillingInvoiceWithSut, billingLiveChargesDisabled } from "./solaBillingPayments";
import { createBillingInvoiceRowWithUniqueNumber } from "./invoiceEngine";

/** One dollar. Not configurable, not from the request body. */
export const CARD_TEST_AMOUNT_CENTS = 100;

export type CardTestInput = {
  xSut: string;
  xExp?: string | null;
  cardholderName?: string | null;
  billingZip?: string | null;
  /** Stable across retries of one attempt, so a double-submit is one charge. */
  clientOperationId?: string | null;
};

export type CardTestResult =
  | {
      ok: true;
      amountCents: number;
      invoiceId: string;
      invoiceNumber: string;
      transactionId: string | null;
      processorRef: string | null;
      last4: string | null;
      cardBrand: string | null;
    }
  | { ok: false; code: number; error: string; message: string };

export async function runCardGatewayTest(
  db: any,
  tenantId: string,
  actorLabel: string,
  input: CardTestInput,
): Promise<CardTestResult> {
  if (billingLiveChargesDisabled()) {
    return {
      ok: false,
      code: 503,
      error: "live_charges_disabled",
      message: "Live card charges are switched off on this server, so there is nothing to test.",
    };
  }
  if (!input.xSut || !input.xSut.trim()) {
    return { ok: false, code: 400, error: "card_token_required", message: "No card details were submitted." };
  }

  const now = new Date();
  const periodEnd = new Date(now.getTime() + 60_000);

  // Reuse an invoice from the same attempt rather than minting a second one —
  // the same guard the wizard has, for the same reason.
  let invoice = input.clientOperationId
    ? await db.billingInvoice.findFirst({
        where: { tenantId, metadata: { path: ["cardTestOperationId"], equals: input.clientOperationId } },
      })
    : null;

  if (invoice && (invoice.status === "PAID" || (invoice.balanceDueCents ?? 0) <= 0)) {
    return {
      ok: false,
      code: 409,
      error: "already_charged",
      message: "That test has already gone through — refresh the page to run another.",
    };
  }

  if (!invoice) {
    invoice = await createBillingInvoiceRowWithUniqueNumber(tenantId, async (invoiceNumber: string) =>
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
          // Marked so it is obvious in the invoice list what this was, and so
          // reporting can exclude it from revenue.
          metadata: {
            source: "card_gateway_test",
            cardTestOperationId: input.clientOperationId ?? null,
            requestedBy: actorLabel,
          },
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
  }

  try {
    const tx = await chargeBillingInvoiceWithSut(
      invoice,
      {
        xSut: input.xSut,
        xExp: input.xExp ?? null,
        cardholderName: input.cardholderName ?? null,
        billingZip: input.billingZip ?? null,
      },
      {
        // Deliberately NOT vaulted. This proves the processor takes the card;
        // it is not someone signing up, so we have no business keeping it.
        persistPaymentMethod: false,
        makeDefault: false,
        cardholderName: input.cardholderName ?? null,
        billingZip: input.billingZip ?? null,
      },
    );

    return {
      ok: true,
      amountCents: CARD_TEST_AMOUNT_CENTS,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      transactionId: tx?.id ?? null,
      processorRef: tx?.processorRef ?? tx?.externalId ?? null,
      last4: tx?.cardLast4 ?? null,
      cardBrand: tx?.cardBrand ?? null,
    };
  } catch (err: any) {
    // A decline is a RESULT, not a crash — the whole point is to find out.
    // Surface the processor's own wording; it is what a cardholder needs.
    const { solaProcessorUserMessage } = await import("./solaBillingPayments");
    const message =
      err?.processorResponse ? solaProcessorUserMessage(err.processorResponse)
      : err?.code === "BILLING_LIVE_CHARGES_DISABLED" ? "Live card charges are switched off on this server."
      : err?.message || "The card was not charged.";
    return { ok: false, code: 402, error: "charge_failed", message };
  }
}
