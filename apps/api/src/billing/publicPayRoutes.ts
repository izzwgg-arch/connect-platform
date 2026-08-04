import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { hasCredentialsMasterKey } from "@connect/security";
import {
  getBillingSolaAdapter,
  resolveBillingGatewayConfig,
} from "./solaGateway";
import { billingLiveChargesDisabled, chargeBillingInvoiceWithSut } from "./solaBillingPayments";
import { verifyBillingInvoicePayToken } from "./billingPayToken";
import { logBillingEvent } from "./invoiceEngine";
import { resolveInvoiceEmailBranding } from "./invoiceBranding";

async function loadInvoiceForPayToken(token: string) {
  const parsed = verifyBillingInvoicePayToken(token);
  if (!parsed) return { error: "invoice_token_invalid" as const, code: 410 as const };
  const invoice = await (db as any).billingInvoice.findFirst({
    where: { id: parsed.invoiceId, tenantId: parsed.tenantId },
    include: {
      lineItems: { orderBy: { createdAt: "asc" } },
      tenant: { select: { name: true, billingSettings: true } },
    },
  });
  if (!invoice) return { error: "invoice_not_found" as const, code: 404 as const };
  return { invoice, parsed };
}


/** Is this the first invoice of a sign-up? If so, where does the customer go
 *  after paying it? The wizard's own payment screen is gone — this page IS the
 *  sign-up checkout now — so the hand-back to the sign-up flow lives here. */
async function onboardingContinuePath(invoice: { metadata?: any }): Promise<string | null> {
  const submissionId = String(invoice?.metadata?.onboardingSubmissionId ?? "");
  if (!submissionId) return null;
  const sub = await (db as any).onboardingSubmission.findUnique({
    where: { id: submissionId },
    select: { publicToken: true },
  });
  return sub?.publicToken ? `/onboarding/${encodeURIComponent(sub.publicToken)}/success` : null;
}

