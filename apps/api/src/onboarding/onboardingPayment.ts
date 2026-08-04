// ── Payment during sign-up ───────────────────────────────────────────────────
//
// The wizard does NOT have its own payment screen any more. It had one — a
// card form inline in the final step — and Izzy had it deleted, correctly:
// `/pay/invoice/[token]` already exists, it is the checkout every customer
// uses to pay an invoice, and it already handles the card fields, the receipt
// email, and "Payment received". Two payment screens means two things to keep
// correct, and the wizard's copy was the one nobody else exercised.
//
// So the flow is now:
//
//   1. The wizard reaches checkout → `prepareOnboardingCheckout` creates the
//      tenant and the first invoice in the background and mints a pay link.
//   2. The customer pays on the REAL checkout page.
//   3. The public pay route sees the invoice is an onboarding one and calls
//      `finalizeOnboardingInvoicePaid`, which marks the submission paid — the
//      caller then kicks number purchase + PBX build + welcome emails, all of
//      which already existed.
//
// Nothing is bought until the card clears. That rule predates this refactor
// and survives it: the number purchase and the PBX build are triggered by the
// paid event, never by reaching checkout.
//
// The Connect tenant is created at checkout-preparation rather than later:
// charging needs a tenant to hang the invoice, payment method, and audit trail
// on, and the submission records the tenant id so provisioning adopts it
// instead of creating a second one.

import { db } from "@connect/db";
import {
  quoteOnboarding, formatCents, describeQuote,
  type OnboardingQuote,
} from "@connect/shared";
import { createBillingInvoiceRowWithUniqueNumber } from "../billing/invoiceEngine";
import { createBillingInvoicePayToken } from "../billing/billingPayToken";
import { billingLiveChargesDisabled } from "../billing/solaBillingPayments";

/** Long enough to sleep on the decision; short enough that a stale link from a
 *  half-finished sign-up doesn't survive for a month. */
const CHECKOUT_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export type OnboardingCheckout =
  | {
      ok: true;
      tenantId: string;
      invoiceId: string;
      invoiceNumber: string;
      amountCents: number;
      /** Relative portal path to the real customer checkout. */
      payPath: string;
      alreadyPaid: boolean;
    }
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
 * Idempotent on `createdTenantId`: a retried checkout must never create a
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
 * Everything checkout needs, created in the background before the customer
 * sees the payment screen: the tenant, the first month's invoice, and a signed
 * link to the real checkout page.
 *
 * Idempotent end to end — re-entering the checkout step reuses the same
 * tenant and the same invoice, and just mints a fresh link.
 */
