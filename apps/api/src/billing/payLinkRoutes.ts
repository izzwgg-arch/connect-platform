import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { hasCredentialsMasterKey } from "@connect/security";
import { buildConnectBillingGatewayXInvoice } from "@connect/integrations";
import { getBillingSolaAdapter, resolveBillingGatewayConfig, storeSolaPaymentMethod } from "./solaGateway";
import { billingLiveChargesDisabled, solaProcessorUserMessage } from "./solaBillingPayments";
import { logBillingEvent, markBillingInvoicePaid } from "./invoiceEngine";
import { queueReceiptEmailOnce } from "./billingEmailLifecycle";
import { reserveBillingChargeOperation, updateBillingChargeOperationFromTransaction } from "./billingChargeOperations";
import { resolveInvoiceEmailBranding } from "./invoiceBranding";
import { publicInvoiceLines } from "./publicInvoiceView";
import { sendBillingInvoicePdf } from "./billingInvoicePdfAccess";
import {
  BILLING_PAY_LINK_TTL_MS,
  PAY_LINK_CODE_RE,
  computePayableSet,
  generatePayLinkCode,
  payLinkPublicUrl,
} from "./payLink";

type LoadedPayLink = {
  link: any;
  invoices: any[];
  payable: any[];
  settled: any[];
  totalDueCents: number;
  tenant: { name: string | null; billingSettings: any } | null;
};