/** Public (JWT-free) routes for customer self-pay on BillingInvoice. */
export function registerBillingPublicPayRoutes(app: FastifyInstance) {
  app.get("/billing/platform/invoices/pay/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const loaded = await loadInvoiceForPayToken(token);
    if ("error" in loaded) {
      const status = loaded.error === "invoice_not_found" ? 404 : 410;
      return reply.code(status).send({ error: loaded.error });
    }
    const { invoice } = loaded;
    if (["QUEUED", "SENT", "SMS_SENT"].includes(String(invoice.lastEmailStatus || "").toUpperCase())) {
      await (db as any).billingInvoice.update({
        where: { id: invoice.id },
        data: { lastEmailStatus: "OPENED", lastEmailedAt: new Date() },
      });
      await logBillingEvent({
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        type: "invoice_link_opened",
        metadata: { source: "public_pay_page" },
      });
    }
    const balanceDueCents = Math.max(0, invoice.balanceDueCents ?? invoice.totalCents ?? 0);
    const canPay = balanceDueCents > 0 && !["PAID", "VOID"].includes(invoice.status);
    const brand = resolveInvoiceEmailBranding(invoice.tenant?.billingSettings || {}, invoice.tenant?.name);
    // A sign-up invoice carries the customer somewhere specific afterwards:
    // the build-progress screen, not the dashboard they can't log into yet.
    const continuePath = await onboardingContinuePath(invoice);
    return {
      continuePath,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      companyName: brand.displayName || invoice.tenant?.name || "Connect Communications",
      status: invoice.status,
      canPay,
      currency: invoice.currency || "USD",
      totalCents: invoice.totalCents,
      balanceDueCents,
      dueDate: invoice.dueDate,
      issueDate: invoice.issueDate,
      lineItems: (invoice.lineItems || []).map((li: any) => ({
        type: li.type,
        description: li.description,
        quantity: li.quantity,
        unitPriceCents: li.unitPriceCents,
        amountCents: li.amountCents,
        metadata: li.metadata || null,
      })),
    };
  });

  app.get("/billing/platform/invoices/pay/:token/public-config", async (req, reply) => {
    if (!hasCredentialsMasterKey()) {
      return reply.code(503).send({ error: "credential_crypto_unavailable" });
    }
    const { token } = req.params as { token: string };
    const loaded = await loadInvoiceForPayToken(token);
    if ("error" in loaded) {
      const status = loaded.error === "invoice_not_found" ? 404 : 410;
      return reply.code(status).send({ error: loaded.error });
    }
    const gateway = await resolveBillingGatewayConfig(loaded.invoice.tenantId, { forTokenizing: true });
    if (!gateway.ifieldsKey) {
      return reply.code(503).send({ error: "payment_gateway_not_configured" });
    }
    return {
      ifieldsKey: gateway.ifieldsKey,
      ifieldsVersion: "3.4.2602.2001",
      mode: gateway.mode || "sandbox",
      canPay: !["PAID", "VOID"].includes(loaded.invoice.status)
        && (loaded.invoice.balanceDueCents ?? loaded.invoice.totalCents ?? 0) > 0,
      gatewayConfigured: gateway.configured,
      gatewayConfigSource: gateway.source,
      tenantOverridePresent: gateway.tenantOverridePresent,
    };
  });

  app.post("/billing/platform/invoices/pay/:token/pay", async (req, reply) => {
    const { token } = req.params as { token: string };
    const loaded = await loadInvoiceForPayToken(token);
    if ("error" in loaded) {
      const status = loaded.error === "invoice_not_found" ? 404 : 410;
      return reply.code(status).send({ error: loaded.error });
    }
    const { invoice } = loaded;
    const balanceDueCents = Math.max(0, invoice.balanceDueCents ?? invoice.totalCents ?? 0);
    if (invoice.status === "PAID" || balanceDueCents <= 0) {
      return reply.code(400).send({ error: "invoice_already_paid" });
    }
    if (invoice.status === "VOID") {
      return reply.code(400).send({ error: "invoice_voided" });
    }
    if (billingLiveChargesDisabled()) {
      return reply.code(503).send({ error: "billing_live_charges_disabled" });
    }

    const input = z.object({
      xSut: z.string().min(8),
      xExp: z.string().min(4).max(4).optional(),
      cardholderName: z.string().max(120).optional(),
      billingZip: z.string().max(20).optional(),
      billingEmail: z.string().email().max(200).optional(),
      saveCard: z.boolean().default(false),
      enableAutopay: z.boolean().default(false),
    }).parse(req.body || {});

    let adapter;
    try {
      adapter = await getBillingSolaAdapter(invoice.tenantId);
    } catch (e: any) {
      if (String(e?.message || e).includes("SOLA_NOT_ENABLED")) {
        return reply.code(503).send({ error: "payment_gateway_not_enabled" });
      }
      throw e;
    }

    if (input.billingEmail?.trim()) {
      await (db as any).tenantBillingSettings.update({
        where: { tenantId: invoice.tenantId },
        data: { billingEmail: input.billingEmail.trim() },
      }).catch(() => null);
    }

    // A sign-up invoice is different in one non-negotiable way: the card goes
    // on file and autopay is ON, because that is how every following month is
    // paid. It is not a checkbox the customer can leave off and be surprised
    // by later — so for these invoices the client's saveCard/enableAutopay
    // flags are overridden rather than trusted.
    const isOnboardingInvoice = String((invoice.metadata as any)?.source ?? "") === "onboarding_signup"
      && !!(invoice.metadata as any)?.onboardingSubmissionId;
    const saveCard = isOnboardingInvoice ? true : input.saveCard;
    const enableAutopay = isOnboardingInvoice ? true : input.enableAutopay;

    try {
      let transaction: any;
      if (saveCard) {
        transaction = await chargeBillingInvoiceWithSut(
          invoice,
          {
            xSut: input.xSut,
            xExp: input.xExp,
            cardholderName: input.cardholderName,
            billingZip: input.billingZip,
          },
          {
            adapter,
            note: "public_pay_link_saved_card",
            persistPaymentMethod: true,
            makeDefault: enableAutopay || false,
            customerIdentity: `tenant:${invoice.tenantId}`,
          },
        );
        const savedPaymentMethodId = (transaction?.rawResponseSafeJson as any)?.savedPaymentMethodId;
        if (enableAutopay) {
          // Upsert, not update: a brand-new sign-up tenant has no settings row
          // yet, and update on a missing row throws — which would have made
          // "autopay mandatory" silently false for exactly the customers it
          // was mandatory for.
          await (db as any).tenantBillingSettings.upsert({
            where: { tenantId: invoice.tenantId },
            create: { tenantId: invoice.tenantId, autoBillingEnabled: true, ...(savedPaymentMethodId ? { defaultPaymentMethodId: savedPaymentMethodId } : {}) },
            update: { autoBillingEnabled: true, ...(savedPaymentMethodId ? { defaultPaymentMethodId: savedPaymentMethodId } : {}) },
          }).catch(() => null);
        }
      } else {
        transaction = await chargeBillingInvoiceWithSut(
          invoice,
          {
            xSut: input.xSut,
            xExp: input.xExp,
            cardholderName: input.cardholderName,
            billingZip: input.billingZip,
          },
          { adapter, note: "public_pay_link", customerIdentity: `tenant:${invoice.tenantId}` },
        );
      }

      await logBillingEvent({
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        type: "payment.public_pay_succeeded",
        message: `Public pay link payment for invoice ${invoice.invoiceNumber}`,
        metadata: {
          transactionId: transaction?.id,
          saveCardRequested: saveCard,
          enableAutopayRequested: enableAutopay,
          onboarding: isOnboardingInvoice || undefined,
        },
      });

      // Sign-up paid → NOW buy the number and start building. Everything after
      // this line already existed (provisioning, PBX build, welcome emails);
      // paying on this page simply became the thing that triggers it.
      // Fire-and-forget: the customer is being redirected to the progress
      // screen, which watches the build rather than this request.
      // Dynamic imports keep billing from depending on onboarding at load time.
      if (isOnboardingInvoice && transaction?.status === "APPROVED") {
        void (async () => {
          try {
            const { finalizeOnboardingInvoicePaid } = await import("../onboarding/onboardingPayment");
            const done = await finalizeOnboardingInvoicePaid(invoice);
            if (done) {
              const { applyOnboardingNumber } = await import("../onboarding/voipMsProvisioning");
              const { resumeSetupIfSubmitted } = await import("../onboarding/setupOrchestrator");
              await applyOnboardingNumber(done.submissionId).catch(() => { /* logged inside */ });
              await resumeSetupIfSubmitted(done.submissionId).catch(() => { /* logged inside */ });
            }
          } catch (err) {
            app.log.error({ err: (err as any)?.message, invoiceId: invoice.id }, "[ONBOARDING] post-payment kick failed");
          }
        })();
      }

      return {
        ok: true,
        approved: transaction?.status === "APPROVED",
        transactionId: transaction?.id,
        invoiceStatus: transaction?.status === "APPROVED" ? "PAID" : invoice.status,
      };
    } catch (e: any) {
      if (e?.code === "BILLING_LIVE_CHARGES_DISABLED") {
        return reply.code(503).send({ error: "billing_live_charges_disabled" });
      }
      if (e?.code === "CHARGE_IN_PROGRESS") {
        return reply.code(409).send({
          error: "charge_in_progress",
          existingTransactionId: e?.existingTransaction?.id || null,
        });
      }
      if (e?.code === "CARD_TOKENIZATION_FAILED") {
        return reply.code(402).send({ error: "card_tokenization_failed" });
      }
      throw e;
    }
  });
}
