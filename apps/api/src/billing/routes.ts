import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { decryptJson, encryptJson, hasCredentialsMasterKey } from "@connect/security";
import { SolaCardknoxAdapter, type SolaCardknoxConfig } from "@connect/integrations";
import { buildBillingInvoicePreview, createBillingInvoice, ensureTenantBillingSettings, logBillingEvent, markBillingInvoicePaid, monthBounds } from "./invoiceEngine";
import { calculateTenantBillingUsage } from "./usage";
import { getBillingSolaAdapter, storeSolaPaymentMethod } from "./solaGateway";
import { invoiceReadyEmail } from "./emailTemplates";
import { renderBillingInvoicePdf } from "./pdf";
import { chargeBillingInvoice } from "./solaBillingPayments";
import { billingInvoicePdfApiUrl, queuePaymentLinkEmail } from "./billingEmailLifecycle";
import { buildBillingEmailJobCreateData, canAccessPlatformAdminBillingRoutes, canAccessTenantBillingRoutes } from "./billingAuth";
import { invoiceBrandingPutSchema, normalizeBrandingPayload, resolveInvoiceEmailBranding } from "./invoiceBranding";

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
  return canAccessPlatformAdminBillingRoutes(u.role);
}

function canTenantBilling(u: BillingUser): boolean {
  return canAccessTenantBillingRoutes(u.role);
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

function ensureCredentialCrypto(reply: any): boolean {
  if (hasCredentialsMasterKey()) return true;
  reply.code(503).send({ error: "provider_settings_unavailable", message: "Credential encryption is not configured." });
  return false;
}

function maskValue(value: string | undefined | null, start = 4, end = 2): string | null {
  if (!value) return null;
  if (value.length <= start + end) return "*".repeat(Math.max(4, value.length));
  return `${value.slice(0, start)}${"*".repeat(value.length - start - end)}${value.slice(-end)}`;
}

type SolaCredentialPayload = {
  apiKey: string;
  apiSecret?: string | null;
  webhookSecret?: string | null;
  ifieldsKey?: string | null;
};

function normalizePathOverrides(input: unknown) {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const pick = (key: string) => {
    const value = String(src[key] || "").trim();
    return value || undefined;
  };
  const out: Record<string, string> = { transactionPath: pick("transactionPath") || "/gatewayjson" };
  for (const key of ["customerPath", "subscriptionPath", "hostedSessionPath", "chargePath", "cancelPath"]) {
    const value = pick(key);
    if (value) out[key] = value;
  }
  return out;
}

function maskSolaConfig(record: any, secrets?: SolaCredentialPayload | null) {
  if (!record) return null;
  return {
    id: record.id,
    tenantId: record.tenantId,
    configured: true,
    isEnabled: !!record.isEnabled,
    apiBaseUrl: record.apiBaseUrl,
    mode: record.mode === "PROD" ? "prod" : "sandbox",
    simulate: !!record.simulate,
    authMode: record.authMode === "AUTHORIZATION_HEADER" ? "authorization_header" : "xkey_body",
    authHeaderName: record.authHeaderName || null,
    pathOverrides: normalizePathOverrides(record.pathOverrides || {}),
    masked: {
      apiKey: maskValue(secrets?.apiKey || null),
      apiSecret: secrets?.apiSecret ? "********" : null,
      webhookSecret: secrets?.webhookSecret ? "********" : null,
      ifieldsKey: maskValue(secrets?.ifieldsKey || null, 6, 3),
    },
    status: {
      lastTestAt: record.lastTestAt,
      lastTestResult: record.lastTestResult || null,
      lastTestErrorCode: record.lastTestErrorCode || null,
    },
    updatedAt: record.updatedAt,
  };
}

async function getMaskedSolaConfigForTenant(tenantId: string) {
  const record = await (db as any).billingSolaConfig.findUnique({ where: { tenantId } });
  if (!record) return { configured: false, config: null };
  try {
    const secrets = decryptJson<SolaCredentialPayload>(record.credentialsEncrypted);
    return { configured: true, config: maskSolaConfig(record, secrets) };
  } catch {
    return { configured: true, config: maskSolaConfig(record, null), decryptFailed: true };
  }
}

function buildAdapterConfig(record: any, secrets: SolaCredentialPayload): SolaCardknoxConfig {
  const paths = normalizePathOverrides(record.pathOverrides || {});
  return {
    baseUrl: record.apiBaseUrl,
    apiKey: secrets.apiKey,
    apiSecret: secrets.apiSecret || undefined,
    webhookSecret: secrets.webhookSecret || undefined,
    mode: record.mode === "PROD" ? "prod" : "sandbox",
    simulate: !!record.simulate,
    authMode: record.authMode === "AUTHORIZATION_HEADER" ? "authorization_header" : "xkey_body",
    authHeaderName: record.authHeaderName || undefined,
    customerPath: paths.customerPath,
    subscriptionPath: paths.subscriptionPath,
    transactionPath: paths.transactionPath || "/gatewayjson",
    hostedSessionPath: paths.hostedSessionPath,
    chargePath: paths.chargePath,
    cancelPath: paths.cancelPath,
  };
}

async function queueBillingEmail(input: { tenantId: string; to: string; type: string; subject: string; html: string; text: string; invoiceId?: string | null }) {
  return (db as any).emailJob.create({
    data: buildBillingEmailJobCreateData(input),
  });
}

export async function registerBillingRoutes(app: FastifyInstance) {
  app.get("/billing/settings", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    return ensureTenantBillingSettings(u.tenantId);
  });

  app.put("/billing/settings/branding", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    const parsed = invoiceBrandingPutSchema.parse(req.body || {});
    const data = normalizeBrandingPayload(parsed);
    if (!Object.keys(data).length) {
      return ensureTenantBillingSettings(u.tenantId);
    }
    await ensureTenantBillingSettings(u.tenantId);
    return (db as any).tenantBillingSettings.update({ where: { tenantId: u.tenantId }, data });
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
      include: { lineItems: true, tenant: { include: { billingSettings: true } } },
    });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    const pdf = await renderBillingInvoicePdf(invoice);
    reply.header("content-type", "application/pdf");
    reply.header("content-disposition", `inline; filename="${invoice.invoiceNumber}.pdf"`);
    return reply.send(pdf);
  });

  app.post("/billing/platform/invoices/:id/email-payment-link", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const invoice = await (db as any).billingInvoice.findFirst({
      where: { id, tenantId: u.tenantId },
      include: { tenant: { include: { billingSettings: true } } },
    });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    if (invoice.status === "PAID") return reply.code(400).send({ error: "invoice_already_paid" });
    const to = String(invoice.tenant?.billingSettings?.billingEmail || u.email || "").trim();
    if (!to) return reply.code(400).send({ error: "billing_email_required" });
    const result = await queuePaymentLinkEmail({
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      totalCents: invoice.balanceDueCents ?? invoice.totalCents,
      dueDate: invoice.dueDate,
      to,
    });
    if (!result.ok) return reply.code(400).send(result);
    await (db as any).billingInvoice.update({ where: { id }, data: { lastEmailStatus: "QUEUED", lastEmailedAt: new Date() } });
    return { ok: true };
  });

  app.post("/billing/platform/invoices/:id/email-invoice", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const invoice = await (db as any).billingInvoice.findFirst({
      where: { id, tenantId: u.tenantId },
      include: { tenant: { include: { billingSettings: true } } },
    });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    const to = String(invoice.tenant.billingSettings?.billingEmail || u.email || "").trim();
    if (!to) return reply.code(400).send({ error: "billing_email_required" });
    const template = invoiceReadyEmail({
      invoiceNumber: invoice.invoiceNumber,
      totalCents: invoice.totalCents,
      dueDate: invoice.dueDate,
      invoiceUrl: `${publicPortalBase()}/billing/invoices/${invoice.id}`,
      pdfUrl: billingInvoicePdfApiUrl(invoice.id),
      brand: resolveInvoiceEmailBranding(invoice.tenant.billingSettings || {}, invoice.tenant.name),
    });
    await queueBillingEmail({ tenantId: invoice.tenantId, invoiceId: invoice.id, to, type: "BILLING_INVOICE_READY", subject: template.subject, html: template.html, text: template.text });
    await (db as any).billingInvoice.update({
      where: { id },
      data: { lastEmailStatus: "QUEUED", lastEmailedAt: new Date(), status: invoice.status === "DRAFT" ? "OPEN" : invoice.status },
    });
    await logBillingEvent({
      tenantId: invoice.tenantId,
      invoiceId: id,
      type: "invoice_emailed",
      metadata: { to, channel: "tenant_self", emailType: "BILLING_INVOICE_READY" },
    });
    return { ok: true };
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

    const transaction = await chargeBillingInvoice(invoice, method);
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

  app.get("/billing/sola/public-config", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    if (!ensureCredentialCrypto(reply)) return;
    const record = await (db as any).billingSolaConfig.findUnique({ where: { tenantId: u.tenantId } });
    if (!record) return { configured: false, enabled: false, ifieldsKey: null, ifieldsVersion: "3.4.2602.2001" };
    let secrets: SolaCredentialPayload;
    try {
      secrets = decryptJson<SolaCredentialPayload>(record.credentialsEncrypted);
    } catch {
      return reply.code(400).send({ error: "sola_decrypt_failed" });
    }
    return {
      configured: true,
      enabled: !!record.isEnabled,
      mode: record.mode === "PROD" ? "prod" : "sandbox",
      ifieldsKey: secrets.ifieldsKey || null,
      ifieldsVersion: "3.4.2602.2001",
    };
  });

  app.get("/admin/billing/overview", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const [invoices, tenantsWithoutCards, recentFailures] = await Promise.all([
      (db as any).billingInvoice.findMany({ where: { status: { in: ["OPEN", "FAILED", "OVERDUE", "PAID"] } } }),
      (db as any).tenant.count({ where: { paymentMethods: { none: { active: true } } } }),
      (db as any).billingInvoice.findMany({
        where: { status: { in: ["FAILED", "OVERDUE"] }, balanceDueCents: { gt: 0 } },
        orderBy: [{ failedAt: "desc" }, { dueDate: "desc" }],
        take: 12,
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          balanceDueCents: true,
          failedAt: true,
          dueDate: true,
          tenantId: true,
          tenant: { select: { name: true } },
        },
      }),
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
      recentFailures: recentFailures.map((inv: any) => ({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        tenantId: inv.tenantId,
        tenantName: inv.tenant?.name || inv.tenantId,
        status: inv.status,
        balanceDueCents: inv.balanceDueCents,
        failedAt: inv.failedAt,
        dueDate: inv.dueDate,
      })),
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

  app.get("/admin/billing/platform/tenants/:tenantId", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const tenant = await (db as any).tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, createdAt: true } });
    if (!tenant) return reply.code(404).send({ error: "tenant_not_found" });
    const settings = await ensureTenantBillingSettings(tenantId);
    const [usage, preview, invoices, paymentMethods, taxProfiles, sola] = await Promise.all([
      calculateTenantBillingUsage(tenantId, settings),
      buildBillingInvoicePreview({ tenantId }),
      (db as any).billingInvoice.findMany({
        where: { tenantId },
        include: { lineItems: true, transactions: { orderBy: { createdAt: "desc" }, take: 3 } },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
      (db as any).paymentMethod.findMany({
        where: { tenantId, active: true },
        select: { id: true, brand: true, last4: true, expMonth: true, expYear: true, cardholderName: true, billingZip: true, isDefault: true, lastUsedAt: true, createdAt: true },
        orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
      }),
      (db as any).taxProfile.findMany({ where: { enabled: true }, orderBy: [{ state: "asc" }, { county: "asc" }] }),
      getMaskedSolaConfigForTenant(tenantId),
    ]);
    return { tenant, settings, usage, preview, invoices, paymentMethods, taxProfiles, sola };
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
    const input = z
      .object({
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
        creditsCents: z.number().int().optional(),
        discountPercent: z.number().min(0).max(1).optional(),
        billingAddress: z.any().optional(),
        serviceAddress: z.any().optional(),
        taxProviderId: z.enum(["tax_profile_v1", "external_telecom_stub"]).optional(),
      })
      .merge(invoiceBrandingPutSchema)
      .parse(req.body || {});
    const brandingPatch = normalizeBrandingPayload({
      invoiceCompanyName: input.invoiceCompanyName,
      invoiceLogoUrl: input.invoiceLogoUrl,
      invoiceSupportEmail: input.invoiceSupportEmail,
      invoiceSupportPhone: input.invoiceSupportPhone,
      invoiceFooterNote: input.invoiceFooterNote,
      invoicePaymentInstructions: input.invoicePaymentInstructions,
    });
    const {
      invoiceCompanyName: _icn,
      invoiceLogoUrl: _ilu,
      invoiceSupportEmail: _ise,
      invoiceSupportPhone: _isp,
      invoiceFooterNote: _ifn,
      invoicePaymentInstructions: _ipi,
      taxProviderId,
      ...pricing
    } = input as any;
    const pricingData = Object.fromEntries(Object.entries(pricing).filter(([, v]) => v !== undefined));
    let mergedMetadata: Record<string, unknown> | undefined;
    if (taxProviderId !== undefined) {
      const cur = await (db as any).tenantBillingSettings.findUnique({ where: { tenantId } });
      const prevMeta =
        cur?.metadata && typeof cur.metadata === "object" && !Array.isArray(cur.metadata) ? { ...(cur.metadata as object) } : {};
      mergedMetadata = { ...prevMeta, taxProviderId };
    }
    const createUpdate = { ...pricingData, ...brandingPatch, ...(mergedMetadata !== undefined ? { metadata: mergedMetadata } : {}) };
    return (db as any).tenantBillingSettings.upsert({
      where: { tenantId },
      create: { tenantId, ...createUpdate },
      update: createUpdate,
    });
  });

  app.put("/admin/billing/platform/tenants/:tenantId/sola-config", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    if (!ensureCredentialCrypto(reply)) return;
    const { tenantId } = req.params as { tenantId: string };
    const tenant = await (db as any).tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return reply.code(404).send({ error: "tenant_not_found" });
    const input = z.object({
      apiBaseUrl: z.string().url(),
      mode: z.enum(["sandbox", "prod"]),
      simulate: z.boolean().default(false),
      authMode: z.enum(["xkey_body", "authorization_header"]).default("xkey_body"),
      authHeaderName: z.string().min(1).max(64).optional().nullable(),
      apiKey: z.string().min(1).optional(),
      apiSecret: z.string().min(1).optional().nullable(),
      webhookSecret: z.string().min(1).optional().nullable(),
      ifieldsKey: z.string().min(1).optional().nullable(),
      pathOverrides: z.object({
        customerPath: z.string().optional(),
        subscriptionPath: z.string().optional(),
        transactionPath: z.string().optional(),
        hostedSessionPath: z.string().optional(),
        chargePath: z.string().optional(),
        cancelPath: z.string().optional(),
      }).optional(),
    }).parse(req.body || {});
    if (input.mode === "prod" && input.simulate) {
      return reply.code(400).send({ error: "invalid_sola_mode", message: "Simulation must be disabled for production SOLA mode." });
    }

    const existing = await (db as any).billingSolaConfig.findUnique({ where: { tenantId } });
    let existingSecrets: SolaCredentialPayload = { apiKey: "", apiSecret: null, webhookSecret: null };
    if (existing) {
      try {
        existingSecrets = decryptJson<SolaCredentialPayload>(existing.credentialsEncrypted);
      } catch {
        return reply.code(400).send({ error: "sola_decrypt_failed" });
      }
    }
    const nextSecrets: SolaCredentialPayload = {
      apiKey: input.apiKey || existingSecrets.apiKey || "",
      apiSecret: input.apiSecret !== undefined ? (input.apiSecret || null) : (existingSecrets.apiSecret || null),
      webhookSecret: input.webhookSecret !== undefined ? (input.webhookSecret || null) : (existingSecrets.webhookSecret || null),
      ifieldsKey: input.ifieldsKey !== undefined ? (input.ifieldsKey || null) : (existingSecrets.ifieldsKey || null),
    };
    if (!nextSecrets.apiKey) return reply.code(400).send({ error: "sola_api_key_required" });

    const pathOverrides = normalizePathOverrides(input.pathOverrides || existing?.pathOverrides || {});
    const saved = await (db as any).billingSolaConfig.upsert({
      where: { tenantId },
      create: {
        tenantId,
        apiBaseUrl: input.apiBaseUrl,
        mode: input.mode === "prod" ? "PROD" : "SANDBOX",
        simulate: input.simulate,
        authMode: input.authMode === "authorization_header" ? "AUTHORIZATION_HEADER" : "XKEY_BODY",
        authHeaderName: input.authHeaderName || null,
        pathOverrides,
        credentialsEncrypted: encryptJson(nextSecrets),
        credentialsKeyId: "v1",
        isEnabled: false,
        createdByUserId: u.sub,
        updatedByUserId: u.sub,
        lastTestAt: null,
        lastTestResult: null,
        lastTestErrorCode: null,
      },
      update: {
        apiBaseUrl: input.apiBaseUrl,
        mode: input.mode === "prod" ? "PROD" : "SANDBOX",
        simulate: input.simulate,
        authMode: input.authMode === "authorization_header" ? "AUTHORIZATION_HEADER" : "XKEY_BODY",
        authHeaderName: input.authHeaderName || null,
        pathOverrides,
        credentialsEncrypted: encryptJson(nextSecrets),
        credentialsKeyId: "v1",
        isEnabled: false,
        updatedByUserId: u.sub,
        lastTestAt: null,
        lastTestResult: null,
        lastTestErrorCode: null,
      },
    });
    await logBillingEvent({ tenantId, type: existing ? "sola.updated" : "sola.created", message: "SOLA gateway settings saved by platform admin." });
    return { ok: true, config: maskSolaConfig(saved, nextSecrets) };
  });

  app.post("/admin/billing/platform/tenants/:tenantId/sola-config/test", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    if (!ensureCredentialCrypto(reply)) return;
    const { tenantId } = req.params as { tenantId: string };
    const record = await (db as any).billingSolaConfig.findUnique({ where: { tenantId } });
    if (!record) return reply.code(404).send({ error: "sola_not_configured" });
    let secrets: SolaCredentialPayload;
    try {
      secrets = decryptJson<SolaCredentialPayload>(record.credentialsEncrypted);
    } catch {
      return reply.code(400).send({ error: "sola_decrypt_failed" });
    }
    try {
      const result = await new SolaCardknoxAdapter(buildAdapterConfig(record, secrets)).testConnection();
      const updated = await (db as any).billingSolaConfig.update({
        where: { tenantId },
        data: { lastTestAt: new Date(), lastTestResult: "SUCCESS", lastTestErrorCode: null, updatedByUserId: u.sub },
      });
      await logBillingEvent({ tenantId, type: "sola.test_success", message: "SOLA gateway test succeeded.", metadata: { simulated: result.simulated } });
      return { ok: true, simulated: result.simulated, config: maskSolaConfig(updated, secrets) };
    } catch (err: any) {
      const code = String(err?.code || "SOLA_VALIDATION_FAILED");
      const updated = await (db as any).billingSolaConfig.update({
        where: { tenantId },
        data: { lastTestAt: new Date(), lastTestResult: "FAILED", lastTestErrorCode: code, updatedByUserId: u.sub },
      });
      await logBillingEvent({ tenantId, type: "sola.test_failed", message: "SOLA gateway test failed.", metadata: { code } });
      return reply.code(400).send({ error: "sola_validation_failed", code, config: maskSolaConfig(updated, secrets) });
    }
  });

  app.post("/admin/billing/platform/tenants/:tenantId/sola-config/enable", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const record = await (db as any).billingSolaConfig.findUnique({ where: { tenantId } });
    if (!record) return reply.code(404).send({ error: "sola_not_configured" });
    if (record.lastTestResult !== "SUCCESS") return reply.code(400).send({ error: "sola_test_required" });
    const updated = await (db as any).billingSolaConfig.update({ where: { tenantId }, data: { isEnabled: true, updatedByUserId: u.sub } });
    await logBillingEvent({ tenantId, type: "sola.enabled", message: "SOLA gateway enabled." });
    return { ok: true, config: maskSolaConfig(updated, null) };
  });

  app.post("/admin/billing/platform/tenants/:tenantId/sola-config/disable", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const record = await (db as any).billingSolaConfig.findUnique({ where: { tenantId } });
    if (!record) return reply.code(404).send({ error: "sola_not_configured" });
    const updated = await (db as any).billingSolaConfig.update({ where: { tenantId }, data: { isEnabled: false, updatedByUserId: u.sub } });
    await logBillingEvent({ tenantId, type: "sola.disabled", message: "SOLA gateway disabled." });
    return { ok: true, config: maskSolaConfig(updated, null) };
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

  app.get("/admin/billing/invoices/:id/events", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const invoice = await (db as any).billingInvoice.findUnique({ where: { id }, select: { id: true, tenantId: true } });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    const events = await (db as any).billingEventLog.findMany({
      where: { invoiceId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, type: true, message: true, metadata: true, createdAt: true },
    });
    return { tenantId: invoice.tenantId, events };
  });

  app.post("/admin/billing/invoices/:id/send", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const invoice = await (db as any).billingInvoice.findUnique({ where: { id }, include: { tenant: { include: { billingSettings: true } } } });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    const to = invoice.tenant.billingSettings?.billingEmail || u.email;
    if (!to) return reply.code(400).send({ error: "billing_email_required" });
    const template = invoiceReadyEmail({
      invoiceNumber: invoice.invoiceNumber,
      totalCents: invoice.totalCents,
      dueDate: invoice.dueDate,
      invoiceUrl: `${publicPortalBase()}/billing/invoices/${invoice.id}`,
      pdfUrl: billingInvoicePdfApiUrl(invoice.id),
      brand: resolveInvoiceEmailBranding(invoice.tenant.billingSettings || {}, invoice.tenant.name),
    });
    await queueBillingEmail({ tenantId: invoice.tenantId, invoiceId: invoice.id, to, type: "BILLING_INVOICE_READY", subject: template.subject, html: template.html, text: template.text });
    await (db as any).billingInvoice.update({ where: { id }, data: { lastEmailStatus: "QUEUED", lastEmailedAt: new Date(), status: invoice.status === "DRAFT" ? "OPEN" : invoice.status } });
    await logBillingEvent({ tenantId: invoice.tenantId, invoiceId: id, type: "invoice_emailed", metadata: { to, channel: "admin_resend", emailType: "BILLING_INVOICE_READY" } });
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
    return chargeBillingInvoice(invoice, method);
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
        if (method) transaction = await chargeBillingInvoice(invoice, method, { runId: run.id });
      }
      results.push({ tenantId: tenant.id, invoiceId: invoice.id, totalCents: invoice.totalCents, transaction });
    }
    await (db as any).billingRun.update({ where: { id: run.id }, data: { status: "COMPLETED", finishedAt: new Date(), totals: { results } } });
    return { runId: run.id, results };
  });

  app.get("/admin/billing/runs/recent", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const raw = (req.query as { limit?: string })?.limit;
    const n = Math.min(20, Math.max(1, Number.parseInt(String(raw || "5"), 10) || 5));
    const runs = await (db as any).billingRun.findMany({
      orderBy: { startedAt: "desc" },
      take: n,
      select: {
        id: true,
        tenantId: true,
        status: true,
        dryRun: true,
        periodStart: true,
        periodEnd: true,
        startedAt: true,
        finishedAt: true,
        totals: true,
        errorMessage: true,
      },
    });
    return { runs };
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
