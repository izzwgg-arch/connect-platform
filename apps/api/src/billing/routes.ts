import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { buildBillingInvoicePreview, createBillingInvoice, ensureTenantBillingSettings, logBillingEvent, markBillingInvoicePaid, monthBounds } from "./invoiceEngine";
import { calculateTenantBillingUsage } from "./usage";
import { getBillingSolaAdapter, storeSolaPaymentMethod, decryptPaymentToken } from "./solaGateway";
import { invoiceReadyEmail, paymentFailedEmail, paymentReceiptEmail } from "./emailTemplates";
import { renderBillingInvoicePdf } from "./pdf";

type BillingUser = {
  sub: string;
  tenantId: string;
  email?: string;
  role?: string;
};

function user(req: any): BillingUser {
  return req.user as BillingUser;
}

function isSuperAdmin(u: BillingUser): boolean {
  return u.role === "SUPER_ADMIN";
}

function canTenantBilling(u: BillingUser): boolean {
  return ["SUPER_ADMIN", "ADMIN", "BILLING"].includes(String(u.role || "USER"));
}

async function requireTenantBilling(req: any, reply: any): Promise<BillingUser | null> {
  const u = user(req);
  if (!canTenantBilling(u)) {
    reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return u;
}

async function requirePlatformBilling(req: any, reply: any): Promise<BillingUser | null> {
  const u = user(req);
  if (!isSuperAdmin(u)) {
    reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return u;
}

function publicPortalBase(): string {
  return process.env.PUBLIC_PORTAL_URL || "https://app.connectcomunications.com";
}

async function queueBillingEmail(input: { tenantId: string; to: string; type: string; subject: string; html: string; text: string; invoiceId?: string }) {
  return (db as any).emailJob.create({
    data: {
      tenantId: input.tenantId,
      invoiceId: null,
      type: input.type,
      toEmail: input.to,
      subject: input.subject,
      htmlBody: input.html,
      textBody: input.text,
    },
  });
}

export async function registerBillingRoutes(app: FastifyInstance) {
  app.get("/billing/settings", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    return ensureTenantBillingSettings(u.tenantId);
  });

  app.get("/billing/usage/current", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    const settings = await ensureTenantBillingSettings(u.tenantId);
    return calculateTenantBillingUsage(u.tenantId, settings);
  });

  app.get("/billing/platform/invoices", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    return (db as any).billingInvoice.findMany({
      where: { tenantId: u.tenantId },
      include: { lineItems: true, transactions: { orderBy: { createdAt: "desc" }, take: 5 } },
      orderBy: { createdAt: "desc" },
    });
  });

  app.get("/billing/platform/invoices/:id", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const invoice = await (db as any).billingInvoice.findFirst({
      where: { id, tenantId: u.tenantId },
      include: { lineItems: true, transactions: { orderBy: { createdAt: "desc" } }, events: { orderBy: { createdAt: "asc" } }, tenant: true },
    });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    return invoice;
  });

  app.get("/billing/platform/invoices/:id/pdf", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const invoice = await (db as any).billingInvoice.findFirst({
      where: { id, tenantId: u.tenantId },
      include: { lineItems: true, tenant: true },
    });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    const pdf = await renderBillingInvoicePdf(invoice);
    reply.header("content-type", "application/pdf");
    reply.header("content-disposition", `inline; filename="${invoice.invoiceNumber}.pdf"`);
    return reply.send(pdf);
  });

  app.post("/billing/platform/invoices/:id/pay", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const invoice = await (db as any).billingInvoice.findFirst({ where: { id, tenantId: u.tenantId } });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    if (invoice.status === "PAID") return reply.code(400).send({ error: "invoice_already_paid" });
    const settings = await ensureTenantBillingSettings(u.tenantId);
    const method = settings.defaultPaymentMethodId
      ? await (db as any).paymentMethod.findFirst({ where: { id: settings.defaultPaymentMethodId, tenantId: u.tenantId, active: true } })
      : await (db as any).paymentMethod.findFirst({ where: { tenantId: u.tenantId, active: true, isDefault: true } });
    if (!method) return reply.code(400).send({ error: "payment_method_required" });

    const transaction = await chargeInvoice(invoice, method);
    return { invoice: await (db as any).billingInvoice.findUnique({ where: { id } }), transaction };
  });

  app.get("/billing/payment-methods", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    return (db as any).paymentMethod.findMany({
      where: { tenantId: u.tenantId, active: true },
      select: { id: true, brand: true, last4: true, expMonth: true, expYear: true, cardholderName: true, billingZip: true, isDefault: true, lastUsedAt: true, createdAt: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    });
  });

  app.post("/billing/payment-methods/sola/save", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    const input = z.object({
      xSut: z.string().min(8).optional(),
      xTokenInput: z.string().min(8).optional(),
      cardholderName: z.string().optional(),
      billingZip: z.string().optional(),
      makeDefault: z.boolean().default(true),
    }).parse(req.body || {});
    if (!input.xSut && !input.xTokenInput) return reply.code(400).send({ error: "sola_token_required" });
    const adapter = await getBillingSolaAdapter(u.tenantId);
    const response = input.xSut
      ? await adapter.saveCardWithSut({ sut: input.xSut, cardholderName: input.cardholderName, zip: input.billingZip })
      : await adapter.saveCardWithTokenInput({ tokenInput: input.xTokenInput, cardholderName: input.cardholderName, zip: input.billingZip });
    if (!response.approved) return reply.code(402).send({ error: "card_save_failed", response });
    const method = await storeSolaPaymentMethod({
      tenantId: u.tenantId,
      response,
      cardholderName: input.cardholderName,
      billingZip: input.billingZip,
      makeDefault: input.makeDefault,
    });
    await logBillingEvent({ tenantId: u.tenantId, type: "payment_method.saved", metadata: { paymentMethodId: method.id, brand: method.brand, last4: method.last4 } });
    return { id: method.id, brand: method.brand, last4: method.last4, expMonth: method.expMonth, expYear: method.expYear, isDefault: method.isDefault };
  });

  app.post("/billing/payment-methods/:id/default", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const method = await (db as any).paymentMethod.findFirst({ where: { id, tenantId: u.tenantId, active: true } });
    if (!method) return reply.code(404).send({ error: "payment_method_not_found" });
    await (db as any).paymentMethod.updateMany({ where: { tenantId: u.tenantId }, data: { isDefault: false } });
    await (db as any).paymentMethod.update({ where: { id }, data: { isDefault: true } });
    await (db as any).tenantBillingSettings.upsert({
      where: { tenantId: u.tenantId },
      create: { tenantId: u.tenantId, defaultPaymentMethodId: id },
      update: { defaultPaymentMethodId: id },
    });
    return { ok: true };
  });

  app.delete("/billing/payment-methods/:id", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    await (db as any).paymentMethod.updateMany({ where: { id, tenantId: u.tenantId }, data: { active: false, isDefault: false } });
    return { ok: true };
  });

  app.get("/admin/billing/overview", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const [invoices, tenantsWithoutCards] = await Promise.all([
      (db as any).billingInvoice.findMany({ where: { status: { in: ["OPEN", "FAILED", "OVERDUE", "PAID"] } } }),
      (db as any).tenant.count({ where: { paymentMethods: { none: { active: true } } } }),
    ]);
    return {
      mrrCents: invoices.filter((i: any) => i.status === "PAID").reduce((sum: number, i: any) => sum + i.totalCents, 0),
      openCents: invoices.filter((i: any) => ["OPEN", "FAILED", "OVERDUE"].includes(i.status)).reduce((sum: number, i: any) => sum + i.balanceDueCents, 0),
      counts: {
        paid: invoices.filter((i: any) => i.status === "PAID").length,
        open: invoices.filter((i: any) => i.status === "OPEN").length,
        failed: invoices.filter((i: any) => i.status === "FAILED").length,
        overdue: invoices.filter((i: any) => i.status === "OVERDUE").length,
        tenantsWithoutCards,
      },
    };
  });

  app.get("/admin/billing/platform/tenants", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const tenants = await (db as any).tenant.findMany({
      include: { billingSettings: true, paymentMethods: { where: { active: true }, select: { id: true, brand: true, last4: true, isDefault: true } }, billingInvoices: { orderBy: { createdAt: "desc" }, take: 3 } },
      orderBy: { name: "asc" },
    });
    return tenants.map((tenant: any) => ({
      id: tenant.id,
      name: tenant.name,
      billingSettings: tenant.billingSettings,
      paymentMethods: tenant.paymentMethods,
      invoices: tenant.billingInvoices,
      balanceDueCents: tenant.billingInvoices.reduce((sum: number, invoice: any) => sum + (invoice.balanceDueCents || 0), 0),
    }));
  });

  app.get("/admin/billing/tenants/:tenantId/settings", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    return ensureTenantBillingSettings(tenantId);
  });

  app.put("/admin/billing/tenants/:tenantId/settings", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const input = z.object({
      extensionPriceCents: z.number().int().nonnegative().optional(),
      additionalPhoneNumberPriceCents: z.number().int().nonnegative().optional(),
      smsPriceCents: z.number().int().nonnegative().optional(),
      firstPhoneNumberFree: z.boolean().optional(),
      smsBillingEnabled: z.boolean().optional(),
      taxEnabled: z.boolean().optional(),
      taxProfileId: z.string().nullable().optional(),
      autoBillingEnabled: z.boolean().optional(),
      billingDayOfMonth: z.number().int().min(1).max(28).optional(),
      paymentTermsDays: z.number().int().min(0).max(90).optional(),
      billingEmail: z.string().email().nullable().optional(),
      billingAddress: z.any().optional(),
      serviceAddress: z.any().optional(),
    }).parse(req.body || {});
    return (db as any).tenantBillingSettings.upsert({ where: { tenantId }, create: { tenantId, ...input }, update: input });
  });

  app.post("/admin/billing/tenants/:tenantId/invoices/preview", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    return buildBillingInvoicePreview({ tenantId });
  });

  app.post("/admin/billing/tenants/:tenantId/invoices", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const invoice = await createBillingInvoice({ tenantId, status: "OPEN" });
    return invoice;
  });

  app.post("/admin/billing/invoices/:id/send", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const invoice = await (db as any).billingInvoice.findUnique({ where: { id }, include: { tenant: { include: { billingSettings: true } } } });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    const to = invoice.tenant.billingSettings?.billingEmail || u.email;
    if (!to) return reply.code(400).send({ error: "billing_email_required" });
    const template = invoiceReadyEmail({ invoiceNumber: invoice.invoiceNumber, totalCents: invoice.totalCents, dueDate: invoice.dueDate, invoiceUrl: `${publicPortalBase()}/billing/invoices/${invoice.id}` });
    await queueBillingEmail({ tenantId: invoice.tenantId, invoiceId: invoice.id, to, type: "BILLING_INVOICE_READY", subject: template.subject, html: template.html, text: template.text });
    await (db as any).billingInvoice.update({ where: { id }, data: { lastEmailStatus: "QUEUED", lastEmailedAt: new Date(), status: invoice.status === "DRAFT" ? "OPEN" : invoice.status } });
    await logBillingEvent({ tenantId: invoice.tenantId, invoiceId: id, type: "invoice.email_queued", metadata: { to } });
    return { ok: true };
  });

  app.post("/admin/billing/invoices/:id/void", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const invoice = await (db as any).billingInvoice.findUnique({ where: { id } });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    if (invoice.status === "PAID") return reply.code(400).send({ error: "invoice_already_paid" });
    const updated = await (db as any).billingInvoice.update({ where: { id }, data: { status: "VOID", voidedAt: new Date(), balanceDueCents: 0 } });
    await logBillingEvent({ tenantId: invoice.tenantId, invoiceId: id, type: "invoice.voided" });
    return updated;
  });

  app.post("/admin/billing/invoices/:id/mark-paid", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    return markBillingInvoicePaid(id);
  });

  app.post("/admin/billing/invoices/:id/retry-payment", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const invoice = await (db as any).billingInvoice.findUnique({ where: { id }, include: { tenant: { include: { billingSettings: true } } } });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    const methodId = invoice.paymentMethodId || invoice.tenant.billingSettings?.defaultPaymentMethodId;
    const method = methodId ? await (db as any).paymentMethod.findUnique({ where: { id: methodId } }) : null;
    if (!method) return reply.code(400).send({ error: "payment_method_required" });
    return chargeInvoice(invoice, method);
  });

  app.get("/admin/billing/tax-profiles", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    return (db as any).taxProfile.findMany({ orderBy: [{ state: "asc" }, { county: "asc" }] });
  });

  app.post("/admin/billing/tax-profiles", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const input = taxProfileInput().parse(req.body || {});
    return (db as any).taxProfile.create({ data: input });
  });

  app.put("/admin/billing/tax-profiles/:id", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const input = taxProfileInput().partial().parse(req.body || {});
    return (db as any).taxProfile.update({ where: { id }, data: input });
  });

  app.post("/admin/billing/runs/monthly", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const input = z.object({ dryRun: z.boolean().default(true), tenantId: z.string().optional() }).parse(req.body || {});
    const { periodStart, periodEnd } = monthBounds();
    const run = await (db as any).billingRun.create({ data: { tenantId: input.tenantId || null, periodStart, periodEnd, dryRun: input.dryRun } });
    const tenants = await (db as any).tenant.findMany({
      where: input.tenantId ? { id: input.tenantId } : { billingSettings: { autoBillingEnabled: true } },
      include: { billingSettings: true },
    });
    const results = [];
    for (const tenant of tenants) {
      const preview = await buildBillingInvoicePreview({ tenantId: tenant.id, periodStart, periodEnd });
      if (input.dryRun) {
        results.push({ tenantId: tenant.id, totalCents: preview.totalCents, dryRun: true });
        continue;
      }
      const invoice = await createBillingInvoice({ tenantId: tenant.id, periodStart, periodEnd, status: "OPEN" });
      let transaction = null;
      if (tenant.billingSettings?.autoBillingEnabled && tenant.billingSettings.defaultPaymentMethodId) {
        const method = await (db as any).paymentMethod.findUnique({ where: { id: tenant.billingSettings.defaultPaymentMethodId } });
        if (method) transaction = await chargeInvoice(invoice, method, run.id);
      }
      results.push({ tenantId: tenant.id, invoiceId: invoice.id, totalCents: invoice.totalCents, transaction });
    }
    await (db as any).billingRun.update({ where: { id: run.id }, data: { status: "COMPLETED", finishedAt: new Date(), totals: { results } } });
    return { runId: run.id, results };
  });

  app.get("/admin/billing/runs/:id", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    return (db as any).billingRun.findUnique({ where: { id }, include: { events: { orderBy: { createdAt: "asc" } } } });
  });
}

