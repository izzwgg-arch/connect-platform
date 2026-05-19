import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { decryptJson, encryptJson, hasCredentialsMasterKey } from "@connect/security";
import { SolaCardknoxAdapter, type SolaCardknoxConfig, TwilioSmsProvider, VoipMsSmsProvider, type TwilioCredentials, type VoipMsCredentials } from "@connect/integrations";
import { buildBillingInvoicePreview, buildBillingInvoicePreviewFromSettings, createBillingInvoice, createOneTimeChargeInvoice, ensureTenantBillingSettings, logBillingEvent, markBillingInvoicePaid, monthBounds } from "./invoiceEngine";
import { calculateTenantBillingUsage } from "./usage";
import { BILLING_PRICING_MODE_METADATA_KEY, buildTenantSettingsResetToCatalog, parseBillingPricingMode } from "./billingPricingResolution";
import { buildTenantPricingDiagnosticsFromPreview, rawBillingPricingModeFromMetadata } from "./billingPricingDiagnostics";
import { billingPricingSettingsSliceFromLoaded, deriveBillingPricingState } from "./billingPricingState";
import {
  mergeTenantBillingSettingsForAssignPreview,
  tenantPricingQuadSnapshot,
  validateCatalogBillingPlanForAssignment,
} from "./billingAssignment";
import { validateBillingFlatRateInput } from "./billingFlatRate";
import { validateBillingQuantityOverridesInput } from "./billingQuantityOverrides";
import { taxProfilePatchFromTelecomFees, validateBillingTelecomFeesInput } from "./billingTelecomFees";
import {
  mergeTenantBillingSettingsMetadata,
  validateBillingScheduleOverrideInput,
} from "./billingTenantSettingsMetadata";
import { getBillingSolaAdapter, getBillingSolaAdapterForTokenizing, storeSolaPaymentMethod } from "./solaGateway";
import { invoiceReadyEmail } from "./emailTemplates";
import { renderBillingInvoicePdf } from "./pdf";
import { chargeBillingInvoice, chargeBillingInvoiceWithSut, refundBillingTransaction } from "./solaBillingPayments";
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
import { saveAdminCardWithSut } from "./adminCardSave";
import {
  agingToCsv,
  csvMeta,
  failedPaymentsToCsv,
  invoiceExportToCsv,
  queryAgingReport,
  queryFailedPaymentsReport,
  queryInvoiceExport,
  queryTransactionExport,
  todayDateSuffix,
  transactionExportToCsv,
} from "./billingReports";
import { assertBillingInvoiceDeletable } from "./deleteBillingInvoice";
import {
  markDoNotCharge,
  pauseInvoiceCollections,
  queryCollectionsOverview,
  queryPreviewRetries,
  readTenantCollectionsConfig,
  resumeInvoiceCollections,
  skipNextRetry as skipInvoiceNextRetry,
  validateTenantCollectionsConfigUpdate,
  writeTenantCollectionsConfig,
} from "./billingCollections";
import { validateScheduledPlanChangeEffectiveAt } from "./billingScheduledPlan";
import {
  aggregateBillingPlanUsageCounts,
  assertBillingPlanScheduleEligibility,
  attachUsageCountsToPlans,
  billingPlanCloneBodySchema,
  billingPlanCreateBodySchema,
  billingPlanPatchBodySchema,
  billingPlanTenantPreviews,
  catalogBillingPlansListWhere,
  deactivateBillingPlanBlockedReason,
  logBillingCatalogEvent,
  prismaUniqueViolation,
} from "./billingPlanCatalog";
import {
  ignoreSolaExternalSchedule,
  mapSolaExternalSchedule,
  syncSolaExternalSchedules,
  unmapSolaExternalSchedule,
} from "./solaExternalSchedules";
import {
  linkSolaTokenToPaymentMethod,
  getBillingCutoverReadiness,
  takeOverBillingFromSola,
} from "./solaCutover";

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

function parseBillingPeriodBounds(q: { periodMonth?: string; periodYear?: string }): { periodStart: Date; periodEnd: Date } | undefined {
  const rawMonth = Number.parseInt(String(q.periodMonth || ""), 10);
  const rawYear = Number.parseInt(String(q.periodYear || ""), 10);
  if (Number.isFinite(rawMonth) && rawMonth >= 1 && rawMonth <= 12 && Number.isFinite(rawYear) && rawYear >= 2020 && rawYear <= 2099) {
    const m = rawMonth - 1;
    return {
      periodStart: new Date(Date.UTC(rawYear, m, 1, 0, 0, 0, 0)),
      periodEnd: new Date(Date.UTC(rawYear, m + 1, 0, 23, 59, 59, 999)),
    };
  }
  return undefined;
}

