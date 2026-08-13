import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { hasCredentialsMasterKey } from "@connect/security";
import {
  getBillingSolaAdapter,
  resolveBillingGatewayConfig,
} from "./solaGateway";
import { billingLiveChargesDisabled, chargeBillingInvoice, chargeBillingInvoiceWithSut } from "./solaBillingPayments";
import { verifyBillingInvoicePayToken, verifyBillingMultiPayToken } from "./billingPayToken";
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

/** Payable = has a balance and is not settled or cancelled. */
function invoiceIsPayable(invoice: any): boolean {
  const balance = Math.max(0, invoice.balanceDueCents ?? invoice.totalCents ?? 0);
  return balance > 0 && !["PAID", "VOID"].includes(invoice.status);
}

async function loadInvoicesForMultiPayToken(token: string) {
  const parsed = verifyBillingMultiPayToken(token);
  if (!parsed) return { error: "invoice_token_invalid" as const, code: 410 as const };
  const invoices = await (db as any).billingInvoice.findMany({
    where: { id: { in: parsed.invoiceIds }, tenantId: parsed.tenantId },
    include: { tenant: { select: { name: true, billingSettings: true } } },
    orderBy: { dueDate: "asc" },
  });
  if (!invoices.length) return { error: "invoice_not_found" as const, code: 404 as const };
  return { invoices, parsed };
}

