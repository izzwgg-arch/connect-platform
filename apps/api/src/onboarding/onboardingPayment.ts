// ── Taking payment during sign-up ────────────────────────────────────────────
//
// Nothing is bought until this succeeds. Before this existed, the VoIP.ms
// number was purchased the moment someone left the number step — so an
// abandoned sign-up left us holding a paid-for number nobody asked for.
//
// PCI: raw card details never reach this server. The browser tokenises through
// Cardknox iFields and sends a single-use token (`xSut`). That token is
// forwarded and never logged, never stored, never echoed back.
//
// The Connect tenant is created HERE, at payment, rather than later during PBX
// provisioning. That is deliberate: charging needs a tenant to hang the
// invoice, payment method, idempotency key and audit trail on, and inventing a
// parallel "pre-tenant" payment path would mean a second, less-tested way for
// money to move. The submission records the tenant id so the provisioning
// orchestrator adopts it instead of creating a second one.

import { db } from "@connect/db";
import {
  quoteOnboarding, formatCents, describeQuote,
  type OnboardingQuote,
} from "@connect/shared";
import { createBillingInvoiceRowWithUniqueNumber } from "../billing/invoiceEngine";
import { chargeBillingInvoiceWithSut, billingLiveChargesDisabled } from "../billing/solaBillingPayments";

export interface OnboardingPaymentInput {
  xSut: string;
  xExp?: string | null;
  cardholderName?: string | null;
  billingZip?: string | null;
  /** From the browser, so a double-click can't charge twice. */
  clientOperationId?: string | null;
}

export type OnboardingPaymentResult =
  | { ok: true; tenantId: string; invoiceId: string; invoiceNumber: string; amountCents: number; last4: string | null; alreadyPaid?: true }
  | { ok: false; code: number; error: string; message: string };

/** What this submission owes, from the choices they made in the wizard. */
export function quoteForSubmission(sub: {
  requestedExtensions?: Array<unknown> | null;
  smsEnabled?: boolean | null;
  answers?: any;
  provisionedDid?: string | null;
}): OnboardingQuote {
  const extensions = Array.isArray(sub.requestedExtensions) ? sub.requestedExtensions.length : 0;
  // One number today. Extra numbers are an explicit choice; when the wizard
  // grows that option it sets answers.phone.extraNumbers and this picks it up
  // without the pricing needing to change.
  const extra = Number(sub.answers?.phone?.extraNumbers ?? 0);
  const phoneNumbers = 1 + (Number.isFinite(extra) && extra > 0 ? Math.floor(extra) : 0);
  return quoteOnboarding({ extensions, phoneNumbers, smsEnabled: !!sub.smsEnabled });
}

/**
 * Create the tenant if this submission hasn't got one yet.
 *
 * Idempotent on `createdTenantId`: a retried payment must never create a
 * second tenant for the same customer.
 */
async function ensureTenantForSubmission(sub: { id: string; companyName?: string | null; createdTenantId?: string | null; answers?: any }): Promise<string> {
  if (sub.createdTenantId) {
    const existing = await (db as any).tenant.findUnique({ where: { id: sub.createdTenantId }, select: { id: true } });
    if (existing) return existing.id;
  }
  const wantsYiddish = String(sub.answers?.language ?? "").toLowerCase() === "yi";
  const tenant = await (db as any).tenant.create({
    data: {
      name: (sub.companyName || "New customer").trim(),
      kind: "CUSTOMER",
      isApproved: true,
      yiddishEnabled: wantsYiddish,
    },
  });
  await (db as any).onboardingSubmission.update({
    where: { id: sub.id },
    data: { createdTenantId: tenant.id },
  });
  return tenant.id;
}

/**
 * Charge the first month and put the card on file.
 *
 * A card on file is not optional — it is how every following month is paid, so
 * autopay is switched on as part of this rather than offered as a choice the
 * customer could leave off and then be surprised by.
 */