function parseBoolQuery(v: unknown): boolean {
  const s = String(v ?? "").toLowerCase();
  return s === "1" || s === "true" || s === "yes";
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
  // Tenant: preview next invoice (read-only, no DB write, no invoice created).
  app.get("/billing/invoice-preview", async (req, reply) => {
    const u = await requireTenantBilling(req, reply);
    if (!u) return;
    return buildBillingInvoicePreview({ tenantId: u.tenantId });
  });

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
    const payload = { tenant, settings, usage, preview, invoices, paymentMethods, taxProfiles, sola };
    return JSON.parse(
      JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ) as typeof payload;
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
        tollFreeDidPriceCents: z.number().int().nonnegative().nullable().optional(),
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
        billingPricingMode: z.enum(["catalog", "custom"]).nullable().optional(),
        billingFlatRate: z
          .object({
            enabled: z.boolean(),
            amountCents: z.number().int().nonnegative(),
            label: z.string().max(120).optional(),
            appliesTo: z.literal("extensions"),
          })
          .nullable()
          .optional(),
        billingQuantityOverrides: z
          .object({
            extensions: z
              .object({ mode: z.enum(["auto", "manual"]), quantity: z.number().int().min(0).max(100_000).nullable() })
              .optional(),
            virtualExtensions: z
              .object({ mode: z.enum(["auto", "manual"]), quantity: z.number().int().min(0).max(100_000).nullable() })
              .optional(),
            phoneNumbers: z
              .object({ mode: z.enum(["auto", "manual"]), quantity: z.number().int().min(0).max(100_000).nullable() })
              .optional(),
            tollFreeNumbers: z
              .object({ mode: z.enum(["auto", "manual"]), quantity: z.number().int().min(0).max(100_000).nullable() })
              .optional(),
            smsPackages: z
              .object({ mode: z.enum(["auto", "manual"]), quantity: z.number().int().min(0).max(100_000).nullable() })
              .optional(),
          })
          .nullable()
          .optional(),
        billingTelecomFees: billingTelecomFeesPutSchema().nullable().optional(),
        billingScheduleOverride: z
          .object({
            nextPaymentDate: z.string().nullable().optional(),
            skipNextPayment: z.boolean().optional(),
            skipReason: z.string().max(500).nullable().optional(),
            updatedBy: z.string().max(200).optional(),
            updatedAt: z.string().optional(),
          })
          .nullable()
          .optional(),
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
      billingPricingMode,
      billingFlatRate,
      billingQuantityOverrides,
      tollFreeDidPriceCents,
      billingTelecomFees,
      billingScheduleOverride,
      ...pricing
    } = input as any;
    const pricingData = Object.fromEntries(Object.entries(pricing).filter(([, v]) => v !== undefined));
    let mergedMetadata: Record<string, unknown> | undefined;
    let pricingModeChangeFrom: ReturnType<typeof parseBillingPricingMode> | null = null;
    let flatRatePatch: ReturnType<typeof validateBillingFlatRateInput> | null = null;
    let quantityOverridesPatch: ReturnType<typeof validateBillingQuantityOverridesInput> | null = null;
    let telecomFeesPatch: ReturnType<typeof validateBillingTelecomFeesInput> | null = null;
    let scheduleOverridePatch: ReturnType<typeof validateBillingScheduleOverrideInput> | null = null;
    if (billingFlatRate !== undefined) {
      flatRatePatch = validateBillingFlatRateInput(billingFlatRate);
      if (!flatRatePatch.ok) {
        return reply.code(400).send({ error: "invalid_billing_flat_rate", message: flatRatePatch.error });
      }
    }
    if (billingQuantityOverrides !== undefined) {
      quantityOverridesPatch = validateBillingQuantityOverridesInput(billingQuantityOverrides);
      if (!quantityOverridesPatch.ok) {
        return reply.code(400).send({ error: "invalid_billing_quantity_overrides", message: quantityOverridesPatch.error });
      }
    }
    if (billingTelecomFees !== undefined) {
      telecomFeesPatch = validateBillingTelecomFeesInput(billingTelecomFees);
      if (!telecomFeesPatch.ok) {
        return reply.code(400).send({ error: "invalid_billing_telecom_fees", message: telecomFeesPatch.error });
      }
    }
    if (billingScheduleOverride !== undefined) {
      // Inject operatorId as updatedBy if not supplied
      const withOperator =
        billingScheduleOverride !== null
          ? { updatedBy: u.sub, updatedAt: new Date().toISOString(), ...billingScheduleOverride }
          : null;
      scheduleOverridePatch = validateBillingScheduleOverrideInput(withOperator);
      if (!scheduleOverridePatch.ok) {
        return reply.code(400).send({ error: "invalid_billing_schedule_override", message: scheduleOverridePatch.error });
      }
    }
    if (
      taxProviderId !== undefined ||
      billingPricingMode !== undefined ||
      billingFlatRate !== undefined ||
      billingQuantityOverrides !== undefined ||
      tollFreeDidPriceCents !== undefined ||
      billingTelecomFees !== undefined ||
      billingScheduleOverride !== undefined
    ) {
      const cur = await (db as any).tenantBillingSettings.findUnique({ where: { tenantId } });
      if (billingPricingMode !== undefined) {
        pricingModeChangeFrom = parseBillingPricingMode(cur?.metadata);
      }
      mergedMetadata = mergeTenantBillingSettingsMetadata(cur?.metadata, {
        ...(taxProviderId !== undefined ? { taxProviderId } : {}),
        ...(billingPricingMode !== undefined ? { billingPricingMode } : {}),
        ...(flatRatePatch?.ok ? { billingFlatRate: flatRatePatch.value } : {}),
        ...(quantityOverridesPatch?.ok ? { billingQuantityOverrides: quantityOverridesPatch.value } : {}),
        ...(tollFreeDidPriceCents !== undefined ? { tollFreeDidPriceCents } : {}),
        ...(telecomFeesPatch?.ok ? { billingTelecomFees: telecomFeesPatch.value } : {}),
        ...(scheduleOverridePatch?.ok ? { billingScheduleOverride: scheduleOverridePatch.value } : {}),
      });
    }
    const createUpdate = { ...pricingData, ...brandingPatch, ...(mergedMetadata !== undefined ? { metadata: mergedMetadata } : {}) };
    const saved = await (db as any).tenantBillingSettings.upsert({
      where: { tenantId },
      create: { tenantId, ...createUpdate },
      update: createUpdate,
    });
    if (billingPricingMode !== undefined && pricingModeChangeFrom !== null) {
      const meta = saved.metadata;
      const metaObj = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
      const toMode = parseBillingPricingMode(metaObj as unknown);
      if (toMode !== pricingModeChangeFrom) {
        await logBillingEvent({
          tenantId,
          type: "billing.pricing_mode_changed",
          metadata: {
            operatorId: u.sub,
            fromMode: pricingModeChangeFrom,
            toMode,
            pricingModeStored: metaObj[BILLING_PRICING_MODE_METADATA_KEY] ?? null,
          },
        }).catch(() => undefined);
      }
    }
    if (telecomFeesPatch?.ok && telecomFeesPatch.value && saved.taxProfileId) {
      const profilePatch = taxProfilePatchFromTelecomFees(telecomFeesPatch.value);
      await (db as any).taxProfile.update({
        where: { id: saved.taxProfileId },
        data: profilePatch,
      });
    }
    return saved;
  });

  /** Copy active BillingPlan prices onto tenant settings and set billingPricingMode=catalog. */
  app.post("/admin/billing/platform/tenants/:tenantId/pricing/reset-to-plan", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const settings = await ensureTenantBillingSettings(tenantId);
    const plan = settings.billingPlan;
    if (!plan) {
      return reply.code(400).send({
        error: "billing_plan_required",
        message: "Tenant has no current BillingPlan (billingPlanId). Assign or consume a scheduled plan change first.",
      });
    }
    const cur = await (db as any).tenantBillingSettings.findUnique({ where: { tenantId } });
    const beforeMode = parseBillingPricingMode(cur?.metadata ?? undefined);
    const beforePricing = {
      pricingMode: beforeMode,
      extensionPriceCents: Number(cur?.extensionPriceCents ?? 0),
      additionalPhoneNumberPriceCents: Number(cur?.additionalPhoneNumberPriceCents ?? 0),
      smsPriceCents: Number(cur?.smsPriceCents ?? 0),
      firstPhoneNumberFree: cur?.firstPhoneNumberFree !== false,
      metadataBillingPricingMode: (() => {
        const m = cur?.metadata;
        if (!m || typeof m !== "object" || Array.isArray(m)) return null;
        const v = (m as Record<string, unknown>)[BILLING_PRICING_MODE_METADATA_KEY];
        return v === "catalog" || v === "custom" ? v : null;
      })(),
    };
    const prevMeta =
      cur?.metadata && typeof cur.metadata === "object" && !Array.isArray(cur.metadata) ? { ...(cur.metadata as object) } : {};
    const patch = buildTenantSettingsResetToCatalog(plan, prevMeta);

    await (db as any).tenantBillingSettings.update({
      where: { tenantId },
      data: patch,
    });
    const updated = await ensureTenantBillingSettings(tenantId);
    const afterMode = parseBillingPricingMode(updated.metadata);
    const afterPricing = {
      pricingMode: afterMode,
      extensionPriceCents: Number(updated.extensionPriceCents),
      additionalPhoneNumberPriceCents: Number(updated.additionalPhoneNumberPriceCents),
      smsPriceCents: Number(updated.smsPriceCents),
      firstPhoneNumberFree: updated.firstPhoneNumberFree !== false,
      metadataBillingPricingMode: (() => {
        const m = updated.metadata;
        if (!m || typeof m !== "object" || Array.isArray(m)) return null;
        const v = (m as Record<string, unknown>)[BILLING_PRICING_MODE_METADATA_KEY];
        return v === "catalog" || v === "custom" ? v : null;
      })(),
    };
    await logBillingEvent({
      tenantId,
      type: "billing.pricing_reset_to_plan",
      metadata: {
        operatorId: u.sub,
        billingPlanId: plan.id,
        planCode: plan.code,
        before: beforePricing,
        after: afterPricing,
      },
    }).catch(() => undefined);
    return {
      billingSettings: updated,
      pricingResetSummary: { before: beforePricing, after: afterPricing },
    };
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

  // Admin: GET invoice preview with optional periodMonth (1–12) + periodYear query params.
  // Read-only — no invoice is created, no DB writes.
  app.get("/admin/billing/platform/tenants/:tenantId/invoice-preview", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const q = req.query as { periodMonth?: string; periodYear?: string };
    const rawMonth = Number.parseInt(String(q.periodMonth || ""), 10);
    const rawYear = Number.parseInt(String(q.periodYear || ""), 10);
    let periodStart: Date | undefined;
    let periodEnd: Date | undefined;
    if (Number.isFinite(rawMonth) && rawMonth >= 1 && rawMonth <= 12 && Number.isFinite(rawYear) && rawYear >= 2020 && rawYear <= 2099) {
      const m = rawMonth - 1;
      periodStart = new Date(Date.UTC(rawYear, m, 1, 0, 0, 0, 0));
      periodEnd = new Date(Date.UTC(rawYear, m + 1, 0, 23, 59, 59, 999));
    }
    return buildBillingInvoicePreview({ tenantId, periodStart, periodEnd });
  });

  app.get("/admin/billing/platform/tenants/:tenantId/pricing-diagnostics", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const q = req.query as { periodMonth?: string; periodYear?: string };
    const rawMonth = Number.parseInt(String(q.periodMonth || ""), 10);
    const rawYear = Number.parseInt(String(q.periodYear || ""), 10);
    let periodStart: Date | undefined;
    let periodEnd: Date | undefined;
    if (Number.isFinite(rawMonth) && rawMonth >= 1 && rawMonth <= 12 && Number.isFinite(rawYear) && rawYear >= 2020 && rawYear <= 2099) {
      const m = rawMonth - 1;
      periodStart = new Date(Date.UTC(rawYear, m, 1, 0, 0, 0, 0));
      periodEnd = new Date(Date.UTC(rawYear, m + 1, 0, 23, 59, 59, 999));
    }
    const preview = await buildBillingInvoicePreview({ tenantId, periodStart, periodEnd });
    const settingsRow = await ensureTenantBillingSettings(tenantId);
    const diag = buildTenantPricingDiagnosticsFromPreview({
      tenantId,
      settings: {
        metadata: settingsRow.metadata,
        billingPlanId: settingsRow.billingPlanId ?? null,
        billingPlan: settingsRow.billingPlan ?? null,
        nextBillingPlanId: settingsRow.nextBillingPlanId ?? null,
        nextBillingPlanEffectiveAt: settingsRow.nextBillingPlanEffectiveAt ?? null,
        nextBillingPlan: settingsRow.nextBillingPlan ?? null,
        extensionPriceCents: settingsRow.extensionPriceCents,
        additionalPhoneNumberPriceCents: settingsRow.additionalPhoneNumberPriceCents,
        smsPriceCents: settingsRow.smsPriceCents,
        firstPhoneNumberFree: settingsRow.firstPhoneNumberFree,
      },
      preview,
    });
    if (diag.resetToPlanPreview.canReset) {
      diag.notices.push(
        "Reset-to-plan copies prices from the CURRENT linked BillingPlan row only and sets billingPricingMode=catalog.",
      );
    }
    return diag;
  });

  const assignCurrentPlanBodySchema = z.object({
    billingPlanId: z.string().min(1),
    applyPricingMode: z.enum(["catalog", "custom"]).optional(),
    copyPlanPrices: z.boolean().optional(),
  });

  // Read-only simulation for assigning billingPlanId (+ optional meta/prices).
  app.get("/admin/billing/platform/tenants/:tenantId/assign-plan-preview", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const q = req.query as {
      billingPlanId?: string;
      periodMonth?: string;
      periodYear?: string;
      copyPlanPrices?: string;
      applyPricingMode?: string;
    };
    const billingPlanId = String(q.billingPlanId || "").trim();
    if (!billingPlanId) return reply.code(400).send({ error: "billing_plan_id_required" });

    const bounds = parseBillingPeriodBounds(q);
    const periodStart = bounds?.periodStart;
    const periodEnd = bounds?.periodEnd;

    const copyPlanPrices = parseBoolQuery(q.copyPlanPrices);
    let applyPricingMode: "catalog" | "custom" | undefined;
    if (q.applyPricingMode === "catalog" || q.applyPricingMode === "custom") applyPricingMode = q.applyPricingMode;

    const targetPlan = await (db as any).billingPlan.findUnique({ where: { id: billingPlanId } });
    const verr = validateCatalogBillingPlanForAssignment(targetPlan);
    if (verr) return reply.code(404).send({ error: verr });

    const settingsRow = await ensureTenantBillingSettings(tenantId);
    const merged = mergeTenantBillingSettingsForAssignPreview(settingsRow, targetPlan, { copyPlanPrices, applyPricingMode });

    const previewBefore = await buildBillingInvoicePreview({ tenantId, periodStart, periodEnd });
    const previewAfter = await buildBillingInvoicePreviewFromSettings({
      tenantId,
      settings: merged,
      periodStart,
      periodEnd,
    });

    const sliceBefore = billingPricingSettingsSliceFromLoaded(settingsRow);

    const pricingStateBefore = deriveBillingPricingState({ settings: sliceBefore, preview: previewBefore });

    const notes: string[] = [
      "Reset-to-plan copies prices from the CURRENT linked BillingPlan row only — not from a future scheduled plan.",
    ];
    if (previewBefore.scheduledPlanChange) {
      notes.push(
        "This preview period uses the scheduled next plan for invoice pricing. Assign-current-plan only updates billingPlanId (current FK); it does not consume or swap the scheduled plan.",
      );
    }

    return {
      tenantId,
      previewPeriod: {
        periodStart: previewBefore.periodStart.toISOString(),
        periodEnd: previewBefore.periodEnd.toISOString(),
      },
      simulation: { copyPlanPrices, applyPricingMode: applyPricingMode ?? null },
      targetPlan: {
        id: targetPlan.id,
        code: targetPlan.code,
        name: targetPlan.name,
        active: targetPlan.active,
      },
      tenantPricingQuad: {
        before: tenantPricingQuadSnapshot(settingsRow),
        after: tenantPricingQuadSnapshot(merged),
      },
      invoiceTotals: {
        before: { subtotalCents: previewBefore.subtotalCents, totalCents: previewBefore.totalCents },
        after: { subtotalCents: previewAfter.subtotalCents, totalCents: previewAfter.totalCents },
      },
      scheduledPlanActiveForPreviewPeriod: pricingStateBefore.flags.scheduledPlanAppliesToPreviewPeriod,
      notes,
    };
  });

  app.post("/admin/billing/platform/tenants/:tenantId/assign-current-plan", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const parsed = assignCurrentPlanBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.flatten() });
    }
    const body = parsed.data;

    const targetPlan = await (db as any).billingPlan.findUnique({ where: { id: body.billingPlanId } });
    const verr = validateCatalogBillingPlanForAssignment(targetPlan);
    if (verr) return reply.code(404).send({ error: verr });

    const cur = await ensureTenantBillingSettings(tenantId);
    const beforeQuad = tenantPricingQuadSnapshot(cur);
    const beforeBillingPlanId = cur.billingPlanId ?? null;
    const beforeModeStored = rawBillingPricingModeFromMetadata(cur.metadata);

    const updatePayload: Record<string, unknown> = {
      billingPlanId: body.billingPlanId,
    };
    if (body.copyPlanPrices) {
      updatePayload.extensionPriceCents = targetPlan.extensionPriceCents;
      updatePayload.additionalPhoneNumberPriceCents = targetPlan.additionalPhoneNumberPriceCents;
      updatePayload.smsPriceCents = targetPlan.smsPriceCents;
      updatePayload.firstPhoneNumberFree = targetPlan.firstPhoneNumberFree !== false;
    }
    if (body.applyPricingMode !== undefined) {
      updatePayload.metadata = mergeTenantBillingSettingsMetadata(cur.metadata, {
        billingPricingMode: body.applyPricingMode,
      });
    }

    await (db as any).tenantBillingSettings.update({
      where: { tenantId },
      data: updatePayload,
    });

    const updated = await ensureTenantBillingSettings(tenantId);
    const afterQuad = tenantPricingQuadSnapshot(updated);

    await logBillingEvent({
      tenantId,
      type: "billing_plan.current_assigned",
      metadata: {
        operatorUserId: u.sub,
        targetPlanId: targetPlan.id,
        copyPlanPrices: !!body.copyPlanPrices,
        applyPricingMode: body.applyPricingMode ?? null,
        before: {
          billingPlanId: beforeBillingPlanId,
          billingPricingMode: beforeModeStored,
          ...beforeQuad,
        },
        after: {
          billingPlanId: updated.billingPlanId ?? null,
          billingPricingMode: rawBillingPricingModeFromMetadata(updated.metadata),
          ...afterQuad,
        },
      },
    }).catch(() => undefined);

    return {
      billingSettings: updated,
      summary: {
        before: { billingPlanId: beforeBillingPlanId, pricing: beforeQuad, billingPricingMode: beforeModeStored },
        after: {
          billingPlanId: updated.billingPlanId,
          pricing: afterQuad,
          billingPricingMode: rawBillingPricingModeFromMetadata(updated.metadata),
        },
      },
    };
  });

  app.post("/admin/billing/tenants/:tenantId/invoices/preview", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    return buildBillingInvoicePreview({ tenantId });
  });

  // ── Platform billing catalog (SUPER_ADMIN) — BillingPlan tenantId=null only ─────────

  // List catalog BillingPlan rows (plan picker uses active-only subset by default).
  app.get("/admin/billing/platform/billing-plans", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const q = req.query as { includeInactive?: string };
    const includeInactive = q.includeInactive === "true" || q.includeInactive === "1";
    const plans = await (db as any).billingPlan.findMany({
      where: catalogBillingPlansListWhere(includeInactive),
      orderBy: { name: "asc" },
      select: {
        id: true,
        code: true,
        name: true,
        active: true,
        tenantId: true,
        createdAt: true,
        updatedAt: true,
        extensionPriceCents: true,
        additionalPhoneNumberPriceCents: true,
        smsPriceCents: true,
        firstPhoneNumberFree: true,
      },
    });
    const usage = await aggregateBillingPlanUsageCounts(db as any, plans.map((p: { id: string }) => p.id));
    return attachUsageCountsToPlans(plans, usage);
  });

  app.post("/admin/billing/platform/billing-plans", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const input = billingPlanCreateBodySchema.safeParse(req.body || {});
    if (!input.success) {
      const first = input.error.flatten().fieldErrors.code?.[0] || input.error.errors[0]?.message;
      return reply.code(400).send({ error: "invalid_body", message: first || "validation_failed", issues: input.error.flatten() });
    }
    const b = input.data;
    try {
      const created = await (db as any).billingPlan.create({
        data: {
          tenantId: null,
          code: b.code,
          name: b.name.trim(),
          extensionPriceCents: b.extensionPriceCents,
          additionalPhoneNumberPriceCents: b.additionalPhoneNumberPriceCents,
          smsPriceCents: b.smsPriceCents,
          firstPhoneNumberFree: b.firstPhoneNumberFree,
          active: b.active ?? true,
        },
      });
      await logBillingCatalogEvent(db as any, {
        operatorId: u.sub,
        type: "billing_plan.created",
        metadata: {
          planId: created.id,
          code: created.code,
          name: created.name,
          extensionPriceCents: created.extensionPriceCents,
          additionalPhoneNumberPriceCents: created.additionalPhoneNumberPriceCents,
          smsPriceCents: created.smsPriceCents,
          firstPhoneNumberFree: created.firstPhoneNumberFree,
          active: created.active,
        },
      });
      const usage = await aggregateBillingPlanUsageCounts(db as any, [created.id]);
      const counts = usage.get(created.id) ?? { currentTenantCount: 0, scheduledTenantCount: 0 };
      return { ...created, ...counts };
    } catch (e) {
      if (prismaUniqueViolation(e)) {
        return reply.code(409).send({ error: "billing_plan_code_taken", message: "A plan with this code already exists." });
      }
      throw e;
    }
  });

  app.get("/admin/billing/platform/billing-plans/:id", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const plan = await (db as any).billingPlan.findUnique({
      where: { id },
    });
    if (!plan || plan.tenantId != null) {
      return reply.code(404).send({ error: "billing_plan_not_found" });
    }
    const usage = await aggregateBillingPlanUsageCounts(db as any, [id]);
    const counts = usage.get(id) ?? { currentTenantCount: 0, scheduledTenantCount: 0 };
    const { currentTenantsPreview, scheduledTenantsPreview } = await billingPlanTenantPreviews(db as any, id);
    return { ...plan, ...counts, currentTenantsPreview, scheduledTenantsPreview };
  });

  app.patch("/admin/billing/platform/billing-plans/:id", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    let patch: z.infer<typeof billingPlanPatchBodySchema>;
    try {
      patch = billingPlanPatchBodySchema.parse(req.body || {});
    } catch {
      return reply.code(400).send({ error: "invalid_body", message: "Request body invalid or contained unknown/forbidden keys (code/tenantId cannot be PATCHed)." });
    }
    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: "billing_plan_patch_empty" });
    }
    const existing = await (db as any).billingPlan.findUnique({
      where: { id },
    });
    if (!existing || existing.tenantId != null) {
      return reply.code(404).send({ error: "billing_plan_not_found" });
    }
    const usage = await aggregateBillingPlanUsageCounts(db as any, [id]);
    const counts = usage.get(id) ?? { currentTenantCount: 0, scheduledTenantCount: 0 };
    const deactivating = existing.active === true && patch.active === false;
    if (deactivating) {
      const blocked = deactivateBillingPlanBlockedReason(counts);
      if (blocked) return reply.code(400).send({ error: blocked });
    }
    const updated = await (db as any).billingPlan.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.extensionPriceCents !== undefined ? { extensionPriceCents: patch.extensionPriceCents } : {}),
        ...(patch.additionalPhoneNumberPriceCents !== undefined ? { additionalPhoneNumberPriceCents: patch.additionalPhoneNumberPriceCents } : {}),
        ...(patch.smsPriceCents !== undefined ? { smsPriceCents: patch.smsPriceCents } : {}),
        ...(patch.firstPhoneNumberFree !== undefined ? { firstPhoneNumberFree: patch.firstPhoneNumberFree } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
      },
    });

    const metaBase = { planId: id, code: updated.code };
    if (deactivating) {
      await logBillingCatalogEvent(db as any, {
        operatorId: u.sub,
        type: "billing_plan.deactivated",
        metadata: {
          ...metaBase,
          before: {
            active: existing.active,
            name: existing.name,
            extensionPriceCents: existing.extensionPriceCents,
            additionalPhoneNumberPriceCents: existing.additionalPhoneNumberPriceCents,
            smsPriceCents: existing.smsPriceCents,
            firstPhoneNumberFree: existing.firstPhoneNumberFree,
          },
          after: {
            active: updated.active,
            name: updated.name,
            extensionPriceCents: updated.extensionPriceCents,
            additionalPhoneNumberPriceCents: updated.additionalPhoneNumberPriceCents,
            smsPriceCents: updated.smsPriceCents,
            firstPhoneNumberFree: updated.firstPhoneNumberFree,
          },
        },
      });
    } else {
      await logBillingCatalogEvent(db as any, {
        operatorId: u.sub,
        type: "billing_plan.updated",
        metadata: {
          ...metaBase,
          patch,
          before: {
            active: existing.active,
            name: existing.name,
            extensionPriceCents: existing.extensionPriceCents,
            additionalPhoneNumberPriceCents: existing.additionalPhoneNumberPriceCents,
            smsPriceCents: existing.smsPriceCents,
            firstPhoneNumberFree: existing.firstPhoneNumberFree,
          },
          after: {
            active: updated.active,
            name: updated.name,
            extensionPriceCents: updated.extensionPriceCents,
            additionalPhoneNumberPriceCents: updated.additionalPhoneNumberPriceCents,
            smsPriceCents: updated.smsPriceCents,
            firstPhoneNumberFree: updated.firstPhoneNumberFree,
          },
        },
      });
    }

    const usageAfter = await aggregateBillingPlanUsageCounts(db as any, [id]);
    const countsAfter = usageAfter.get(id) ?? { currentTenantCount: 0, scheduledTenantCount: 0 };
    return { ...updated, ...countsAfter };
  });

  app.post("/admin/billing/platform/billing-plans/:id/clone", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    let cloneBody: z.infer<typeof billingPlanCloneBodySchema>;
    try {
      cloneBody = billingPlanCloneBodySchema.parse(req.body || {});
    } catch {
      return reply.code(400).send({ error: "invalid_body", message: "Expected { code, name } slug fields only." });
    }
    const source = await (db as any).billingPlan.findUnique({ where: { id } });
    if (!source || source.tenantId != null) {
      return reply.code(404).send({ error: "billing_plan_not_found" });
    }
    try {
      const created = await (db as any).billingPlan.create({
        data: {
          tenantId: null,
          code: cloneBody.code,
          name: cloneBody.name.trim(),
          extensionPriceCents: source.extensionPriceCents,
          additionalPhoneNumberPriceCents: source.additionalPhoneNumberPriceCents,
          smsPriceCents: source.smsPriceCents,
          firstPhoneNumberFree: source.firstPhoneNumberFree,
          active: true,
        },
      });
      await logBillingCatalogEvent(db as any, {
        operatorId: u.sub,
        type: "billing_plan.cloned",
        metadata: {
          sourcePlanId: id,
          planId: created.id,
          code: created.code,
          name: created.name,
        },
      });
      const usage = await aggregateBillingPlanUsageCounts(db as any, [created.id]);
      const counts = usage.get(created.id) ?? { currentTenantCount: 0, scheduledTenantCount: 0 };
      return { ...created, ...counts };
    } catch (e) {
      if (prismaUniqueViolation(e)) {
        return reply.code(409).send({ error: "billing_plan_code_taken", message: "A plan with this code already exists." });
      }
      throw e;
    }
  });

  // ── Scheduled plan change routes ──────────────────────────────────────────

  // Get the current scheduled plan change for a tenant (null fields = none scheduled).
  app.get("/admin/billing/platform/tenants/:tenantId/scheduled-plan-change", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const settings = await (db as any).tenantBillingSettings.findUnique({
      where: { tenantId },
      select: { nextBillingPlanId: true, nextBillingPlanEffectiveAt: true, nextBillingPlan: { select: { id: true, code: true, name: true, extensionPriceCents: true, additionalPhoneNumberPriceCents: true, smsPriceCents: true, firstPhoneNumberFree: true } } },
    });
    if (!settings) {
      return { tenantId, nextBillingPlanId: null, nextBillingPlanEffectiveAt: null, nextBillingPlan: null };
    }
    return { tenantId, nextBillingPlanId: settings.nextBillingPlanId, nextBillingPlanEffectiveAt: settings.nextBillingPlanEffectiveAt, nextBillingPlan: settings.nextBillingPlan };
  });

  // Schedule a plan change for a future billing period.
  // Body: { nextBillingPlanId: string, effectiveAt: ISO8601 UTC date (first of a future month) }
  // Replaces any existing scheduled change (POST is idempotent-overwrite).
  app.post("/admin/billing/platform/tenants/:tenantId/scheduled-plan-change", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const input = z.object({
      nextBillingPlanId: z.string().min(1),
      effectiveAt: z.string().min(1),
    }).parse(req.body || {});

    // Parse and validate effectiveAt via shared helper (also unit-tested separately)
    const effectiveValidation = validateScheduledPlanChangeEffectiveAt(input.effectiveAt);
    if (!effectiveValidation.ok) {
      return reply.code(400).send({ error: effectiveValidation.error });
    }
    const effectiveAt = effectiveValidation.effectiveAt;

    const planRow = await (db as any).billingPlan.findUnique({
      where: { id: input.nextBillingPlanId },
      select: { id: true, code: true, name: true, active: true, extensionPriceCents: true, additionalPhoneNumberPriceCents: true, smsPriceCents: true, firstPhoneNumberFree: true },
    });
    const scheduleEligibility = assertBillingPlanScheduleEligibility(planRow);
    if (!scheduleEligibility.ok) {
      if (scheduleEligibility.error === "billing_plan_not_found") return reply.code(404).send({ error: "billing_plan_not_found" });
      return reply.code(400).send({ error: "billing_plan_inactive" });
    }
    const plan = scheduleEligibility.plan;

    // Read current state for audit
    const cur = await (db as any).tenantBillingSettings.findUnique({
      where: { tenantId },
      select: { nextBillingPlanId: true, nextBillingPlanEffectiveAt: true },
    });

    await (db as any).tenantBillingSettings.upsert({
      where: { tenantId },
      create: { tenantId, nextBillingPlanId: input.nextBillingPlanId, nextBillingPlanEffectiveAt: effectiveAt },
      update: { nextBillingPlanId: input.nextBillingPlanId, nextBillingPlanEffectiveAt: effectiveAt },
    });

    await logBillingEvent({
      tenantId,
      type: "billing_plan.scheduled_change_set",
      metadata: {
        operatorId: u.sub,
        previousNextPlanId: cur?.nextBillingPlanId ?? null,
        previousEffectiveAt: cur?.nextBillingPlanEffectiveAt ?? null,
        nextBillingPlanId: input.nextBillingPlanId,
        planName: plan.name,
        effectiveAt: effectiveAt.toISOString(),
      },
    });

    return { tenantId, nextBillingPlanId: plan.id, nextBillingPlanEffectiveAt: effectiveAt, nextBillingPlan: plan };
  });

  // Cancel the scheduled plan change — clears both fields.
  app.delete("/admin/billing/platform/tenants/:tenantId/scheduled-plan-change", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };

    const cur = await (db as any).tenantBillingSettings.findUnique({
      where: { tenantId },
      select: { nextBillingPlanId: true, nextBillingPlanEffectiveAt: true },
    });
    if (!cur?.nextBillingPlanId) {
      return reply.code(404).send({ error: "no_scheduled_plan_change" });
    }

    await (db as any).tenantBillingSettings.update({
      where: { tenantId },
      data: { nextBillingPlanId: null, nextBillingPlanEffectiveAt: null },
    });

    await logBillingEvent({
      tenantId,
      type: "billing_plan.scheduled_change_cancelled",
      metadata: {
        operatorId: u.sub,
        cancelledNextPlanId: cur.nextBillingPlanId,
        cancelledEffectiveAt: cur.nextBillingPlanEffectiveAt,
      },
    });

    return { tenantId, nextBillingPlanId: null, nextBillingPlanEffectiveAt: null };
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
        invoice: { select: { id: true, invoiceNumber: true, status: true, totalCents: true, balanceDueCents: true } },
        paymentMethod: { select: { id: true, brand: true, last4: true, expMonth: true, expYear: true, cardholderName: true } },
      },
    });
    if (!tx) return reply.code(404).send({ error: "transaction_not_found" });
    const events = tx.invoiceId
      ? await (db as any).billingEventLog.findMany({
          where: { invoiceId: tx.invoiceId },
          orderBy: { createdAt: "desc" },
          take: 24,
          select: { id: true, type: true, message: true, createdAt: true },
        })
      : [];
    return { ...tx, events };
  });

  app.post("/admin/billing/transactions/:id/refund", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const input = z.object({
      reason: z.string().max(500).optional(),
      confirmLive: z.boolean().optional(),
    }).parse(req.body || {});
    const tx = await (db as any).paymentTransaction.findUnique({
      where: { id },
      include: { tenant: { include: { billingSolaConfig: true } } },
    });
    if (!tx) return reply.code(404).send({ error: "transaction_not_found" });
    const sc = tx.tenant?.billingSolaConfig;
    const isLive = !!(sc?.isEnabled && sc.mode === "PROD" && !sc.simulate);
    if (isLive && !input.confirmLive) {
      return reply.code(400).send({ error: "confirm_live_required", message: "Set confirmLive: true to confirm this live refund." });
    }
    try {
      const result = await refundBillingTransaction(id, { reason: input.reason, adminUserId: u.sub });
      if (!result.processorResponse.approved) {
        return reply.code(402).send({
          error: "refund_declined",
          message: result.processorResponse.xError || result.processorResponse.xStatus || "Refund declined at processor.",
          transaction: result.transaction,
        });
      }
      return result;
    } catch (err: any) {
      const code = err?.code === "TRANSACTION_NOT_REFUNDABLE" ? 400 : err?.code === "PROCESSOR_REF_MISSING" ? 400 : 500;
      return reply.code(code).send({ error: err?.code || "refund_failed", message: err?.message });
    }
  });

  app.post("/admin/billing/platform/tenants/:tenantId/one-time-charges", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const input = z.object({
      description: z.string().min(1).max(240),
      amountCents: z.number().int().min(1),
      operatorNote: z.string().max(500).optional(),
      invoiceMemo: z.string().max(500).optional(),
      chargeMode: z.enum(["none", "card_on_file", "new_card"]).default("none"),
      paymentMethodId: z.string().optional(),
      xSut: z.string().optional(),
      cardholderName: z.string().optional(),
      billingZip: z.string().optional(),
      saveCard: z.boolean().optional(),
      makeDefault: z.boolean().optional(),
      confirmLive: z.boolean().optional(),
    }).parse(req.body || {});

    const tenant = await (db as any).tenant.findUnique({ where: { id: tenantId }, include: { billingSolaConfig: true } });
    if (!tenant) return reply.code(404).send({ error: "tenant_not_found" });

    let invoice;
    try {
      invoice = await createOneTimeChargeInvoice({
        tenantId,
        description: input.description,
        amountCents: input.amountCents,
        operatorNote: input.operatorNote,
        invoiceMemo: input.invoiceMemo,
        adminUserId: u.sub,
      });
    } catch (err: any) {
      if (err?.code === "INVALID_AMOUNT") return reply.code(400).send({ error: "invalid_amount" });
      throw err;
    }

    let transaction = null;
    if (input.chargeMode === "card_on_file") {
      if (!input.paymentMethodId) return reply.code(400).send({ error: "payment_method_required" });
      const sc = tenant.billingSolaConfig;
      const isLive = !!(sc?.isEnabled && sc.mode === "PROD" && !sc.simulate);
      if (isLive && !input.confirmLive) {
        return reply.code(400).send({ error: "confirm_live_required", message: "Set confirmLive: true to confirm this live charge." });
      }
      const method = await (db as any).paymentMethod.findFirst({ where: { id: input.paymentMethodId, tenantId, active: true } });
      if (!method) return reply.code(400).send({ error: "payment_method_not_found" });
      transaction = await chargeBillingInvoice(invoice, method, { note: input.operatorNote });
    } else if (input.chargeMode === "new_card") {
      if (!input.xSut) return reply.code(400).send({ error: "sola_token_required" });
      const sc = tenant.billingSolaConfig;
      const isLive = !!(sc?.isEnabled && sc.mode === "PROD" && !sc.simulate);
      if (isLive && !input.confirmLive) {
        return reply.code(400).send({ error: "confirm_live_required", message: "Set confirmLive: true to confirm this live charge." });
      }
      if (input.saveCard) {
        const saved = await saveAdminCardWithSut(tenantId, {
          xSut: input.xSut,
          cardholderName: input.cardholderName,
          billingZip: input.billingZip,
          makeDefault: input.makeDefault ?? false,
        }, u.sub, {
          findTenant: (id) => (db as any).tenant.findUnique({ where: { id }, select: { id: true } }),
          getAdapter: getBillingSolaAdapter,
          storeMethod: storeSolaPaymentMethod,
          logEvent: logBillingEvent,
        });
        if (!saved.ok) {
          return reply.code(saved.code).send({ error: saved.error });
        }
        const method = await (db as any).paymentMethod.findUnique({ where: { id: saved.id } });
        transaction = await chargeBillingInvoice(invoice, method, { note: input.operatorNote });
      } else {
        transaction = await chargeBillingInvoiceWithSut(invoice, {
          xSut: input.xSut,
          cardholderName: input.cardholderName,
          billingZip: input.billingZip,
        }, { note: input.operatorNote });
      }
    }

    const updatedInvoice = await (db as any).billingInvoice.findUnique({ where: { id: invoice.id } });
    return { invoice: updatedInvoice, transaction };
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

  // ── Billing reports ─────────────────────────────────────────────────────────

  app.get("/admin/billing/reports/aging", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const q = req.query as { tenantId?: string };
    const { rows, capped } = await queryAgingReport(db as any, { tenantId: q.tenantId });
    return { rows, capped, rowCap: rows.length };
  });

  app.get("/admin/billing/reports/aging/export", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const q = req.query as { tenantId?: string };
    const generatedBy = (u as any).email || (u as any).sub || "SUPER_ADMIN";
    const { rows, capped } = await queryAgingReport(db as any, { tenantId: q.tenantId });
    const meta = csvMeta("Billing Aging Report", generatedBy);
    const csv = agingToCsv(rows, meta);
    const filename = `billing-aging-${todayDateSuffix()}.csv`;
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .header("X-Report-Capped", capped ? "true" : "false")
      .send(csv);
  });

  app.get("/admin/billing/reports/failed-payments", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const q = req.query as { tenantId?: string };
    const { rows, capped } = await queryFailedPaymentsReport(db as any, { tenantId: q.tenantId });
    return { rows, capped, rowCap: rows.length };
  });

  app.get("/admin/billing/reports/failed-payments/export", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const q = req.query as { tenantId?: string };
    const generatedBy = (u as any).email || (u as any).sub || "SUPER_ADMIN";
    const { rows, capped } = await queryFailedPaymentsReport(db as any, { tenantId: q.tenantId });
    const meta = csvMeta("Billing Failed Payments Report", generatedBy);
    const csv = failedPaymentsToCsv(rows, meta);
    const filename = `billing-failed-payments-${todayDateSuffix()}.csv`;
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .header("X-Report-Capped", capped ? "true" : "false")
      .send(csv);
  });

  app.get("/admin/billing/reports/export/invoices", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const q = req.query as { status?: string; tenantId?: string };
    const generatedBy = (u as any).email || (u as any).sub || "SUPER_ADMIN";
    const { rows, capped } = await queryInvoiceExport(db as any, { status: q.status, tenantId: q.tenantId });
    const meta = csvMeta("Billing Invoice Export", generatedBy);
    const csv = invoiceExportToCsv(rows, meta);
    const filename = `billing-invoices-${todayDateSuffix()}.csv`;
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .header("X-Report-Capped", capped ? "true" : "false")
      .send(csv);
  });

  app.get("/admin/billing/reports/export/transactions", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const q = req.query as { status?: string; tenantId?: string };
    const generatedBy = (u as any).email || (u as any).sub || "SUPER_ADMIN";
    const { rows, capped } = await queryTransactionExport(db as any, { status: q.status, tenantId: q.tenantId });
    const meta = csvMeta("Billing Transaction Export", generatedBy);
    const csv = transactionExportToCsv(rows, meta);
    const filename = `billing-transactions-${todayDateSuffix()}.csv`;
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .header("X-Report-Capped", capped ? "true" : "false")
      .send(csv);
  });

  // ── Collections: read-only overview ──────────────────────────────────────

  app.get("/admin/billing/collections/overview", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const q = req.query as { tenantId?: string };
    const overview = await queryCollectionsOverview(db as any, { tenantId: q.tenantId });
    return overview;
  });

  app.get("/admin/billing/collections/preview-retries", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const q = req.query as { tenantId?: string };
    const preview = await queryPreviewRetries(db as any, { tenantId: q.tenantId });
    return preview;
  });

  // ── Collections: per-tenant config ───────────────────────────────────────

  app.get("/admin/billing/platform/tenants/:tenantId/collections-config", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const settings = await (db as any).tenantBillingSettings.findUnique({ where: { tenantId } });
    if (!settings) return reply.code(404).send({ error: "tenant_billing_settings_not_found" });
    return { tenantId, collections: readTenantCollectionsConfig(settings.metadata) };
  });

  app.put("/admin/billing/platform/tenants/:tenantId/collections-config", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const body = req.body as any;
    const validation = validateTenantCollectionsConfigUpdate(body);
    if (!validation.ok) return reply.code(400).send({ error: "validation_error", message: validation.error });

    const settings = await (db as any).tenantBillingSettings.findUnique({ where: { tenantId } });
    if (!settings) return reply.code(404).send({ error: "tenant_billing_settings_not_found" });

    const newMeta = writeTenantCollectionsConfig(settings.metadata, {
      dunningEnabled: "dunningEnabled" in body ? body.dunningEnabled : undefined,
      maxAttempts: "maxAttempts" in body ? body.maxAttempts : undefined,
      retryDelayHours: "retryDelayHours" in body ? body.retryDelayHours : undefined,
    });
    await (db as any).tenantBillingSettings.update({ where: { tenantId }, data: { metadata: newMeta } });
    await (db as any).billingEventLog.create({
      data: {
        tenantId,
        type: "collections_action",
        message: `collections-config updated by ${(u as any).email || (u as any).sub}`,
        metadata: {
          action: "update_collections_config",
          operatorId: (u as any).sub,
          reason: body.reason ?? null,
          prevState: readTenantCollectionsConfig(settings.metadata),
          nextState: readTenantCollectionsConfig(newMeta),
        },
      },
    });
    return { tenantId, collections: readTenantCollectionsConfig(newMeta) };
  });

  // ── Collections: per-invoice actions ─────────────────────────────────────

  app.post("/admin/billing/invoices/:id/collections/pause", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const body = req.body as any;
    const result = await pauseInvoiceCollections(db as any, id, (u as any).sub, body?.reason ?? null);
    if (!result.ok) {
      const code = result.code === "invoice_not_found" ? 404 : 400;
      return reply.code(code).send({ error: result.code, message: result.error });
    }
    return result;
  });

  app.post("/admin/billing/invoices/:id/collections/resume", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const result = await resumeInvoiceCollections(db as any, id, (u as any).sub);
    if (!result.ok) {
      const code = result.code === "invoice_not_found" ? 404 : 400;
      return reply.code(code).send({ error: result.code, message: result.error });
    }
    return result;
  });

  app.post("/admin/billing/invoices/:id/collections/skip-next-retry", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const result = await skipInvoiceNextRetry(db as any, id, (u as any).sub);
    if (!result.ok) {
      const code = result.code === "invoice_not_found" ? 404 : 400;
      return reply.code(code).send({ error: result.code, message: result.error });
    }
    return result;
  });

  app.post("/admin/billing/invoices/:id/collections/do-not-charge", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const body = req.body as any;
    const result = await markDoNotCharge(db as any, id, (u as any).sub, body?.reason ?? null);
    if (!result.ok) {
      const code = result.code === "invoice_not_found" ? 404 : 400;
      return reply.code(code).send({ error: result.code, message: result.error });
    }
    return result;
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

  app.delete("/admin/billing/invoices/:id", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const invoice = await (db as any).billingInvoice.findUnique({
      where: { id },
      include: { transactions: { select: { status: true } } },
    });
    if (!invoice) return reply.code(404).send({ error: "invoice_not_found" });
    const guard = assertBillingInvoiceDeletable(invoice);
    if (!guard.ok) return reply.code(400).send({ error: guard.error, message: guard.message });
    await logBillingEvent({
      tenantId: invoice.tenantId,
      invoiceId: id,
      type: "invoice.deleted",
      message: `Invoice ${invoice.invoiceNumber || id} permanently deleted.`,
      metadata: {
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        totalCents: invoice.totalCents,
        deletedBy: u.sub,
      },
    });
    await (db as any).billingInvoice.delete({ where: { id } });
    return { ok: true, deletedId: id };
  });

  // ── Admin tenant payment-method management ──────────────────────────────────

  app.get("/admin/billing/platform/tenants/:tenantId/sola/public-config", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    if (!ensureCredentialCrypto(reply)) return;
    const { tenantId } = req.params as { tenantId: string };
    const record = await (db as any).billingSolaConfig.findUnique({ where: { tenantId } });
    if (!record) return { configured: false, enabled: false, ifieldsKey: null, mode: null };
    let secrets: SolaCredentialPayload;
    try {
      secrets = decryptJson<SolaCredentialPayload>(record.credentialsEncrypted);
    } catch {
      return reply.code(400).send({ error: "sola_decrypt_failed" });
    }
    return {
      configured: true,
      enabled: !!record.isEnabled,
      // canSaveCard is true whenever configured (isEnabled not required — saving a card never charges)
      canSaveCard: true,
      mode: record.mode === "PROD" ? "prod" : "sandbox",
      ifieldsKey: secrets.ifieldsKey || null,
    };
  });

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

  app.post("/admin/billing/platform/tenants/:tenantId/payment-methods/sola/save", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const input = z.object({
      xSut: z.string().min(1),
      cardholderName: z.string().optional(),
      billingZip: z.string().optional(),
      makeDefault: z.boolean().default(false),
    }).parse(req.body || {});
    const result = await saveAdminCardWithSut(tenantId, input, u.sub, {
      findTenant: (id) => (db as any).tenant.findUnique({ where: { id }, select: { id: true } }),
      getAdapter: getBillingSolaAdapterForTokenizing,
      storeMethod: storeSolaPaymentMethod,
      logEvent: logBillingEvent,
    });
    if (!result.ok) {
      if (result.code === 404) return reply.code(404).send({ error: result.error });
      return reply.code(result.code).send({ error: result.error, ...(result.code === 402 ? { response: (result as any).response } : {}) });
    }
    return { id: result.id, brand: result.brand, last4: result.last4, expMonth: result.expMonth, expYear: result.expYear, isDefault: result.isDefault };
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

  app.post("/admin/billing/platform/sola-import/sync", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const body = z
      .object({
        tenantId: z.string().optional(),
        includeCardMetadata: z.boolean().optional(),
      })
      .parse(req.body || {});
    try {
      const result = await syncSolaExternalSchedules({
        operatorId: u.sub,
        tenantId: body.tenantId || null,
        includeCardMetadata: body.includeCardMetadata,
      });
      return result;
    } catch (e: any) {
      if (e?.code === "SOLA_NOT_ENABLED") {
        return reply.code(400).send({
          error: "sola_not_enabled",
          message:
            "SOLA is saved for this company but not enabled. Open Admin Billing → Settings → Payment gateway, test the connection, then enable SOLA.",
        });
      }
      if (e?.code === "SOLA_NOT_CONFIGURED" || e?.code === "SOLA_RECURRING_NOT_CONFIGURED") {
        return reply.code(400).send({
          error: "sola_not_configured",
          message:
            "No SOLA API key available for import. Enable SOLA under Admin Billing → Settings for a company, or set SOLA_CARDKNOX_API_KEY on the API service.",
        });
      }
      throw e;
    }
  });

  app.get("/admin/billing/platform/sola-import/schedules", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const q = req.query as {
      status?: string;
      search?: string;
      tenantId?: string;
      active?: string;
      page?: string;
      limit?: string;
    };
    const page = Math.max(1, Number.parseInt(String(q.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(q.limit || "50"), 10) || 50));
    const where: Record<string, unknown> = {};
    if (q.status && ["UNMAPPED", "MAPPED", "IGNORED", "CONFLICT"].includes(q.status.toUpperCase())) {
      where.mappingStatus = q.status.toUpperCase();
    }
    if (q.tenantId) where.tenantId = q.tenantId;
    if (q.active === "true") where.isActive = true;
    if (q.active === "false") where.isActive = false;
    if (q.search?.trim()) {
      const s = q.search.trim();
      where.OR = [
        { customerName: { contains: s, mode: "insensitive" } },
        { customerEmail: { contains: s, mode: "insensitive" } },
        { companyName: { contains: s, mode: "insensitive" } },
        { solaScheduleId: { contains: s, mode: "insensitive" } },
        { last4: { contains: s } },
      ];
    }

    const [total, rows] = await Promise.all([
      (db as any).billingSolaExternalScheduleLink.count({ where }),
      (db as any).billingSolaExternalScheduleLink.findMany({
        where,
        orderBy: [{ mappingStatus: "asc" }, { nextRunAt: "asc" }, { createdAt: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const tenantIds = [
      ...new Set(
        rows.flatMap((r: { tenantId: string | null; suggestedTenantId: string | null }) =>
          [r.tenantId, r.suggestedTenantId].filter(Boolean),
        ),
      ),
    ] as string[];
    const tenants =
      tenantIds.length > 0
        ? await (db as any).tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })
        : [];
    const tenantNameById = new Map(tenants.map((t: { id: string; name: string }) => [t.id, t.name]));

    const schedules = rows.map((r: Record<string, unknown>) => ({
      ...r,
      tenantName: r.tenantId ? tenantNameById.get(String(r.tenantId)) || null : null,
      suggestedTenantName: r.suggestedTenantId ? tenantNameById.get(String(r.suggestedTenantId)) || null : null,
    }));

    return { schedules, total, page, pages: Math.max(1, Math.ceil(total / limit)), limit };
  });

  app.post("/admin/billing/platform/sola-import/schedules/:id/map", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const body = z.object({ tenantId: z.string().min(1) }).parse(req.body || {});
    const result = await mapSolaExternalSchedule({ linkId: id, tenantId: body.tenantId, operatorId: u.sub });
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    return result.link;
  });

  app.post("/admin/billing/platform/sola-import/schedules/:id/ignore", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const result = await ignoreSolaExternalSchedule({ linkId: id, operatorId: u.sub });
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    return { ok: true };
  });

  app.post("/admin/billing/platform/sola-import/schedules/:id/unmap", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const result = await unmapSolaExternalSchedule({ linkId: id, operatorId: u.sub });
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    return { ok: true };
  });

  // ─── Phase A: Token Linking ────────────────────────────────────────────────
  // POST /admin/billing/platform/sola-import/schedules/:id/link-token
  // Fetches Sola vault token, encrypts it, creates PaymentMethod (isImported=true).
  // Does NOT enable Connect autopay or disable old Sola schedule.
  app.post("/admin/billing/platform/sola-import/schedules/:id/link-token", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { id } = req.params as { id: string };
    const result = await linkSolaTokenToPaymentMethod({ linkId: id, operatorId: u.sub });
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    // Return masked card info only — token never returned to browser
    return {
      ok: true,
      paymentMethodId: result.paymentMethodId,
      brand: result.brand,
      last4: result.last4,
      expMonth: result.expMonth,
      expYear: result.expYear,
    };
  });

  // ─── Phase B: Readiness Check ─────────────────────────────────────────────
  // GET /admin/billing/platform/tenants/:tenantId/billing-cutover/readiness
  app.get("/admin/billing/platform/tenants/:tenantId/billing-cutover/readiness", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const readiness = await getBillingCutoverReadiness({ tenantId });
    return readiness;
  });

  // ─── Phase C: Take Over Billing ───────────────────────────────────────────
  // POST /admin/billing/platform/tenants/:tenantId/billing-cutover/take-over
  // Sequence: disable Sola schedule → set default PM → enable Connect autopay → mark CUTOVER_COMPLETE.
  // Requires three explicit confirmation fields. No immediate charge.
  app.post("/admin/billing/platform/tenants/:tenantId/billing-cutover/take-over", async (req, reply) => {
    const u = await requirePlatformBilling(req, reply);
    if (!u) return;
    const { tenantId } = req.params as { tenantId: string };
    const body = req.body as {
      solaScheduleLinkId?: string;
      linkedPaymentMethodId?: string;
      confirmDisableSolaSchedule?: boolean;
      confirmEnableConnectAutopay?: boolean;
      confirmNoImmediateCharge?: boolean;
    };

    if (!body.solaScheduleLinkId) return reply.code(400).send({ error: "solaScheduleLinkId_required" });
    if (!body.linkedPaymentMethodId) return reply.code(400).send({ error: "linkedPaymentMethodId_required" });
    if (!body.confirmDisableSolaSchedule) return reply.code(400).send({ error: "must_confirm_disable_sola_schedule" });
    if (!body.confirmEnableConnectAutopay) return reply.code(400).send({ error: "must_confirm_enable_connect_autopay" });
    if (!body.confirmNoImmediateCharge) return reply.code(400).send({ error: "must_confirm_no_immediate_charge" });

    const result = await takeOverBillingFromSola({
      tenantId,
      solaScheduleLinkId: body.solaScheduleLinkId,
      linkedPaymentMethodId: body.linkedPaymentMethodId,
      confirmDisableSolaSchedule: true,
      confirmEnableConnectAutopay: true,
      confirmNoImmediateCharge: true,
      operatorId: u.sub,
    });

    if (!result.ok) return reply.code(result.code).send({ error: result.error, disableError: result.disableError });
    return { ok: true, cutoverAt: result.cutoverAt, paymentMethodId: result.paymentMethodId };
  });
}

function billingTelecomFeeItemPutSchema() {
  return z.object({
    enabled: z.boolean(),
    customerVisible: z.boolean(),
    label: z.string().min(1).max(120),
    description: z.string().max(280).optional(),
    suggested: z.boolean().optional(),
    mode: z.enum(["ratePercent", "amountCents"]),
    ratePercent: z.number().min(0).max(1).nullable().optional(),
    amountCents: z.number().int().min(0).nullable().optional(),
    basis: z.enum([
      "invoice_subtotal",
      "per_extension",
      "per_did",
      "per_toll_free_did",
      "per_line",
      "flat_monthly",
    ]),
  });
}

function billingTelecomFeesPutSchema() {
  const item = billingTelecomFeeItemPutSchema();
  return z.object({
    salesTax: item.optional(),
    e911: item.optional(),
    regulatory: item.optional(),
    telecomSurcharge: item.optional(),
    usfRecovery: item.optional(),
    customFee: item.optional(),
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