function taxProfileInput() {
  return z.object({
    name: z.string().min(2),
    state: z.string().length(2).transform((value) => value.toUpperCase()),
    county: z.string().nullable().optional(),
    salesTaxRate: z.number().min(0).max(1),
    e911FeePerExtension: z.number().int().min(0).default(0),
    regulatoryFeePercent: z.number().min(0).max(1).default(0),
    regulatoryFeeEnabled: z.boolean().default(true),
    enabled: z.boolean().default(true),
  });
}

async function chargeInvoice(invoice: any, method: any, runId?: string | null) {
  const token = decryptPaymentToken(method);
  const adapter = await getBillingSolaAdapter(invoice.tenantId);
  const idempotencyKey = `billing:${invoice.id}:${Date.now()}`;
  const response = await adapter.chargeToken({ token, amountCents: invoice.balanceDueCents || invoice.totalCents, invoice: invoice.invoiceNumber, idempotencyKey });
  const transaction = await (db as any).paymentTransaction.create({
    data: {
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      paymentMethodId: method.id,
      amountCents: invoice.balanceDueCents || invoice.totalCents,
      status: response.approved ? "APPROVED" : response.status === "DECLINED" ? "DECLINED" : "ERROR",
      processorTransactionId: response.xRefNum,
      responseCode: response.xResult,
      responseMessage: response.xError || response.xStatus,
      rawResponseSafeJson: response.safePayload,
      idempotencyKey,
    },
  });
  await (db as any).paymentMethod.update({ where: { id: method.id }, data: { lastUsedAt: new Date() } });
  if (response.approved) {
    await markBillingInvoicePaid(invoice.id, invoice.balanceDueCents || invoice.totalCents);
    await (db as any).billingInvoice.update({ where: { id: invoice.id }, data: { paymentMethodId: method.id } });
    const billingSettings = await (db as any).tenantBillingSettings.findUnique({ where: { tenantId: invoice.tenantId } });
    if (billingSettings?.billingEmail) {
      const template = paymentReceiptEmail({ invoiceNumber: invoice.invoiceNumber, totalCents: invoice.totalCents, paidAt: new Date(), cardLabel: method.last4 ? `${method.brand || "Card"} ending ${method.last4}` : null });
      await queueBillingEmail({ tenantId: invoice.tenantId, invoiceId: invoice.id, to: billingSettings.billingEmail, type: "BILLING_RECEIPT", subject: template.subject, html: template.html, text: template.text });
    }
  } else {
    await (db as any).billingInvoice.update({ where: { id: invoice.id }, data: { status: "FAILED", failedAt: new Date(), paymentMethodId: method.id } });
    await (db as any).alert.create({ data: { tenantId: invoice.tenantId, severity: "HIGH", category: "BILLING", message: `Payment failed for invoice ${invoice.invoiceNumber}`, metadata: { invoiceId: invoice.id, transactionId: transaction.id } } }).catch(() => null);
    const billingSettings = await (db as any).tenantBillingSettings.findUnique({ where: { tenantId: invoice.tenantId } });
    if (billingSettings?.billingEmail) {
      const template = paymentFailedEmail({ invoiceNumber: invoice.invoiceNumber, totalCents: invoice.totalCents, reason: response.xError, updateUrl: `${publicPortalBase()}/billing/payments` });
      await queueBillingEmail({ tenantId: invoice.tenantId, invoiceId: invoice.id, to: billingSettings.billingEmail, type: "BILLING_PAYMENT_FAILED", subject: template.subject, html: template.html, text: template.text });
    }
  }
  await logBillingEvent({ tenantId: invoice.tenantId, invoiceId: invoice.id, runId, type: response.approved ? "payment.approved" : "payment.failed", metadata: { transactionId: transaction.id, response: response.safePayload } });
  return transaction;
}
