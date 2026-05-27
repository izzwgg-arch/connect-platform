import { db } from "@connect/db";
import { buildBillingEmailJobCreateData } from "./billingAuth";
import { invoiceSentEmail, paymentFailedEmail, paymentLinkEmail, paymentReceiptEmail } from "./emailTemplates";
import { clearDunningSlice } from "./billingDunning";
import { resolveInvoiceEmailBranding } from "./invoiceBranding";
import { createBillingInvoicePayToken } from "./billingPayToken";

export function publicPortalBaseUrl(): string {
  return (process.env.PUBLIC_PORTAL_URL || "https://app.connectcomunications.com").replace(/\/$/, "");
}

/** Browser API origin (JWT); PDF and pay routes live here. */
export function publicBillingApiBaseUrl(): string {
  const raw = (process.env.PUBLIC_API_BASE_URL || process.env.PUBLIC_API_URL || "").trim().replace(/\/$/, "");
  if (raw) return raw;
  return `${publicPortalBaseUrl()}/api`;
}

export function billingInvoicePortalUrl(invoiceId: string): string {
  return `${publicPortalBaseUrl()}/billing/invoices/${encodeURIComponent(invoiceId)}`;
}

/** Signed public pay URL (no login). PCI-safe Cardknox iFields on portal /pay/invoice/[token]. */
export function billingInvoicePublicPayUrl(invoiceId: string, tenantId: string): string {
  const token = createBillingInvoicePayToken(invoiceId, tenantId);
  return `${publicPortalBaseUrl()}/pay/invoice/${encodeURIComponent(token)}`;
}

export function billingInvoicePdfApiUrl(invoiceId: string): string {
  return `${publicBillingApiBaseUrl()}/billing/platform/invoices/${encodeURIComponent(invoiceId)}/pdf`;
}

async function logLifecycle(type: string, tenantId: string, invoiceId: string | null, message?: string | null, metadata?: Record<string, unknown>, runId?: string | null) {
  return (db as any).billingEventLog.create({
    data: { tenantId, invoiceId, runId: runId ?? null, type, message: message ?? null, metadata: metadata || undefined },
  });
}

async function hasBillingEmailJob(params: { tenantId: string; invoiceId: string; type: string }): Promise<boolean> {
  const marker = `connect-billing-invoice:${params.invoiceId}`;
  const j = await (db as any).emailJob.findFirst({
    where: {
      tenantId: params.tenantId,
      type: params.type,
      status: { in: ["QUEUED", "RUNNING", "SENT"] },
      htmlBody: { contains: marker },
    },
  });
  return !!j;
}

async function hasReceiptEmailForTransaction(transactionId: string): Promise<boolean> {
  const e = await (db as any).billingEventLog.findFirst({
    where: { type: "receipt_emailed", message: transactionId },
  });
  return !!e;
}

async function hasFailureEmailForTransaction(transactionId: string): Promise<boolean> {
  const e = await (db as any).billingEventLog.findFirst({
    where: { type: "payment_failed_emailed", message: transactionId },
  });
  return !!e;
}

/**
 * Parse a billing email field that may contain multiple comma-separated addresses.
 * Returns a normalized comma-separated string with each address trimmed,
 * or empty string if none are valid.
 *
 * Examples:
 *   "a@b.com"              → "a@b.com"
 *   "a@b.com, c@d.com"     → "a@b.com, c@d.com"
 *   "  a@b.com,c@d.com  "  → "a@b.com, c@d.com"
 */
export function normalizeMultiBillingEmail(raw: unknown): string {
  const str = String(raw || "").trim();
  if (!str) return "";
  return str
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .join(", ");
}

/**
 * Validate that a string (which may be comma-separated) contains only valid email addresses.
 * Returns true if every address passes a basic email format check.
 */
export function isValidMultiBillingEmail(raw: unknown): boolean {
  const str = String(raw || "").trim();
  if (!str) return true; // empty is allowed (nullable)
  const simple = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return str.split(",").every((e) => simple.test(e.trim()));
}

function invoiceMetadataEmail(metadata: unknown): string {
  const meta = (metadata || {}) as Record<string, unknown>;
  const candidates = [
    meta.billingEmail,
    meta.invoiceBillingEmail,
    meta.customerBillingEmail,
    meta.customerEmail,
    meta.billingContactEmail,
  ];
  for (const candidate of candidates) {
    const email = normalizeMultiBillingEmail(candidate);
    if (email) return email;
  }
  return "";
}

