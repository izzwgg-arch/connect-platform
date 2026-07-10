import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { hasCredentialsMasterKey } from "@connect/security";
import {
  getBillingSolaAdapter,
  resolveBillingGatewayConfig,
} from "./solaGateway";
import { billingLiveChargesDisabled, chargeBillingInvoiceWithSut, chargeBillingInvoice } from "./solaBillingPayments";
import { verifyBillingInvoicePayToken, verifyTenantPayAllToken } from "./billingPayToken";
import { resolveTenantFromPayAllCode } from "./billingEmailLifecycle";
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

async function loadUnpaidInvoicesForPayAllToken(token: string) {
  const parsed = verifyTenantPayAllToken(token);
  const tenantId = parsed?.tenantId ?? (await resolveTenantFromPayAllCode(token));
  if (!tenantId) return { error: "pay_all_token_invalid" as const, code: 410 as const };
  const tenant = await (db as any).tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, billingSettings: true },
  });
  if (!tenant) return { error: "tenant_not_found" as const, code: 404 as const };
  const raw = await (db as any).billingInvoice.findMany({
    where: { tenantId, status: { notIn: ["PAID", "VOID"] }, billingProfileId: null },
    orderBy: { periodStart: "asc" },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  const invoices = raw.filter((inv: any) => Math.max(0, inv.balanceDueCents ?? inv.totalCents ?? 0) > 0);
  return { tenantId, tenant, invoices };
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

    try {
      let transaction: any;
      if (input.saveCard) {
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
            makeDefault: input.enableAutopay || false,
            customerIdentity: `tenant:${invoice.tenantId}`,
          },
        );
        const savedPaymentMethodId = (transaction?.rawResponseSafeJson as any)?.savedPaymentMethodId;
        if (input.enableAutopay) {
          await (db as any).tenantBillingSettings.update({
            where: { tenantId: invoice.tenantId },
            data: { autoBillingEnabled: true, ...(savedPaymentMethodId ? { defaultPaymentMethodId: savedPaymentMethodId } : {}) },
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

  // -- Pay-all: pay ALL of a tenant's unpaid invoices via ONE link (cowork) ----
  app.get("/billing/platform/pay-all/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const loaded = await loadUnpaidInvoicesForPayAllToken(token);
    if ("error" in loaded) return reply.code(loaded.code).send({ error: loaded.error });
    const { tenant, invoices } = loaded;
    const totalDueCents = invoices.reduce((sum: number, inv: any) => sum + Math.max(0, inv.balanceDueCents ?? inv.totalCents ?? 0), 0);
    const brand = resolveInvoiceEmailBranding(tenant?.billingSettings || {}, tenant?.name);
    return {
      companyName: brand.displayName || tenant?.name || "Connect Communications",
      currency: "USD",
      totalDueCents,
      invoiceCount: invoices.length,
      canPay: totalDueCents > 0,
      invoices: invoices.map((inv: any) => ({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        totalCents: inv.totalCents,
        balanceDueCents: Math.max(0, inv.balanceDueCents ?? inv.totalCents ?? 0),
        dueDate: inv.dueDate,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
      })),
    };
  });

  app.get("/billing/platform/pay-all/:token/public-config", async (req, reply) => {
    if (!hasCredentialsMasterKey()) return reply.code(503).send({ error: "credential_crypto_unavailable" });
    const { token } = req.params as { token: string };
    const loaded = await loadUnpaidInvoicesForPayAllToken(token);
    if ("error" in loaded) return reply.code(loaded.code).send({ error: loaded.error });
    const gateway = await resolveBillingGatewayConfig(loaded.tenantId, { forTokenizing: true });
    if (!gateway.ifieldsKey) return reply.code(503).send({ error: "payment_gateway_not_configured" });
    const totalDueCents = loaded.invoices.reduce((sum: number, inv: any) => sum + Math.max(0, inv.balanceDueCents ?? inv.totalCents ?? 0), 0);
    return {
      ifieldsKey: gateway.ifieldsKey,
      ifieldsVersion: "3.4.2602.2001",
      mode: gateway.mode || "sandbox",
      canPay: totalDueCents > 0,
      gatewayConfigured: gateway.configured,
    };
  });

  app.post("/billing/platform/pay-all/:token/pay", async (req, reply) => {
    const { token } = req.params as { token: string };
    const loaded = await loadUnpaidInvoicesForPayAllToken(token);
    if ("error" in loaded) return reply.code(loaded.code).send({ error: loaded.error });
    const { tenantId, invoices } = loaded;
    if (invoices.length === 0) return { ok: true, nothingDue: true, results: [] };
    if (billingLiveChargesDisabled()) return reply.code(503).send({ error: "billing_live_charges_disabled" });

    const input = z.object({
      xSut: z.string().min(8),
      xExp: z.string().min(4).max(4).optional(),
      cardholderName: z.string().max(120).optional(),
      billingZip: z.string().max(20).optional(),
      billingEmail: z.string().email().max(200).optional(),
    }).parse(req.body || {});

    let adapter;
    try {
      adapter = await getBillingSolaAdapter(tenantId);
    } catch (e: any) {
      if (String(e?.message || e).includes("SOLA_NOT_ENABLED")) return reply.code(503).send({ error: "payment_gateway_not_enabled" });
      throw e;
    }

    if (input.billingEmail?.trim()) {
      await (db as any).tenantBillingSettings.update({ where: { tenantId }, data: { billingEmail: input.billingEmail.trim() } }).catch(() => null);
    }

    const cardData = { xSut: input.xSut, xExp: input.xExp, cardholderName: input.cardholderName, billingZip: input.billingZip };
    const results: any[] = [];
    let method: any = null;
    for (let i = 0; i < invoices.length; i++) {
      const inv = invoices[i];
      try {
        let tx: any;
        if (i === 0) {
          tx = await chargeBillingInvoiceWithSut(inv, cardData, {
            adapter,
            note: "pay_all_link",
            persistPaymentMethod: invoices.length > 1,
            customerIdentity: `tenant:${tenantId}`,
          });
          const savedId = (tx?.rawResponseSafeJson as any)?.savedPaymentMethodId;
          if (savedId) method = await (db as any).paymentMethod.findUnique({ where: { id: savedId } });
        } else if (method) {
          tx = await chargeBillingInvoice(inv, method, { adapter, note: "pay_all_link", customerIdentity: `tenant:${tenantId}` });
        } else {
          results.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, error: "card_not_saved_for_remaining" });
          continue;
        }
        results.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, approved: tx?.status === "APPROVED", transactionId: tx?.id });
      } catch (e: any) {
        results.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, error: e?.message ? String(e.message) : "charge_failed" });
      }
    }
    const paidCount = results.filter((r) => r.approved).length;
    await logBillingEvent({
      tenantId,
      type: "payment.pay_all_link_submitted",
      message: `Pay-all link: ${paidCount}/${invoices.length} invoices paid`,
      metadata: { results },
    }).catch(() => null);
    return { ok: true, paidCount, invoiceCount: invoices.length, results };
  });
}
