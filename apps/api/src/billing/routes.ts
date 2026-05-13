import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { decryptJson, encryptJson, hasCredentialsMasterKey } from "@connect/security";
import { SolaCardknoxAdapter, type SolaCardknoxConfig, TwilioSmsProvider, VoipMsSmsProvider, type TwilioCredentials, type VoipMsCredentials } from "@connect/integrations";
import { buildBillingInvoicePreview, createBillingInvoice, ensureTenantBillingSettings, logBillingEvent, markBillingInvoicePaid, monthBounds } from "./invoiceEngine";
import { calculateTenantBillingUsage } from "./usage";
import { getBillingSolaAdapter, storeSolaPaymentMethod } from "./solaGateway";
import { invoiceReadyEmail } from "./emailTemplates";
import { renderBillingInvoicePdf } from "./pdf";
import { chargeBillingInvoice } from "./solaBillingPayments";
import { maskSolaSecretsForResponse } from "./solaConfigMasking";
import {
  adminPutPathOverridesSource,
  resolveSolaPutApiBaseUrl,
  solaEnableBlockedMissingProdPin,
  solaWebhookPinMissingForProd,
} from "./solaConfigPolicy";
import { billingSolaCardknoxWebhookUrl } from "./solaPublicUrls";
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

function centsToDollarsStr(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── SMS provider resolution for billing ───────────────────────────────────────

type TenantSmsProviderResult = {
  provider: import("@connect/integrations").SmsProvider;
  fromNumber: string;
  providerName: string;
};

async function resolveTenantSmsProvider(tenantId: string): Promise<TenantSmsProviderResult | null> {
  const tenant = await (db as any).tenant.findUnique({
    where: { id: tenantId },
    select: {
      smsPrimaryProvider: true,
      defaultSmsFromNumber: { select: { phoneNumber: true } },
    },
  });
  if (!tenant) return null;

  const providerName: string = tenant.smsPrimaryProvider || "TWILIO";
  const credential = await (db as any).providerCredential.findUnique({
    where: { tenantId_provider: { tenantId, provider: providerName } },
  });
  if (!credential || !credential.isEnabled) return null;

  let smsProvider: import("@connect/integrations").SmsProvider;
  try {
    if (providerName === "TWILIO") {
      const creds = decryptJson<TwilioCredentials>(credential.credentialsEncrypted);
      if (!creds.accountSid || !creds.authToken) return null;
      smsProvider = new TwilioSmsProvider(creds, false);
    } else {
      const creds = decryptJson<VoipMsCredentials>(credential.credentialsEncrypted);
      if (!creds.username || !creds.password || !creds.fromNumber) return null;
      smsProvider = new VoipMsSmsProvider(creds, false);
    }
  } catch {
    return null;
  }

  let fromNumber: string | null = tenant.defaultSmsFromNumber?.phoneNumber ?? null;
  if (!fromNumber) {
    const anyNum = await (db as any).phoneNumber.findFirst({
      where: { tenantId, status: "ACTIVE" },
      select: { phoneNumber: true },
      orderBy: { createdAt: "asc" },
    });
    fromNumber = anyNum?.phoneNumber ?? null;
  }
  if (!fromNumber) return null;

  return { provider: smsProvider, fromNumber, providerName };
}

function ensureCredentialCrypto(reply: any): boolean {
  if (hasCredentialsMasterKey()) return true;
  reply.code(503).send({ error: "provider_settings_unavailable", message: "Credential encryption is not configured." });
  return false;
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
    webhookUrl: billingSolaCardknoxWebhookUrl(),
    mode: record.mode === "PROD" ? "prod" : "sandbox",
    simulate: !!record.simulate,
    authMode: record.authMode === "AUTHORIZATION_HEADER" ? "authorization_header" : "xkey_body",
    authHeaderName: record.authHeaderName || null,
    pathOverrides: normalizePathOverrides(record.pathOverrides || {}),
    masked: maskSolaSecretsForResponse(secrets || undefined),
    status: {
      lastTestAt: record.lastTestAt,
      lastTestResult: record.lastTestResult || null,
      lastTestErrorCode: record.lastTestErrorCode || null,
    },
    updatedAt: record.updatedAt,
  };
}