export async function takeOnboardingPayment(
  submissionId: string,
  input: OnboardingPaymentInput,
): Promise<OnboardingPaymentResult> {
  if (!input.xSut || input.xSut.length < 8) {
    return { ok: false, code: 400, error: "card_token_missing", message: "Your card details didn't come through. Please re-enter them." };
  }
  if (billingLiveChargesDisabled()) {
    return { ok: false, code: 503, error: "charges_disabled", message: "Payments are paused right now. Please try again shortly." };
  }

  const sub = await (db as any).onboardingSubmission.findUnique({
    where: { id: submissionId },
    include: { requestedExtensions: true },
  });
  if (!sub) return { ok: false, code: 404, error: "submission_not_found", message: "We couldn't find your sign-up." };

  // Already paid? Say so plainly instead of charging again.
  if (sub.paidAt && sub.paidInvoiceId) {
    const inv = await (db as any).billingInvoice.findUnique({ where: { id: sub.paidInvoiceId }, select: { id: true, invoiceNumber: true, totalCents: true } });
    if (inv) {
      return { ok: true, tenantId: sub.createdTenantId, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, amountCents: inv.totalCents, last4: null, alreadyPaid: true };
    }
  }

  const quote = quoteForSubmission(sub);
  if (quote.monthlyTotalCents <= 0) {
    return { ok: false, code: 400, error: "nothing_to_charge", message: "There's nothing to pay for yet — add at least one person to your team." };
  }

  const tenantId = await ensureTenantForSubmission(sub);

  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  // One invoice per submission. If a previous attempt made one, reuse it —
  // otherwise a retried card creates a second invoice for the same month.
  let invoice = await (db as any).billingInvoice.findFirst({
    where: { tenantId, metadata: { path: ["onboardingSubmissionId"], equals: submissionId } },
  });
  if (!invoice) {
    invoice = await createBillingInvoiceRowWithUniqueNumber(tenantId, async (invoiceNumber: string) =>
      (db as any).billingInvoice.create({
        data: {
          tenantId,
          invoiceNumber,
          status: "OPEN",
          issuedAt: now,
          dueAt: now,
          periodStart: now,
          periodEnd,
          subtotalCents: quote.monthlyTotalCents,
          taxCents: 0, // the quoted per-line prices already include tax
          totalCents: quote.monthlyTotalCents,
          balanceDueCents: quote.monthlyTotalCents,
          metadata: { onboardingSubmissionId: submissionId, source: "onboarding_signup" },
          lineItems: {
            create: quote.lines.map((l) => ({
              description: l.label,
              quantity: l.quantity,
              unitPriceCents: l.unitCents,
              amountCents: l.totalCents,
              metadata: { key: l.key, note: l.note ?? null },
            })),
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
        // Vault the card so every following month can be charged without
        // asking again — this IS the "card on file" requirement, and it makes
        // it the tenant's default method.
        persistPaymentMethod: true,
        makeDefault: true,
        cardholderName: input.cardholderName ?? null,
        billingZip: input.billingZip ?? null,
        clientOperationId: input.clientOperationId ?? null,
      },
    );

    // A card on file is mandatory, so autopay is simply ON. There is no
    // customer-facing switch for it anywhere.
    await (db as any).tenantBillingSettings.upsert({
      where: { tenantId },
      create: { tenantId, autoBillingEnabled: true },
      update: { autoBillingEnabled: true },
    }).catch(() => null);

    await (db as any).onboardingSubmission.update({
      where: { id: submissionId },
      data: {
        paidAt: new Date(),
        paidInvoiceId: invoice.id,
        paidAmountCents: quote.monthlyTotalCents,
        events: { create: { type: "PAID", message: `${describeQuote(quote)} — invoice ${invoice.invoiceNumber}` } },
      },
    });

    return {
      ok: true,
      tenantId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      amountCents: quote.monthlyTotalCents,
      last4: tx?.paymentMethod?.last4 ?? tx?.last4 ?? null,
    };
  } catch (err: any) {
    const code = String(err?.code || "");
    // Card declines are the customer's problem to fix and must read as such;
    // everything else is ours and must not blame them for it.
    if (code === "CARD_TOKENIZATION_FAILED" || code === "CHARGE_DECLINED") {
      return { ok: false, code: 402, error: "card_declined", message: err?.userMessage || "That card was declined. Please check the details or try another card." };
    }
    if (code === "INVOICE_ALREADY_PAID") {
      return { ok: true, tenantId, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, amountCents: quote.monthlyTotalCents, last4: null, alreadyPaid: true };
    }
    return { ok: false, code: 502, error: "payment_failed", message: "We couldn't take the payment just now. Nothing has been charged — please try again." };
  }
}

export { formatCents };
