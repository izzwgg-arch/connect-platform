import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { hasCredentialsMasterKey } from "@connect/security";
import {
  getBillingSolaAdapter,
  getBillingSolaAdapterForTokenizing,
  resolveBillingGatewayConfig,
  storeSolaPaymentMethod,
} from "./solaGateway";
import { billingLiveChargesDisabled, chargeBillingInvoice, chargeBillingInvoiceWithSut } from "./solaBillingPayments";
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
    const balanceDueCents = Math.max(0, invoice.balanceDueCents ?? invoice.totalCents ?? 0);
    const canPay = balanceDueCents > 0 && !["PAID", "VOID"].includes(invoice.status);
    const brand = resolveInvoiceEmailBranding(invoice.tenant?.billingSettings || {}, invoice.tenant?.name);
    return {
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
        description: li.description,
        quantity: li.quantity,
        unitAmountCents: li.unitAmountCents,
        amountCents: li.amountCents,
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

    try {
      let transaction: any;
      if (input.saveCard) {
        const tokenizing = await getBillingSolaAdapterForTokenizing(invoice.tenantId);
        const saveResp = await tokenizing.saveCardWithSut({
          sut: input.xSut,
          exp: input.xExp,
          cardholderName: input.cardholderName,
          zip: input.billingZip,
        });
        if (!saveResp.approved || !saveResp.xToken) {
          return reply.code(402).send({ error: "card_save_failed" });
        }
        const method = await storeSolaPaymentMethod({
          tenantId: invoice.tenantId,
          response: saveResp,
          cardholderName: input.cardholderName,
          billingZip: input.billingZip,
          makeDefault: input.enableAutopay || false,
        });
        if (input.enableAutopay) {
          await (db as any).tenantBillingSettings.update({
            where: { tenantId: invoice.tenantId },
            data: { autoBillingEnabled: true, defaultPaymentMethodId: method.id },
          }).catch(() => null);
        }
        transaction = await chargeBillingInvoice(invoice, method, {
          adapter,
          note: "public_pay_link_saved_card",
        });
      } else {
        transaction = await chargeBillingInvoiceWithSut(
          invoice,
          {
            xSut: input.xSut,
            xExp: input.xExp,
            cardholderName: input.cardholderName,
            billingZip: input.billingZip,
          },
          { adapter, note: "public_pay_link" },
        );
      }

      if (input.billingEmail?.trim()) {
        await (db as any).tenantBillingSettings.update({
          where: { tenantId: invoice.tenantId },
          data: { billingEmail: input.billingEmail.trim() },
        }).catch(() => null);
      }

      await logBillingEvent({
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        type: "payment.public_pay_succeeded",
        message: `Public pay link payment for invoice ${invoice.invoiceNumber}`,
        metadata: {
          transactionId: transaction?.id,
          saveCardRequested: input.saveCard,
          enableAutopayRequested: input.enableAutopay,
        },
      });

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