export async function prepareOnboardingCheckout(submissionId: string): Promise<OnboardingCheckout> {
  if (billingLiveChargesDisabled()) {
    return { ok: false, code: 503, error: "charges_disabled", message: "Payments are paused right now. Please try again shortly." };
  }

  const sub = await (db as any).onboardingSubmission.findUnique({
    where: { id: submissionId },
    include: { requestedExtensions: true },
  });
  if (!sub) return { ok: false, code: 404, error: "submission_not_found", message: "We couldn't find your sign-up." };

  const quote = quoteForSubmission(sub);
  if (quote.monthlyTotalCents <= 0) {
    return { ok: false, code: 400, error: "nothing_to_charge", message: "There's nothing to pay for yet — add at least one person to your team." };
  }

  const tenantId = await ensureTenantForSubmission(sub);

  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  // One invoice per submission. A revisit to the checkout step reuses it —
  // otherwise every visit creates another invoice for the same first month.
  let invoice = await (db as any).billingInvoice.findFirst({
    where: { tenantId, metadata: { path: ["onboardingSubmissionId"], equals: submissionId } },
  });

  // The quote can legitimately change between visits (they went back and added
  // a person), so an UNPAID invoice is re-lined to match. A paid one is never
  // touched — the money already moved for what it listed.
  // Line items carry their own tenantId and a typed category (the schema
  // requires both — the enum powers billing reports).
  const LINE_TYPE: Record<string, string> = {
    extensions: "EXTENSION",
    e911: "E911_FEE",
    sms: "SMS_PACKAGE",
    additional_numbers: "PHONE_NUMBER",
  };
  const lineItemRows = () =>
    quote.lines.map((l) => ({
      tenantId,
      type: LINE_TYPE[l.key] || "MANUAL_ADJUSTMENT",
      description: l.label,
      quantity: l.quantity,
      unitPriceCents: l.unitCents,
      amountCents: l.totalCents,
      metadata: { key: l.key, note: l.note ?? null },
    }));

  const alreadyPaid = !!invoice && (invoice.status === "PAID" || (invoice.balanceDueCents ?? 0) <= 0);
  if (invoice && !alreadyPaid && invoice.totalCents !== quote.monthlyTotalCents) {
    await (db as any).billingInvoiceLineItem.deleteMany({ where: { invoiceId: invoice.id } });
    invoice = await (db as any).billingInvoice.update({
      where: { id: invoice.id },
      data: {
        subtotalCents: quote.monthlyTotalCents,
        taxCents: 0,
        totalCents: quote.monthlyTotalCents,
        balanceDueCents: quote.monthlyTotalCents,
        lineItems: { create: lineItemRows() },
      },
    });
  }

  if (!invoice) {
    invoice = await createBillingInvoiceRowWithUniqueNumber(tenantId, async (invoiceNumber: string) =>
      (db as any).billingInvoice.create({
        data: {
          tenantId,
          invoiceNumber,
          status: "OPEN",
          issueDate: now,
          dueDate: now,
          periodStart: now,
          periodEnd,
          subtotalCents: quote.monthlyTotalCents,
          taxCents: 0, // the quoted per-line prices already include tax
          totalCents: quote.monthlyTotalCents,
          balanceDueCents: quote.monthlyTotalCents,
          metadata: { onboardingSubmissionId: submissionId, source: "onboarding_signup" },
          lineItems: { create: lineItemRows() },
        },
      }),
    );
  }

  const token = createBillingInvoicePayToken(invoice.id, tenantId, CHECKOUT_LINK_TTL_MS);
  return {
    ok: true,
    tenantId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    amountCents: invoice.totalCents,
    payPath: `/pay/invoice/${encodeURIComponent(token)}`,
    alreadyPaid,
  };
}

/**
 * Called by the public pay route the moment an onboarding invoice is paid on
 * the real checkout page. Marks the submission paid; the CALLER is responsible
 * for kicking provisioning (number purchase, PBX build, welcome emails),
 * because those fire-and-forget jobs live with the route, not here.
 *
 * Idempotent: a webhook replay or a double-submit marks paid once.
 */
export async function finalizeOnboardingInvoicePaid(invoice: {
  id: string;
  totalCents?: number | null;
  metadata?: any;
}): Promise<{ submissionId: string; publicToken: string | null } | null> {
  const submissionId = String(invoice?.metadata?.onboardingSubmissionId ?? "");
  if (!submissionId) return null;

  const sub = await (db as any).onboardingSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, publicToken: true, paidAt: true },
  });
  if (!sub) return null;
  if (sub.paidAt) return { submissionId: sub.id, publicToken: sub.publicToken ?? null };

  const full = await (db as any).onboardingSubmission.findUnique({
    where: { id: submissionId },
    include: { requestedExtensions: true },
  });
  const quote = quoteForSubmission(full);

  await (db as any).onboardingSubmission.update({
    where: { id: submissionId },
    data: {
      paidAt: new Date(),
      paidInvoiceId: invoice.id,
      paidAmountCents: invoice.totalCents ?? quote.monthlyTotalCents,
      // STATUS_CHANGED, not "PAID": the OnboardingEventType enum has no PAID
      // member, and an invalid type made this whole update throw — payment
      // approved but the submission never marked paid, build never started.
      events: { create: { type: "STATUS_CHANGED", message: `Paid: ${describeQuote(quote)} — on the checkout page` } },
    },
  });

  return { submissionId: sub.id, publicToken: sub.publicToken ?? null };
}

export { formatCents };