/** Public (JWT-free) routes for customer self-pay on BillingInvoice. */
export function registerBillingPublicPayRoutes(app: FastifyInstance) {
  // ── Combined link: several invoices, one page, one card entry ──────────────
  //
  // The card is verified ONCE (the form's single-use token becomes a reusable
  // gateway token by being saved), then each invoice is charged in due-date
  // order through the same per-invoice machinery as everything else — so every
  // invoice keeps its own transaction, receipt email, and timeline.

  app.get("/billing/platform/invoices/pay-multi/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const loaded = await loadInvoicesForMultiPayToken(token);
    if ("error" in loaded) return reply.code(loaded.error === "invoice_not_found" ? 404 : 410).send({ error: loaded.error });
    const { invoices } = loaded;
    const tenant = invoices[0].tenant;
    const brand = resolveInvoiceEmailBranding(tenant?.billingSettings || {}, tenant?.name);
    const rows = invoices.map((inv: any) => ({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      status: inv.status,
      dueDate: inv.dueDate,
      totalCents: inv.totalCents,
      balanceDueCents: Math.max(0, inv.balanceDueCents ?? inv.totalCents ?? 0),
      payable: invoiceIsPayable(inv),
    }));
    const combinedDueCents = rows.reduce((sum: number, r: any) => sum + (r.payable ? r.balanceDueCents : 0), 0);
    // Mark link opens on every covered invoice that was texted/emailed out.
    for (const inv of invoices) {
      if (["QUEUED", "SENT", "SMS_SENT"].includes(String(inv.lastEmailStatus || "").toUpperCase())) {
        await (db as any).billingInvoice.update({
          where: { id: inv.id },
          data: { lastEmailStatus: "OPENED", lastEmailedAt: new Date() },
        }).catch(() => null);
        await logBillingEvent({
          tenantId: inv.tenantId,
          invoiceId: inv.id,
          type: "invoice_link_opened",
          metadata: { source: "public_pay_page", combined: true },
        });
      }
    }
    return {
      companyName: brand.displayName || tenant?.name || "Connect Communications",
      currency: invoices[0].currency || "USD",
      invoices: rows,
      combinedDueCents,
      canPay: combinedDueCents > 0,
    };
  });

  app.get("/billing/platform/invoices/pay-multi/:token/public-config", async (req, reply) => {
    if (!hasCredentialsMasterKey()) {
      return reply.code(503).send({ error: "credential_crypto_unavailable" });
    }
    const { token } = req.params as { token: string };
    const loaded = await loadInvoicesForMultiPayToken(token);
    if ("error" in loaded) return reply.code(loaded.error === "invoice_not_found" ? 404 : 410).send({ error: loaded.error });
    const gateway = await resolveBillingGatewayConfig(loaded.parsed.tenantId, { forTokenizing: true });
    if (!gateway.ifieldsKey) {
      return reply.code(503).send({ error: "payment_gateway_not_configured" });
    }
    return {
      ifieldsKey: gateway.ifieldsKey,
      ifieldsVersion: "3.4.2602.2001",
      mode: gateway.mode || "sandbox",
      canPay: loaded.invoices.some(invoiceIsPayable),
      gatewayConfigured: gateway.configured,
      gatewayConfigSource: gateway.source,
      tenantOverridePresent: gateway.tenantOverridePresent,
    };
  });

  app.post("/billing/platform/invoices/pay-multi/:token/pay", async (req, reply) => {
    const { token } = req.params as { token: string };
    const loaded = await loadInvoicesForMultiPayToken(token);
    if ("error" in loaded) return reply.code(loaded.error === "invoice_not_found" ? 404 : 410).send({ error: loaded.error });
    const payable = loaded.invoices.filter(invoiceIsPayable);
    if (!payable.length) {
      return reply.code(400).send({ error: "invoice_already_paid" });
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

    const tenantId = loaded.parsed.tenantId;
    let adapter;
    try {
      adapter = await getBillingSolaAdapter(tenantId);
    } catch (e: any) {
      if (String(e?.message || e).includes("SOLA_NOT_ENABLED")) {
        return reply.code(503).send({ error: "payment_gateway_not_enabled" });
      }
      throw e;
    }

    if (input.billingEmail?.trim()) {
      await (db as any).tenantBillingSettings.update({
        where: { tenantId },
        data: { billingEmail: input.billingEmail.trim() },
      }).catch(() => null);
    }

    type MultiPayResult = {
      invoiceId: string;
      invoiceNumber: string | null;
      amountCents: number;
      outcome: "paid" | "declined" | "skipped_already_paid" | "skipped_period_covered" | "not_attempted" | "error";
      message?: string | null;
    };
    const results: MultiPayResult[] = [];
    const keepCard = input.saveCard || input.enableAutopay;

    // First invoice pays with the fresh card. The card is ALWAYS persisted at
    // this step (that is mechanically what lets invoices 2..n charge without
    // re-entering it) — but if the customer did not ask to keep it, the saved
    // card is deactivated the moment the run is over.
    const first = payable[0];
    let firstTx: any;
    try {
      firstTx = await chargeBillingInvoiceWithSut(
        first,
        {
          xSut: input.xSut,
          xExp: input.xExp,
          cardholderName: input.cardholderName,
          billingZip: input.billingZip,
        },
        {
          adapter,
          note: "combined_pay_link",
          persistPaymentMethod: true,
          makeDefault: input.enableAutopay || false,
          customerIdentity: `tenant:${tenantId}`,
          // Declined cards stay retryable forever — same rule as the
          // single-invoice page.
          allowRetry: true,
        },
      );
    } catch (e: any) {
      if (e?.code === "BILLING_LIVE_CHARGES_DISABLED") {
        return reply.code(503).send({ error: "billing_live_charges_disabled" });
      }
      if (e?.code === "CHARGE_IN_PROGRESS") {
        return reply.code(409).send({ error: "charge_in_progress", existingTransactionId: e?.existingTransaction?.id || null });
      }
      if (e?.code === "CARD_TOKENIZATION_FAILED") {
        return reply.code(402).send({ error: "card_tokenization_failed" });
      }
      throw e;
    }

    const firstApproved = firstTx?.status === "APPROVED";
    results.push({
      invoiceId: first.id,
      invoiceNumber: first.invoiceNumber,
      amountCents: Math.max(0, first.balanceDueCents ?? first.totalCents ?? 0),
      outcome: firstApproved ? "paid" : "declined",
      message: firstApproved ? null : firstTx?.responseMessage || null,
    });
    await logBillingEvent({
      tenantId,
      invoiceId: first.id,
      type: firstApproved ? "payment.public_pay_succeeded" : "payment.public_pay_declined",
      message: `Combined pay link payment for invoice ${first.invoiceNumber}`,
      metadata: { transactionId: firstTx?.id, combined: true, invoiceCount: payable.length },
    });

    const savedPaymentMethodId: string | null = (firstTx?.rawResponseSafeJson as any)?.savedPaymentMethodId || null;
    const rest = payable.slice(1);

    if (!firstApproved || !rest.length) {
      // A decline on the first charge means the card never verified — nothing
      // further is attempted, and nothing was saved.
      for (const inv of rest) {
        results.push({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          amountCents: Math.max(0, inv.balanceDueCents ?? inv.totalCents ?? 0),
          outcome: "not_attempted",
        });
      }
    } else if (!savedPaymentMethodId) {
      // Should not happen (persistPaymentMethod on an approved charge), but if
      // it does, the honest answer is "the first invoice is paid, the rest
      // were not attempted" — never a half-lie that everything went through.
      for (const inv of rest) {
        results.push({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          amountCents: Math.max(0, inv.balanceDueCents ?? inv.totalCents ?? 0),
          outcome: "not_attempted",
          message: "Card could not be reused — pay this invoice separately.",
        });
      }
    } else {
      const method = await (db as any).paymentMethod.findUnique({ where: { id: savedPaymentMethodId } });
      let stopCharging = false;
      for (const inv of rest) {
        const amountCents = Math.max(0, inv.balanceDueCents ?? inv.totalCents ?? 0);
        if (stopCharging || !method) {
          results.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, amountCents, outcome: "not_attempted" });
          continue;
        }
        try {
          const tx = await chargeBillingInvoice(inv, method, {
            adapter,
            note: "combined_pay_link",
            customerIdentity: `tenant:${tenantId}`,
            allowRetry: true,
          });
          const approved = tx?.status === "APPROVED";
          results.push({
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            amountCents,
            outcome: approved ? "paid" : "declined",
            message: approved ? null : tx?.responseMessage || null,
          });
          await logBillingEvent({
            tenantId,
            invoiceId: inv.id,
            type: approved ? "payment.public_pay_succeeded" : "payment.public_pay_declined",
            message: `Combined pay link payment for invoice ${inv.invoiceNumber}`,
            metadata: { transactionId: tx?.id, combined: true },
          });
          // One decline is enough — hammering a failing card across the rest
          // of the list only burns gateway attempts and risks velocity blocks.
          if (!approved) stopCharging = true;
        } catch (e: any) {
          if (e?.code === "INVOICE_ALREADY_PAID") {
            results.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, amountCents, outcome: "skipped_already_paid" });
          } else if (e?.code === "BILLING_PERIOD_ALREADY_PAID") {
            // The guard that stops a period being paid twice — honest skip.
            results.push({
              invoiceId: inv.id,
              invoiceNumber: inv.invoiceNumber,
              amountCents,
              outcome: "skipped_period_covered",
              message: `Already covered by paid invoice ${e?.paidInvoiceNumber || ""}`.trim(),
            });
          } else {
            results.push({
              invoiceId: inv.id,
              invoiceNumber: inv.invoiceNumber,
              amountCents,
              outcome: "error",
              message: "This invoice could not be charged — pay it separately.",
            });
            stopCharging = true;
          }
        }
      }
    }

    // Honor "don't keep my card": it was only saved to carry the run.
    if (savedPaymentMethodId && !keepCard) {
      await (db as any).paymentMethod.update({
        where: { id: savedPaymentMethodId },
        data: { active: false, isDefault: false },
      }).catch(() => null);
      await logBillingEvent({
        tenantId,
        type: "payment_method.removed",
        message: "Card used for a combined payment and not kept (customer's choice)",
        metadata: { paymentMethodId: savedPaymentMethodId, combined: true },
      });
    }
    if (savedPaymentMethodId && input.enableAutopay && firstApproved) {
      await (db as any).tenantBillingSettings.upsert({
        where: { tenantId },
        create: { tenantId, autoBillingEnabled: true, defaultPaymentMethodId: savedPaymentMethodId },
        update: { autoBillingEnabled: true, defaultPaymentMethodId: savedPaymentMethodId },
      }).catch(() => null);
    }

    const paidCount = results.filter((r) => r.outcome === "paid").length;
    const settled = results.every((r) => ["paid", "skipped_already_paid", "skipped_period_covered"].includes(r.outcome));
    return {
      ok: true,
      approved: paidCount > 0 && settled,
      allSettled: settled,
      paidCount,
      results,
    };
  });

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
            // A declined card must be retryable forever — the customer fixes
            // the card and tries again. The operation lock still replays an
            // APPROVED charge (no double-billing) and still 409s a charge
            // that is mid-flight; without this flag it also "replayed" old
            // DECLINEs, so every retry failed without reaching the gateway.
            allowRetry: true,
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
          // allowRetry: same reasoning as the saved-card branch above.
          { adapter, note: "public_pay_link", customerIdentity: `tenant:${invoice.tenantId}`, allowRetry: true },
        );
      }

      await logBillingEvent({
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        // "succeeded" used to be logged for declines too, which made the
        // timeline lie during forensics.
        type: transaction?.status === "APPROVED" ? "payment.public_pay_succeeded" : "payment.public_pay_declined",
        message: `Public pay link payment for invoice ${invoice.invoiceNumber}`,
        metadata: {
          transactionId: transaction?.id,
          saveCardRequested: saveCard,
          enableAutopayRequested: enableAutopay,
          onboarding: isOnboardingInvoice || undefined,
        },
      });

      // Journey: a decline on a sign-up invoice is the #1 place customers give
      // up — put it on the submission's timeline in plain English.
      if (isOnboardingInvoice && transaction?.status !== "APPROVED") {
        void (async () => {
          try {
            const sid = String((invoice.metadata as any)?.onboardingSubmissionId || "");
            if (!sid) return;
            const why = String(transaction?.responseMessage || "the card was declined").slice(0, 120);
            await (db as any).onboardingEvent.create({
              data: { submissionId: sid, type: "STATUS_CHANGED", message: `Card DECLINED (${why}) — they can retry` },
            });
          } catch { /* telemetry only */ }
        })();
      }

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