async function resolveBillingEmailRecipient(params: {
  tenantId: string;
  invoiceId?: string | null;
}): Promise<{ to: string; source: string; tenantName?: string | null; settings?: any }> {
  const [tenant, invoice] = await Promise.all([
    (db as any).tenant.findUnique({
      where: { id: params.tenantId },
      select: { name: true, billingSettings: true },
    }),
    params.invoiceId
      ? (db as any).billingInvoice.findUnique({
        where: { id: params.invoiceId },
        select: { metadata: true },
      }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const settings = tenant?.billingSettings;
  const tenantEmail = normalizeMultiBillingEmail(settings?.billingEmail);
  if (tenantEmail) return { to: tenantEmail, source: "tenant_billing_email", tenantName: tenant?.name, settings };

  const invoiceEmail = invoiceMetadataEmail(invoice?.metadata);
  if (invoiceEmail) return { to: invoiceEmail, source: "invoice_metadata", tenantName: tenant?.name, settings };

  return { to: "", source: "missing", tenantName: tenant?.name, settings };
}

/**
 * When a BillingInvoice is created/finalized (OPEN): queue one invoice email with invoiceId.
 * Skips if no billingEmail or if BILLING_INVOICE_SENT already queued/sent.
 */
export async function queueInvoiceSentOnFinalize(invoice: {
  id: string;
  tenantId: string;
  invoiceNumber: string;
  totalCents: number;
  balanceDueCents?: number;
  dueDate: Date;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}): Promise<{ queued: boolean; reason?: string }> {
  if (await hasBillingEmailJob({ tenantId: invoice.tenantId, invoiceId: invoice.id, type: "BILLING_INVOICE_SENT" })) {
    return { queued: false, reason: "already_sent" };
  }
  const recipient = await resolveBillingEmailRecipient({ tenantId: invoice.tenantId, invoiceId: invoice.id });
  const to = recipient.to;
  if (!to) {
    await logLifecycle("invoice_email_skipped", invoice.tenantId, invoice.id, "No billing email configured");
    return { queued: false, reason: "no_billing_email" };
  }
  const brand = resolveInvoiceEmailBranding(recipient.settings || {}, recipient.tenantName);
  const payUrl = billingInvoicePublicPayUrl(invoice.id, invoice.tenantId);
  let servicePeriod: string | null = null;
  if (invoice.periodStart && invoice.periodEnd) {
    const fmtOpt: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };
    const s = new Date(invoice.periodStart).toLocaleDateString("en-US", fmtOpt);
    const e = new Date(invoice.periodEnd).toLocaleDateString("en-US", fmtOpt);
    servicePeriod = `${s} – ${e}`;
  }
  const tpl = invoiceSentEmail({
    invoiceNumber: invoice.invoiceNumber,
    totalCents: invoice.totalCents,
    dueDate: invoice.dueDate,
    portalInvoiceUrl: payUrl,
    billingInvoiceId: invoice.id,
    balanceDueCents: invoice.balanceDueCents ?? invoice.totalCents,
    servicePeriod,
    brand,
  });
  await (db as any).emailJob.create({
    data: buildBillingEmailJobCreateData({
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      to,
      type: "BILLING_INVOICE_SENT",
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    }),
  });
  await (db as any).billingInvoice.update({
    where: { id: invoice.id },
    data: { lastEmailStatus: "QUEUED", lastEmailedAt: new Date() },
  });
  await logLifecycle("invoice_emailed", invoice.tenantId, invoice.id, null, { emailType: "BILLING_INVOICE_SENT", to, recipientSource: recipient.source });
  return { queued: true };
}

/** Payment-link-only email (traceable tenantId + invoiceId). */
export async function queuePaymentLinkEmail(params: {
  tenantId: string;
  invoiceId: string;
  invoiceNumber: string;
  totalCents: number;
  dueDate: Date;
  to: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const to = String(params.to || "").trim();
  if (!to) return { ok: false, error: "recipient_required" };
  const tenant = await (db as any).tenant.findUnique({
    where: { id: params.tenantId },
    select: { name: true, billingSettings: true },
  });
  const brand = resolveInvoiceEmailBranding(tenant?.billingSettings || {}, tenant?.name);
  const payUrl = billingInvoicePublicPayUrl(params.invoiceId, params.tenantId);
  const tpl = paymentLinkEmail({
    invoiceNumber: params.invoiceNumber,
    totalCents: params.totalCents,
    dueDate: params.dueDate,
    payUrl,
    brand,
  });
  await (db as any).emailJob.create({
    data: buildBillingEmailJobCreateData({
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      to,
      type: "BILLING_PAYMENT_LINK",
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    }),
  });
  await logLifecycle("payment_link_emailed", params.tenantId, params.invoiceId, null, { emailType: "BILLING_PAYMENT_LINK", to });
  return { ok: true };
}

export async function queueReceiptEmailOnce(params: {
  tenantId: string;
  invoiceId: string;
  invoiceNumber: string;
  totalCents: number;
  transactionId: string;
  cardLabel?: string | null;
  paidViaAutopay?: boolean;
}): Promise<boolean> {
  if (await hasReceiptEmailForTransaction(params.transactionId)) return false;
  const recipient = await resolveBillingEmailRecipient({ tenantId: params.tenantId, invoiceId: params.invoiceId });
  const to = recipient.to;
  if (!to) {
    await logLifecycle("receipt_email_skipped", params.tenantId, params.invoiceId, "No billingEmail", { transactionId: params.transactionId });
    return false;
  }
  const brand = resolveInvoiceEmailBranding(recipient.settings || {}, recipient.tenantName);
  const portalInvoiceUrl = billingInvoicePortalUrl(params.invoiceId);
  const tpl = paymentReceiptEmail({
    invoiceNumber: params.invoiceNumber,
    totalCents: params.totalCents,
    paidAt: new Date(),
    billingInvoiceId: params.invoiceId,
    cardLabel: params.cardLabel ?? null,
    portalInvoiceUrl,
    paidViaAutopay: params.paidViaAutopay,
    brand,
  });
  await (db as any).emailJob.create({
    data: buildBillingEmailJobCreateData({
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      to,
      type: "BILLING_RECEIPT",
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    }),
  });
  await (db as any).billingEventLog.create({
    data: {
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      type: "receipt_emailed",
      message: params.transactionId,
      metadata: { emailType: "BILLING_RECEIPT", to, recipientSource: recipient.source },
    },
  });
  return true;
}

export async function queuePaymentFailedEmailOnce(params: {
  tenantId: string;
  invoiceId: string;
  invoiceNumber: string;
  totalCents: number;
  transactionId: string;
  reason?: string | null;
}): Promise<boolean> {
  if (await hasFailureEmailForTransaction(params.transactionId)) return false;
  const recipient = await resolveBillingEmailRecipient({ tenantId: params.tenantId, invoiceId: params.invoiceId });
  const to = recipient.to;
  if (!to) {
    await logLifecycle("payment_failed_email_skipped", params.tenantId, params.invoiceId, "No billingEmail", { transactionId: params.transactionId });
    return false;
  }
  const brand = resolveInvoiceEmailBranding(recipient.settings || {}, recipient.tenantName);
  const tpl = paymentFailedEmail({
    invoiceNumber: params.invoiceNumber,
    totalCents: params.totalCents,
    reason: params.reason ?? null,
    updateUrl: `${publicPortalBaseUrl()}/billing/payments`,
    payUrl: billingInvoicePortalUrl(params.invoiceId),
    brand,
  });
  await (db as any).emailJob.create({
    data: buildBillingEmailJobCreateData({
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      to,
      type: "BILLING_PAYMENT_FAILED",
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    }),
  });
  await (db as any).billingEventLog.create({
    data: {
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      type: "payment_failed_emailed",
      message: params.transactionId,
      metadata: { emailType: "BILLING_PAYMENT_FAILED", to, recipientSource: recipient.source },
    },
  });
  return true;
}

/** After successful paid invoice, clear dunning metadata slice. */
export async function clearInvoiceDunningMetadata(invoiceId: string): Promise<void> {
  const inv = await (db as any).billingInvoice.findUnique({ where: { id: invoiceId } });
  if (!inv) return;
  const next = clearDunningSlice(inv.metadata);
  await (db as any).billingInvoice.update({ where: { id: invoiceId }, data: { metadata: next } });
}