async function getMaskedSolaConfigForTenant(tenantId: string) {
  const webhookUrl = billingSolaCardknoxWebhookUrl();
  const record = await (db as any).billingSolaConfig.findUnique({ where: { tenantId } });
  if (!record) return { configured: false, config: null, webhookUrl };
  try {
    const secrets = decryptJson<SolaCredentialPayload>(record.credentialsEncrypted);
    return { configured: true, config: maskSolaConfig(record, secrets), webhookUrl };
  } catch {
    return { configured: true, config: maskSolaConfig(record, null), decryptFailed: true, webhookUrl };
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
      apiBaseUrl: z.string().url().optional(),
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
    let existingSecrets: SolaCredentialPayload = { apiKey: "", apiSecret: null, webhookSecret: null, ifieldsKey: null };
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
    if (solaWebhookPinMissingForProd(input.mode, nextSecrets.webhookSecret)) {
      return reply.code(400).send({
        error: "sola_webhook_pin_required",
        message: "Production mode requires a webhook verification PIN (store the same value in Connect and in the SOLA/Cardknox webhook/postback settings).",
      });
    }

    const apiBaseUrl = resolveSolaPutApiBaseUrl(input.apiBaseUrl, existing?.apiBaseUrl);
    const pathOverrides = normalizePathOverrides(adminPutPathOverridesSource(input.pathOverrides, existing?.pathOverrides));
    const saved = await (db as any).billingSolaConfig.upsert({
      where: { tenantId },
      create: {
        tenantId,
        apiBaseUrl,
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
        apiBaseUrl,
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
      const xError: string | undefined = err?.xError || undefined;
      const xErrorCode: string | undefined = err?.xErrorCode || undefined;
      const xResult: string | undefined = err?.xResult || undefined;
      const message = xError || code;
      const updated = await (db as any).billingSolaConfig.update({
        where: { tenantId },
        data: { lastTestAt: new Date(), lastTestResult: "FAILED", lastTestErrorCode: xErrorCode || code, updatedByUserId: u.sub },
      });
      await logBillingEvent({ tenantId, type: "sola.test_failed", message: "SOLA gateway test failed.", metadata: { code, xError, xErrorCode, xResult } });
      return reply.code(400).send({ error: "sola_validation_failed", code, message, xResult, xErrorCode, config: maskSolaConfig(updated, secrets) });
    }
  });

  app.post("/admin/billing/platform/tenants/:tenantId/sola-config/enable", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const record = await (db as any).billingSolaConfig.findUnique({ where: { tenantId } });
    if (!record) return reply.code(404).send({ error: "sola_not_configured" });
    if (record.lastTestResult !== "SUCCESS") return reply.code(400).send({ error: "sola_test_required" });
    if (record.mode === "PROD") {
      let secrets: SolaCredentialPayload;
      try {
        secrets = decryptJson<SolaCredentialPayload>(record.credentialsEncrypted);
      } catch {
        return reply.code(400).send({ error: "sola_decrypt_failed" });
      }
      if (solaEnableBlockedMissingProdPin(record.mode, secrets.webhookSecret)) {
        return reply.code(400).send({
          error: "sola_webhook_pin_required",
          message: "Set and save a webhook verification PIN before enabling production SOLA.",
        });
      }
    }
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

  app.get("/admin/billing/invoices", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const q = req.query as { status?: string; tenantId?: string; search?: string; page?: string; limit?: string };
    const page = Math.max(1, Number.parseInt(String(q.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(q.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (q.status && q.status !== "ALL") where.status = q.status;
    if (q.tenantId) where.tenantId = q.tenantId;
    if (q.search) {
      const s = String(q.search).trim();
      where.OR = [
        { invoiceNumber: { contains: s, mode: "insensitive" } },
        { tenant: { name: { contains: s, mode: "insensitive" } } },
      ];
    }

    const [total, invoices] = await Promise.all([
      (db as any).billingInvoice.count({ where }),
      (db as any).billingInvoice.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          invoiceNumber: true,
          tenantId: true,
          status: true,
          totalCents: true,
          subtotalCents: true,
          taxCents: true,
          balanceDueCents: true,
          dueDate: true,
          paidAt: true,
          failedAt: true,
          periodStart: true,
          periodEnd: true,
          lastEmailStatus: true,
          lastEmailedAt: true,
          createdAt: true,
          tenant: {
            select: {
              id: true,
              name: true,
              billingSettings: { select: { billingEmail: true, defaultPaymentMethodId: true } },
            },
          },
          paymentMethod: { select: { id: true, brand: true, last4: true } },
          transactions: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true, status: true, processorTransactionId: true, responseCode: true, amountCents: true, createdAt: true },
          },
        },
      }),
    ]);

    return { invoices, total, page, pages: Math.ceil(total / limit), limit };
  });

  app.get("/admin/billing/invoices/:id", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const invoice = await (db as any).billingInvoice.findUnique({
      where: { id },
      include: {
        lineItems: { orderBy: { createdAt: "asc" } },
        transactions: {
          orderBy: { createdAt: "desc" },
          include: { paymentMethod: { select: { id: true, brand: true, last4: true } } },
        },
        events: {
          orderBy: { createdAt: "desc" },
          take: 100,
          select: { id: true, type: true, message: true, metadata: true, createdAt: true },
        },
        paymentMethod: { select: { id: true, brand: true, last4: true, expMonth: true, expYear: true, cardholderName: true } },
        tenant: {
          select: {
            id: true,
            name: true,
            billingSettings: { select: { billingEmail: true, defaultPaymentMethodId: true } },
            billingSolaConfig: { select: { isEnabled: true, mode: true, simulate: true } },
          },
        },
      },
    });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    const sc = (invoice as any).tenant?.billingSolaConfig;
    const isLiveCharge = !!(sc?.isEnabled && sc.mode === "PROD" && !sc.simulate);
    return { ...invoice, isLiveCharge };
  });

  app.get("/admin/billing/transactions", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const q = req.query as { status?: string; tenantId?: string; invoiceId?: string; page?: string; limit?: string };
    const page = Math.max(1, Number.parseInt(String(q.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(q.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (q.status && q.status !== "ALL") where.status = q.status;
    if (q.tenantId) where.tenantId = q.tenantId;
    if (q.invoiceId) where.invoiceId = q.invoiceId;

    const [total, transactions] = await Promise.all([
      (db as any).paymentTransaction.count({ where }),
      (db as any).paymentTransaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          tenantId: true,
          invoiceId: true,
          amountCents: true,
          currency: true,
          status: true,
          processor: true,
          processorTransactionId: true,
          responseCode: true,
          responseMessage: true,
          createdAt: true,
          tenant: { select: { id: true, name: true } },
          invoice: { select: { id: true, invoiceNumber: true } },
          paymentMethod: { select: { id: true, brand: true, last4: true } },
        },
      }),
    ]);

    return { transactions, total, page, pages: Math.ceil(total / limit), limit };
  });

  app.get("/admin/billing/transactions/:id", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const tx = await (db as any).paymentTransaction.findUnique({
      where: { id },
      include: {
        tenant: { select: { id: true, name: true } },
        invoice: { select: { id: true, invoiceNumber: true, status: true, totalCents: true } },
        paymentMethod: { select: { id: true, brand: true, last4: true, expMonth: true, expYear: true } },
      },
    });
    if (!tx) return reply.code(404).send({ error: "transaction_not_found" });
    return tx;
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

  // ── Admin tenant payment-method management ──────────────────────────────────

  app.get("/admin/billing/platform/tenants/:tenantId/payment-methods", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const methods = await (db as any).paymentMethod.findMany({
      where: { tenantId, active: true },
      select: { id: true, brand: true, last4: true, expMonth: true, expYear: true, cardholderName: true, billingZip: true, isDefault: true, lastUsedAt: true, createdAt: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    });
    const methodsWithCharge = await Promise.all(
      methods.map(async (m: any) => {
        const lastSuccess = await (db as any).paymentTransaction.findFirst({
          where: { paymentMethodId: m.id, status: "APPROVED" },
          orderBy: { createdAt: "desc" },
          select: { id: true, amountCents: true, createdAt: true },
        });
        return { ...m, lastSuccessfulCharge: lastSuccess };
      }),
    );
    const sc = await (db as any).billingSolaConfig.findUnique({ where: { tenantId }, select: { isEnabled: true, mode: true, simulate: true } });
    const isLiveCharge = !!(sc?.isEnabled && sc.mode === "PROD" && !sc.simulate);
    return { methods: methodsWithCharge, isLiveCharge };
  });

  app.post("/admin/billing/platform/tenants/:tenantId/payment-methods/:methodId/default", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId, methodId } = req.params as { tenantId: string; methodId: string };
    const method = await (db as any).paymentMethod.findFirst({ where: { id: methodId, tenantId, active: true } });
    if (!method) return reply.code(404).send({ error: "payment_method_not_found" });
    await (db as any).paymentMethod.updateMany({ where: { tenantId }, data: { isDefault: false } });
    await (db as any).paymentMethod.update({ where: { id: methodId }, data: { isDefault: true } });
    await (db as any).tenantBillingSettings.upsert({
      where: { tenantId },
      create: { tenantId, defaultPaymentMethodId: methodId },
      update: { defaultPaymentMethodId: methodId },
    });
    await logBillingEvent({ tenantId, type: "payment_method.default_set", message: `Admin set default card`, metadata: { paymentMethodId: methodId, adminUserId: u.sub } });
    return { ok: true };
  });

  app.delete("/admin/billing/platform/tenants/:tenantId/payment-methods/:methodId", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId, methodId } = req.params as { tenantId: string; methodId: string };
    const method = await (db as any).paymentMethod.findFirst({ where: { id: methodId, tenantId, active: true } });
    if (!method) return reply.code(404).send({ error: "payment_method_not_found" });
    await (db as any).paymentMethod.update({ where: { id: methodId }, data: { active: false, isDefault: false } });
    await (db as any).tenantBillingSettings.updateMany({ where: { tenantId, defaultPaymentMethodId: methodId }, data: { defaultPaymentMethodId: null } });
    await logBillingEvent({ tenantId, type: "payment_method.removed", message: `Admin removed saved card`, metadata: { paymentMethodId: methodId, adminUserId: u.sub } });
    return { ok: true };
  });

  // ── Admin SMS payment link ────────────────────────────────────────────────────

  app.get("/admin/billing/platform/tenants/:tenantId/sms-capability", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const result = await resolveTenantSmsProvider(tenantId);
    if (!result) {
      return { capable: false, fromNumber: null, provider: null, reason: "No enabled SMS provider credentials found for this tenant." };
    }
    return { capable: true, fromNumber: result.fromNumber, provider: result.providerName, reason: null };
  });

  app.post("/admin/billing/invoices/:id/sms-payment-link", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const input = z.object({
      phone: z.string().min(7).max(20).optional(),
      note: z.string().max(300).optional(),
    }).parse(req.body || {});

    const invoice = await (db as any).billingInvoice.findUnique({
      where: { id },
      include: { tenant: { include: { billingSettings: true } } },
    });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    if (invoice.status === "VOID") return reply.code(400).send({ error: "invoice_voided" });

    const smsCtx = await resolveTenantSmsProvider(invoice.tenantId);
    if (!smsCtx) {
      return reply.code(400).send({ error: "sms_provider_unavailable", message: "No enabled SMS provider credentials found for this tenant." });
    }

    const rawPhone = (input.phone || "").trim();
    if (!rawPhone || rawPhone.length < 7) {
      return reply.code(400).send({ error: "destination_phone_required", message: "Provide a destination phone number." });
    }
    const normalizedPhone = rawPhone.startsWith("+") ? rawPhone : `+1${rawPhone.replace(/\D/g, "")}`;
    if (normalizedPhone.replace(/\D/g, "").length < 10) {
      return reply.code(400).send({ error: "invalid_phone", message: "Phone number appears too short — check the number and try again." });
    }

    // Duplicate send protection: no same phone for this invoice in the last 2 minutes
    const recentEvents = await (db as any).billingEventLog.findMany({
      where: { invoiceId: id, type: "billing.sms_payment_link_sent", createdAt: { gte: new Date(Date.now() - 2 * 60_000) } },
      select: { metadata: true },
    });
    const isDuplicate = recentEvents.some((e: any) => e.metadata?.toPhone === normalizedPhone);
    if (isDuplicate) {
      return reply.code(429).send({ error: "duplicate_sms_send", message: "A payment link was already sent to this number in the last 2 minutes. Please wait before resending." });
    }

    const payUrl = `${publicPortalBase()}/billing/invoices/${encodeURIComponent(invoice.id)}`;
    const invLabel = invoice.invoiceNumber || invoice.id.slice(0, 8);
    const balanceStr = centsToDollarsStr(invoice.balanceDueCents ?? invoice.totalCents);
    const msgBody = `${invoice.tenant?.name || "Connect"}: Pay invoice ${invLabel} (${balanceStr}): ${payUrl}`;

    let providerMessageId: string | undefined;
    try {
      const result = await smsCtx.provider.sendMessage({
        tenantId: invoice.tenantId,
        to: normalizedPhone,
        from: smsCtx.fromNumber,
        body: msgBody,
      });
      providerMessageId = result.providerMessageId;
    } catch (err: any) {
      await logBillingEvent({
        tenantId: invoice.tenantId,
        invoiceId: id,
        type: "billing.sms_payment_link_failed",
        message: `SMS payment link send failed: ${err?.message || "unknown error"}`,
        metadata: { toPhone: normalizedPhone, fromPhone: smsCtx.fromNumber, adminUserId: u.sub },
      });
      return reply.code(502).send({ error: "sms_send_failed", message: err?.message || "SMS provider returned an error. Check the phone number and try again." });
    }

    await logBillingEvent({
      tenantId: invoice.tenantId,
      invoiceId: id,
      type: "billing.sms_payment_link_sent",
      message: `Payment link sent via SMS to ${normalizedPhone}${input.note ? ` — ${input.note}` : ""}`,
      metadata: { toPhone: normalizedPhone, fromPhone: smsCtx.fromNumber, providerMessageId, adminUserId: u.sub },
    });

    return { ok: true, toPhone: normalizedPhone, fromPhone: smsCtx.fromNumber, providerMessageId };
  });

  // ── Admin explicit charge with saved card ────────────────────────────────────

  app.post("/admin/billing/invoices/:id/pay", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const input = z.object({
      paymentMethodId: z.string().min(1),
      note: z.string().max(500).optional(),
      confirmLive: z.boolean().optional(),
    }).parse(req.body || {});
    const invoice = await (db as any).billingInvoice.findUnique({
      where: { id },
      include: { tenant: { include: { billingSolaConfig: true } } },
    });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    if (invoice.status === "PAID") return reply.code(400).send({ error: "invoice_already_paid" });
    if (invoice.status === "VOID") return reply.code(400).send({ error: "invoice_voided" });
    const sc = invoice.tenant?.billingSolaConfig;
    const isLive = !!(sc?.isEnabled && sc.mode === "PROD" && !sc.simulate);
    if (isLive && !input.confirmLive) {
      return reply.code(400).send({ error: "confirm_live_required", message: "Set confirmLive: true to confirm this intentional live charge." });
    }
    const method = await (db as any).paymentMethod.findFirst({ where: { id: input.paymentMethodId, tenantId: invoice.tenantId, active: true } });
    if (!method) return reply.code(400).send({ error: "payment_method_not_found" });
    if (input.note) {
      await logBillingEvent({ tenantId: invoice.tenantId, invoiceId: id, type: "payment.admin_charge_note", message: input.note, metadata: { adminUserId: u.sub } });
    }
    const transaction = await chargeBillingInvoice(invoice, method, { note: input.note });
    const updatedInvoice = await (db as any).billingInvoice.findUnique({ where: { id } });
    return { transaction, invoice: updatedInvoice };
  });

  // ── Mark paid (optional partial amount + note) ───────────────────────────────

  app.post("/admin/billing/invoices/:id/mark-paid", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const input = z.object({
      amountCents: z.number().int().min(1).optional(),
      note: z.string().max(500).optional(),
    }).parse(req.body || {});
    const result = await markBillingInvoicePaid(id, input.amountCents);
    if (input.note) {
      await logBillingEvent({ tenantId: (result as any).tenantId, invoiceId: id, type: "invoice.manual_paid_note", message: input.note, metadata: { adminUserId: u.sub } });
    }
    return result;
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