async function loadPayLink(code: string): Promise<LoadedPayLink | { error: "pay_link_not_found" | "pay_link_expired" | "pay_link_voided" }> {
  if (!PAY_LINK_CODE_RE.test(String(code || "").toUpperCase())) return { error: "pay_link_not_found" };
  const link = await (db as any).billingPayLink.findUnique({
    where: { code: String(code).toUpperCase() },
    include: { tenant: { select: { name: true, billingSettings: true } } },
  });
  if (!link) return { error: "pay_link_not_found" };
  if (link.status === "VOID") return { error: "pay_link_voided" };
  if (link.status !== "COMPLETED" && link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
    if (link.status === "ACTIVE") {
      await (db as any).billingPayLink.update({ where: { id: link.id }, data: { status: "EXPIRED" } }).catch(() => null);
    }
    return { error: "pay_link_expired" };
  }
  const invoices = await (db as any).billingInvoice.findMany({
    where: { id: { in: link.invoiceIds || [] }, tenantId: link.tenantId },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  const { payable, settled, totalDueCents } = computePayableSet(invoices);
  return { link, invoices, payable, settled, totalDueCents, tenant: link.tenant };
}

function payLinkView(loaded: LoadedPayLink) {
  const { link, payable, settled, totalDueCents, tenant } = loaded;
  const brand = resolveInvoiceEmailBranding(tenant?.billingSettings || {}, tenant?.name);
  const toRow = (inv: any, alreadyPaid: boolean) => ({
    // The id is what the "open this invoice" link is built from. `loadPayLink`
    // has always fetched the line items and this row dropped them, so the page
    // had a total and nothing behind it.
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    status: inv.status,
    alreadyPaid,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    dueDate: inv.dueDate,
    issueDate: inv.issueDate,
    subtotalCents: Number(inv.subtotalCents ?? 0),
    taxCents: Number(inv.taxCents ?? 0),
    totalCents: inv.totalCents,
    balanceDueCents: Math.max(0, inv.balanceDueCents ?? inv.totalCents ?? 0),
    lineItems: publicInvoiceLines(inv),
  });
  return {
    code: link.code,
    companyName: brand.displayName || tenant?.name || "Connect Communications",
    linkStatus: link.status,
    currency: "USD",
    totalDueCents,
    canPay: link.status === "ACTIVE" && totalDueCents > 0 && payable.length > 0,
    invoices: [
      ...payable.map((inv: any) => toRow(inv, false)),
      ...settled.map((inv: any) => toRow(inv, true)),
    ],
  };
}

/** Registers public pay-link routes + the admin create route. */
export function registerBillingPayLinkRoutes(
  app: FastifyInstance,
  requirePlatformBilling: (req: FastifyRequest, reply: FastifyReply) => Promise<{ sub: string } | null>,
) {
  // ---- Admin: create a link -------------------------------------------------
  app.post("/admin/billing/pay-links", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const input = z.object({
      tenantId: z.string().min(1),
      invoiceIds: z.array(z.string().min(1)).min(1).max(50),
      ttlMs: z.number().int().positive().max(365 * 24 * 60 * 60 * 1000).optional(),
    }).parse(req.body || {});
    const invoices = await (db as any).billingInvoice.findMany({
      where: { id: { in: input.invoiceIds }, tenantId: input.tenantId },
    });
    if (invoices.length !== input.invoiceIds.length) {
      return reply.code(400).send({ error: "invoice_not_found_for_tenant" });
    }
    const { payable, totalDueCents } = computePayableSet(invoices);
    if (payable.length === 0 || totalDueCents <= 0) {
      return reply.code(400).send({ error: "no_balance_due" });
    }
    let link: any = null;
    for (let attempt = 0; attempt < 5 && !link; attempt++) {
      const code = generatePayLinkCode();
      link = await (db as any).billingPayLink.create({
        data: {
          code,
          tenantId: input.tenantId,
          invoiceIds: input.invoiceIds,
          status: "ACTIVE",
          expiresAt: new Date(Date.now() + (input.ttlMs ?? BILLING_PAY_LINK_TTL_MS)),
          createdByUserId: u.sub,
        },
      }).catch((err: any) => {
        if (err?.code === "P2002") return null; // code collision — regenerate
        throw err;
      });
    }
    if (!link) return reply.code(500).send({ error: "pay_link_code_generation_failed" });
    await logBillingEvent({
      tenantId: input.tenantId,
      type: "pay_link.created",
      message: `Pay link ${link.code} for ${input.invoiceIds.length} invoice(s)`,
      metadata: { payLinkId: link.id, code: link.code, invoiceIds: input.invoiceIds, totalDueCents, createdByUserId: u.sub },
    });
    return { id: link.id, code: link.code, url: payLinkPublicUrl(link.code), expiresAt: link.expiresAt, totalDueCents };
  });

  // ---- Public: view ---------------------------------------------------------
  app.get("/billing/platform/pay-links/:code", async (req, reply) => {
    const { code } = req.params as { code: string };
    const loaded = await loadPayLink(code);
    if ("error" in loaded) {
      return reply.code(loaded.error === "pay_link_not_found" ? 404 : 410).send({ error: loaded.error });
    }
    return payLinkView(loaded);
  });

  // ---- Public: open / download one of the link's invoices --------------------
  // Scoped by the link: the code already proves the holder may see exactly
  // these invoices, and an id the link does not name is a 404.
  app.get("/billing/platform/pay-links/:code/invoice/:invoiceId/pdf", async (req, reply) => {
    const { code, invoiceId } = req.params as { code: string; invoiceId: string };
    const loaded = await loadPayLink(code);
    if ("error" in loaded) {
      return reply.code(loaded.error === "pay_link_not_found" ? 404 : 410).send({ error: loaded.error });
    }
    if (!(loaded.link.invoiceIds || []).includes(invoiceId)) {
      return reply.code(404).send({ error: "invoice_not_found" });
    }
    const invoice = await (db as any).billingInvoice.findFirst({
      where: { id: invoiceId, tenantId: loaded.link.tenantId },
      include: { lineItems: { orderBy: { createdAt: "asc" } }, tenant: { include: { billingSettings: true } } },
    });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    const { download } = req.query as { download?: string };
    return sendBillingInvoicePdf(reply, invoice, { download: download === "1" });
  });

  // ---- Public: gateway config -----------------------------------------------
  app.get("/billing/platform/pay-links/:code/public-config", async (req, reply) => {
    if (!hasCredentialsMasterKey()) {
      return reply.code(503).send({ error: "credential_crypto_unavailable" });
    }
    const { code } = req.params as { code: string };
    const loaded = await loadPayLink(code);
    if ("error" in loaded) {
      return reply.code(loaded.error === "pay_link_not_found" ? 404 : 410).send({ error: loaded.error });
    }
    const gateway = await resolveBillingGatewayConfig(loaded.link.tenantId, { forTokenizing: true });
    if (!gateway.ifieldsKey) {
      return reply.code(503).send({ error: "payment_gateway_not_configured" });
    }
    return {
      ifieldsKey: gateway.ifieldsKey,
      ifieldsVersion: "3.4.2602.2001",
      mode: gateway.mode || "sandbox",
      canPay: loaded.link.status === "ACTIVE" && loaded.totalDueCents > 0,
      gatewayConfigured: gateway.configured,
      gatewayConfigSource: gateway.source,
      tenantOverridePresent: gateway.tenantOverridePresent,
    };
  });

  // ---- Public: pay (ONE combined charge, per-invoice fan-out) -----------------
  app.post("/billing/platform/pay-links/:code/pay", async (req, reply) => {
    const { code } = req.params as { code: string };
    const loaded = await loadPayLink(code);
    if ("error" in loaded) {
      return reply.code(loaded.error === "pay_link_not_found" ? 404 : 410).send({ error: loaded.error });
    }
    const { link, payable, totalDueCents } = loaded;
    if (link.status === "COMPLETED") return reply.code(400).send({ error: "pay_link_already_paid" });
    if (link.status !== "ACTIVE") return reply.code(410).send({ error: "pay_link_expired" });
    if (payable.length === 0 || totalDueCents <= 0) {
      return reply.code(400).send({ error: "no_balance_due" });
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
      adapter = await getBillingSolaAdapter(link.tenantId);
    } catch (e: any) {
      if (String(e?.message || e).includes("SOLA_NOT_ENABLED")) {
        return reply.code(503).send({ error: "payment_gateway_not_enabled" });
      }
      throw e;
    }

    // ⛔ Do NOT persist billingEmail from this UNAUTHENTICATED pay-link route: a
    // link holder could otherwise redirect the tenant's future invoice/receipt
    // emails to an attacker address. Accepted for compatibility, not persisted.

    // --- Idempotency: one operation per (link, amount); retry allowed after decline.
    const customerKey = `tenant:${link.tenantId}`;
    const baseKey = `paylink:${link.id}:${totalDueCents}:new_card`;
    let operation;
    try {
      operation = await reserveBillingChargeOperation({
        tenantId: link.tenantId,
        businessKey: baseKey,
        operationType: "PAY_LINK_PAYMENT",
        chargeType: "new_card",
        amountCents: totalDueCents,
        invoiceId: payable[0].id,
        customerKey,
        metadata: { payLinkId: link.id, code: link.code, invoiceIds: payable.map((i: any) => i.id) },
        allowRetry: true,
      });
    } catch (e: any) {
      if (e?.code === "CHARGE_IN_PROGRESS") {
        return reply.code(409).send({ error: "charge_in_progress", existingTransactionId: e?.existingTransaction?.id || null });
      }
      throw e;
    }
    if (operation.kind === "replay" && (operation as any).transaction?.status === "APPROVED") {
      return { ok: true, approved: true, transactionId: (operation as any).transaction.id, alreadyPaid: true };
    }

    // --- Attempt reservation: parent PENDING transaction (invoiceId null = combined charge).
    const prefix = `${baseKey}:attempt:`;
    const prior = await (db as any).paymentTransaction.findMany({
      where: { tenantId: link.tenantId, idempotencyKey: { startsWith: prefix } },
      orderBy: { createdAt: "asc" },
    });
    const priorApproved = prior.find((tx: any) => tx.status === "APPROVED");
    if (priorApproved) return { ok: true, approved: true, transactionId: priorApproved.id, alreadyPaid: true };
    if (prior.some((tx: any) => tx.status === "PENDING")) {
      return reply.code(409).send({ error: "charge_in_progress" });
    }
    const idempotencyKey = `${prefix}${prior.length + 1}`;
    let parentTx: any;
    try {
      parentTx = await (db as any).paymentTransaction.create({
        data: {
          tenantId: link.tenantId,
          invoiceId: null,
          billingChargeOperationId: operation.operation.id,
          amountCents: totalDueCents,
          status: "PENDING",
          idempotencyKey,
          source: "GATEWAY",
        },
      });
    } catch (err: any) {
      if (err?.code === "P2002") return reply.code(409).send({ error: "charge_in_progress" });
      throw err;
    }

    const fail = async (status: "DECLINED" | "ERROR", message: string, raw?: any) => {
      parentTx = await (db as any).paymentTransaction.update({
        where: { id: parentTx.id },
        data: { status, responseMessage: message, rawResponseSafeJson: raw ?? { message } },
      }).catch(() => parentTx);
      await updateBillingChargeOperationFromTransaction(operation.operation.id, { ...parentTx, invoiceId: payable[0].id });
      await logBillingEvent({
        tenantId: link.tenantId,
        type: "pay_link.payment_failed",
        message: `Pay link ${link.code}: ${message}`,
        metadata: { payLinkId: link.id, transactionId: parentTx.id, status },
      });
    };

    // --- Tokenize card (cc:save with SUT), then ONE combined cc:sale.
    const saveResp = await adapter.saveCardWithSut({
      sut: input.xSut,
      exp: input.xExp || undefined,
      cardholderName: input.cardholderName || undefined,
      zip: input.billingZip || undefined,
    });
    if (!saveResp.approved || !saveResp.xToken) {
      await fail("ERROR", saveResp.xError || saveResp.xStatus || "card_tokenization_failed", saveResp.safePayload);
      return reply.code(402).send({ error: "card_tokenization_failed" });
    }
    const cardBrand = saveResp.xCardType || null;
    const cardLast4 = (saveResp.xMaskedCardNumber || "").replace(/\D/g, "").slice(-4) || null;
    const cardLabel = cardLast4 ? `${cardBrand || "Card"} ending ${cardLast4}` : null;

    await logBillingEvent({
      tenantId: link.tenantId,
      type: "payment.charge_attempt",
      message: `Pay link ${link.code}: one-time card charge for ${payable.length} invoice(s)`,
      metadata: { payLinkId: link.id, amountCents: totalDueCents, invoiceIds: payable.map((i: any) => i.id), ephemeral: true },
    });

    // xInvoice ref uses the link id — deliberately NOT an invoice id, so webhook
    // reconciliation cannot mis-apply the combined amount to a single invoice.
    const gatewayXInvoice = buildConnectBillingGatewayXInvoice(link.tenantId, link.id, `PAYLINK-${link.code}`, idempotencyKey);
    let response;
    try {
      response = await adapter.chargeToken({
        token: saveResp.xToken,
        amountCents: totalDueCents,
        gatewayXInvoice,
        idempotencyKey,
        recurringIndicator: "Single",
      });
    } catch (err: any) {
      if (err?.code === "BILLING_LIVE_CHARGES_DISABLED") {
        await fail("ERROR", "billing_live_charges_disabled");
        return reply.code(503).send({ error: "billing_live_charges_disabled" });
      }
      await fail("ERROR", err?.message || "gateway_charge_failed");
      return reply.code(502).send({ error: "gateway_charge_failed" });
    }

    const processorRef =
      response.xRefNum !== undefined && response.xRefNum !== null && String(response.xRefNum).trim() !== ""
        ? String(response.xRefNum)
        : null;

    if (!response.approved) {
      await fail(
        response.status === "DECLINED" ? "DECLINED" : "ERROR",
        response.xError || response.xStatus || "card_declined",
        { ...response.safePayload, cardBrand, cardLast4, ephemeral: true },
      );
      return reply.code(402).send({
        error: "card_declined",
        message: solaProcessorUserMessage(response),
        transactionId: parentTx.id,
      });
    }

    // --- APPROVED: finalize parent, then fan out per invoice.
    const allocations = payable.map((inv: any) => ({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      amountCents: Math.max(0, inv.balanceDueCents ?? inv.totalCents ?? 0),
    }));
    parentTx = await (db as any).paymentTransaction.update({
      where: { id: parentTx.id },
      data: {
        status: "APPROVED",
        processorTransactionId: processorRef,
        responseCode: response.xResult,
        responseMessage: response.xError || response.xStatus,
        rawResponseSafeJson: {
          ...response.safePayload,
          cardBrand,
          cardLast4,
          ephemeral: true,
          payLink: { id: link.id, code: link.code, allocations },
        },
      },
    });
    await updateBillingChargeOperationFromTransaction(operation.operation.id, { ...parentTx, invoiceId: payable[0].id });

    const paidInvoiceNumbers: string[] = [];
    for (const inv of payable) {
      const allocation = Math.max(0, inv.balanceDueCents ?? inv.totalCents ?? 0);
      // Per-invoice allocation transaction — distinct id so the existing
      // per-invoice receipt lifecycle (deduped by transactionId) fans out one
      // receipt email PER INVOICE.
      const allocTx = await (db as any).paymentTransaction.create({
        data: {
          tenantId: link.tenantId,
          invoiceId: inv.id,
          billingChargeOperationId: operation.operation.id,
          amountCents: allocation,
          status: "APPROVED",
          source: "GATEWAY",
          responseCode: response.xResult,
          responseMessage: `Pay link ${link.code} allocation (parent ${parentTx.id})`,
          rawResponseSafeJson: {
            allocation: true,
            payLink: { id: link.id, code: link.code },
            parentTransactionId: parentTx.id,
            processorRef,
            cardBrand,
            cardLast4,
          },
        },
      });
      await markBillingInvoicePaid(inv.id, undefined, { note: `pay_link:${link.code}` });
      await queueReceiptEmailOnce({
        tenantId: link.tenantId,
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        totalCents: inv.totalCents,
        transactionId: allocTx.id,
        cardLabel,
        paidViaAutopay: false,
      });
      await logBillingEvent({
        tenantId: link.tenantId,
        invoiceId: inv.id,
        type: "payment.public_pay_succeeded",
        message: `Pay link ${link.code} payment for invoice ${inv.invoiceNumber}`,
        metadata: { payLinkId: link.id, transactionId: allocTx.id, parentTransactionId: parentTx.id, amountCents: allocation },
      });
      paidInvoiceNumbers.push(inv.invoiceNumber);
    }

    await (db as any).billingPayLink.update({
      where: { id: link.id },
      data: { status: "COMPLETED", paidTransactionId: parentTx.id, completedAt: new Date() },
    });
    await logBillingEvent({
      tenantId: link.tenantId,
      type: "pay_link.completed",
      message: `Pay link ${link.code} paid — ${paidInvoiceNumbers.join(", ")}`,
      metadata: { payLinkId: link.id, transactionId: parentTx.id, amountCents: totalDueCents, invoiceNumbers: paidInvoiceNumbers },
    });

    if (input.saveCard && saveResp.xToken) {
      try {
        const method = await storeSolaPaymentMethod({
          tenantId: link.tenantId,
          response: saveResp,
          cardholderName: input.cardholderName || undefined,
          billingZip: input.billingZip || undefined,
          makeDefault: input.enableAutopay || false,
        });
        if (input.enableAutopay) {
          await (db as any).tenantBillingSettings.update({
            where: { tenantId: link.tenantId },
            data: { autoBillingEnabled: true, defaultPaymentMethodId: method.id },
          }).catch(() => null);
        }
        await logBillingEvent({
          tenantId: link.tenantId,
          type: "payment_method.saved",
          message: "Card saved after pay link charge",
          metadata: { paymentMethodId: method.id, brand: method.brand, last4: method.last4, payLinkId: link.id },
        });
      } catch {
        // Card vaulting is best-effort — the payment itself already succeeded.
      }
    }

    return {
      ok: true,
      approved: true,
      transactionId: parentTx.id,
      paidInvoices: paidInvoiceNumbers,
      amountCents: totalDueCents,
    };
  });
}
