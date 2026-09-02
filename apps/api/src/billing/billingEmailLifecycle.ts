import { db } from "@connect/db";
import { buildBillingEmailJobCreateData } from "./billingAuth";
import { billingApologyEmail, autopayReminderEmail, invoiceSentEmail, paymentFailedEmail, paymentLinkEmail, paymentReceiptEmail, paymentRefundedEmail } from "./emailTemplates";
import { clearDunningSlice } from "./billingDunning";
import { resolveInvoiceEmailBranding } from "./invoiceBranding";
import { createBillingInvoicePayToken } from "./billingPayToken";
import { canonicalPortalOrigin } from "../publicOrigins";

export function publicPortalBaseUrl(): string {
  return canonicalPortalOrigin();
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

/** Roles whose users may receive billing email as a last-resort fallback recipient. */
const BILLING_FALLBACK_USER_ROLES = ["BILLING_ADMIN", "BILLING", "TENANT_ADMIN", "ADMIN"] as const;

/**
 * Last-resort recipient: active tenant users with a billing-capable role.
 * Returns up to 3 distinct emails (comma-joined), preferring billing roles.
 */
async function resolveTenantBillingUserFallbackEmail(tenantId: string): Promise<string> {
  const users: Array<{ email?: string | null; role?: string | null }> = await (db as any).user
    .findMany({
      where: { tenantId, status: "ACTIVE", role: { in: [...BILLING_FALLBACK_USER_ROLES] } },
      select: { email: true, role: true },
    })
    .catch(() => []);
  if (!Array.isArray(users) || users.length === 0) return "";
  const rolePriority = new Map<string, number>(BILLING_FALLBACK_USER_ROLES.map((r, i) => [r, i]));
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const u of [...users].sort((a, b) => (rolePriority.get(String(a.role)) ?? 99) - (rolePriority.get(String(b.role)) ?? 99))) {
    const email = String(u.email || "").trim();
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    emails.push(email);
    if (emails.length >= 3) break;
  }
  return emails.join(", ");
}

async function resolveBillingEmailRecipient(params: {
  tenantId: string;
  invoiceId?: string | null;
  /** Fall back to active tenant admin/billing users when no billing email is configured (receipts). */
  allowUserFallback?: boolean;
}): Promise<{ to: string; source: string; tenantName?: string | null; settings?: any }> {
  const [tenant, invoice] = await Promise.all([
    (db as any).tenant.findUnique({
      where: { id: params.tenantId },
      select: { name: true, billingSettings: true },
    }),
    params.invoiceId
      ? (db as any).billingInvoice.findUnique({
        where: { id: params.invoiceId },
        select: { metadata: true, billingEmail: true },
      }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const settings = tenant?.billingSettings;
  const tenantEmail = normalizeMultiBillingEmail(settings?.billingEmail);
  if (tenantEmail) return { to: tenantEmail, source: "tenant_billing_email", tenantName: tenant?.name, settings };

  const invoiceColumnEmail = normalizeMultiBillingEmail(invoice?.billingEmail);
  if (invoiceColumnEmail) return { to: invoiceColumnEmail, source: "invoice_billing_email", tenantName: tenant?.name, settings };

  const invoiceEmail = invoiceMetadataEmail(invoice?.metadata);
  if (invoiceEmail) return { to: invoiceEmail, source: "invoice_metadata", tenantName: tenant?.name, settings };

  if (params.allowUserFallback) {
    const userEmail = await resolveTenantBillingUserFallbackEmail(params.tenantId);
    if (userEmail) return { to: userEmail, source: "tenant_billing_user", tenantName: tenant?.name, settings };
  }

  return { to: "", source: "missing", tenantName: tenant?.name, settings };
}

// ─── Billing admin alert (rides the ADMIN_ALERT EmailJob channel) ─────────────

export const BILLING_ADMIN_ALERT_TENANT_ID = "connect-admin-tenant-v1";

function billingAdminAlertRecipient(): string {
  return (process.env.ADMIN_ALERT_EMAIL || "tod10950@gmail.com").trim();
}

function escapeAlertHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Queue an ADMIN_ALERT email about a billing/receipt problem. Never throws. */
export async function queueBillingAdminAlertEmail(subject: string, lines: string[]): Promise<boolean> {
  try {
    const to = billingAdminAlertRecipient();
    if (!to) return false;
    await (db as any).emailJob.create({
      data: {
        tenantId: BILLING_ADMIN_ALERT_TENANT_ID,
        invoiceId: null,
        type: "ADMIN_ALERT",
        toEmail: to,
        subject: `[Connect Alert] ${subject}`,
        htmlBody: `<div style="font-family:monospace;white-space:pre-wrap">${lines.map(escapeAlertHtml).join("<br/>")}</div>`,
        textBody: lines.join("\n"),
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A receipt could not be queued because the tenant has no usable recipient at all.
 * Alert the operator exactly once per transaction (sentinel: receipt_email_escalated).
 */
async function escalateMissingReceiptRecipient(params: {
  tenantId: string;
  invoiceId: string;
  invoiceNumber?: string | null;
  transactionId: string;
  tenantName?: string | null;
}): Promise<boolean> {
  const existing = await (db as any).billingEventLog.findFirst({
    where: { type: "receipt_email_escalated", message: params.transactionId },
  });
  if (existing) return false;
  await (db as any).billingEventLog.create({
    data: {
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      type: "receipt_email_escalated",
      message: params.transactionId,
      metadata: { reason: "no_recipient" },
    },
  });
  await queueBillingAdminAlertEmail(
    `Receipt email NOT sent — no recipient for ${params.tenantName || params.tenantId}`,
    [
      `A payment receipt could not be emailed because no recipient could be resolved.`,
      ``,
      `Tenant:       ${params.tenantName || "?"} (${params.tenantId})`,
      `Invoice:      ${params.invoiceNumber || "?"} (${params.invoiceId})`,
      `Transaction:  ${params.transactionId}`,
      ``,
      `Checked: tenant billing settings email, invoice billing email, invoice metadata,`,
      `and active tenant admin/billing users — all empty.`,
      ``,
      `Fix: set a billing email in the tenant's billing settings, then resend the receipt`,
      `from the admin invoice menu (or wait for the receipt reconciliation sweep to retry).`,
    ],
  );
  return true;
}

/**
 * When a receipt fell back to tenant admin users (no billing email configured),
 * nudge the operator to configure a proper billing email — at most once per
 * tenant per 24h (sentinel: receipt_email_user_fallback_alerted).
 */
async function alertReceiptUserFallbackUsed(params: {
  tenantId: string;
  invoiceId: string;
  tenantName?: string | null;
  to: string;
}): Promise<void> {
  const recent = await (db as any).billingEventLog.findFirst({
    where: {
      tenantId: params.tenantId,
      type: "receipt_email_user_fallback_alerted",
      createdAt: { gte: new Date(Date.now() - 24 * 3600_000) },
    },
  });
  if (recent) return;
  await (db as any).billingEventLog.create({
    data: {
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      type: "receipt_email_user_fallback_alerted",
      message: params.to,
      metadata: { reason: "no_billing_email_configured" },
    },
  });
  await queueBillingAdminAlertEmail(
    `Receipt sent via user fallback — set billing email for ${params.tenantName || params.tenantId}`,
    [
      `A payment receipt was delivered, but only because it fell back to the tenant's`,
      `admin/billing users — this tenant has no billing email configured.`,
      ``,
      `Tenant:     ${params.tenantName || "?"} (${params.tenantId})`,
      `Sent to:    ${params.to}`,
      ``,
      `Fix: set a billing email in the tenant's billing settings so receipts go to the`,
      `right inbox instead of the fallback.`,
    ],
  );
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
  return queueInvoiceSentEmailNow(invoice, null);
}

/**
 * Payment-day re-send of the invoice email for MANUAL-pay tenants (autopay off,
 * they pay the link themselves — Izzy for Yossis, 2026-09-02: "send in the
 * reminder and then the invoice again on the day of payment").
 *
 * ⛔ Deduped ONCE PER PAYMENT DATE against the EmailJob table itself (a
 * BILLING_INVOICE_SENT job for this invoice created at/after the payment day's
 * local midnight), never a best-effort log row — the manual sweep runs hourly,
 * and a dedupe that can silently fail to record would email the customer every
 * hour of their payment day.
 */
export async function queueInvoicePaymentDayResendOnce(
  invoice: {
    id: string;
    tenantId: string;
    invoiceNumber: string;
    totalCents: number;
    balanceDueCents?: number;
    dueDate: Date;
    periodStart?: Date | null;
    periodEnd?: Date | null;
  },
  scheduledChargeAt: Date,
): Promise<{ queued: boolean; reason?: string }> {
  const marker = `connect-billing-invoice:${invoice.id}`;
  const recent = await (db as any).emailJob.findFirst({
    where: {
      tenantId: invoice.tenantId,
      type: "BILLING_INVOICE_SENT",
      status: { in: ["QUEUED", "RUNNING", "SENT"] },
      htmlBody: { contains: marker },
      createdAt: { gte: scheduledChargeAt },
    },
  });
  if (recent) return { queued: false, reason: "already_resent_today" };
  return queueInvoiceSentEmailNow(invoice, "payment_day_resend");
}

async function queueInvoiceSentEmailNow(
  invoice: {
    id: string;
    tenantId: string;
    invoiceNumber: string;
    totalCents: number;
    balanceDueCents?: number;
    dueDate: Date;
    periodStart?: Date | null;
    periodEnd?: Date | null;
  },
  resendReason: string | null,
): Promise<{ queued: boolean; reason?: string }> {
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
  await logLifecycle("invoice_emailed", invoice.tenantId, invoice.id, null, {
    emailType: "BILLING_INVOICE_SENT",
    to,
    recipientSource: recipient.source,
    ...(resendReason ? { resendReason } : {}),
  });
  return { queued: true };
}

/** Autopay T-3 reminder — one email per invoice (idempotent via EmailJob type + marker). */
export async function queueAutopayReminderEmailOnce(params: {
  tenantId: string;
  invoiceId: string;
  invoiceNumber: string;
  totalCents: number;
  balanceDueCents?: number;
  dueDate: Date;
  scheduledChargeAt: Date;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}): Promise<{ queued: boolean; reason?: string }> {
  if (await hasBillingEmailJob({ tenantId: params.tenantId, invoiceId: params.invoiceId, type: "BILLING_AUTOPAY_REMINDER" })) {
    return { queued: false, reason: "already_sent" };
  }
  const recipient = await resolveBillingEmailRecipient({ tenantId: params.tenantId, invoiceId: params.invoiceId });
  const to = recipient.to;
  if (!to) {
    await logLifecycle("autopay_reminder_email_skipped", params.tenantId, params.invoiceId, "No billing email configured");
    return { queued: false, reason: "no_billing_email" };
  }
  const brand = resolveInvoiceEmailBranding(recipient.settings || {}, recipient.tenantName);
  let servicePeriod: string | null = null;
  if (params.periodStart && params.periodEnd) {
    const fmtOpt: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };
    const s = new Date(params.periodStart).toLocaleDateString("en-US", fmtOpt);
    const e = new Date(params.periodEnd).toLocaleDateString("en-US", fmtOpt);
    servicePeriod = `${s} – ${e}`;
  }
  const tpl = autopayReminderEmail({
    invoiceNumber: params.invoiceNumber,
    totalCents: params.totalCents,
    balanceDueCents: params.balanceDueCents ?? params.totalCents,
    dueDate: params.dueDate,
    scheduledChargeAt: params.scheduledChargeAt,
    billingInvoiceId: params.invoiceId,
    servicePeriod,
    brand,
  });
  await (db as any).emailJob.create({
    data: buildBillingEmailJobCreateData({
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      to,
      type: "BILLING_AUTOPAY_REMINDER",
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    }),
  });
  await logLifecycle("autopay_reminder_email_sent", params.tenantId, params.invoiceId, null, {
    emailType: "BILLING_AUTOPAY_REMINDER",
    to,
    recipientSource: recipient.source,
    scheduledChargeAt: params.scheduledChargeAt.toISOString(),
  });
  return { queued: true };
}

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
  /** Skip the once-per-transaction dedupe (admin-triggered resend). */
  force?: boolean;
}): Promise<boolean> {
  if (!params.force && (await hasReceiptEmailForTransaction(params.transactionId))) return false;
  const recipient = await resolveBillingEmailRecipient({ tenantId: params.tenantId, invoiceId: params.invoiceId, allowUserFallback: true });
  const to = recipient.to;
  if (!to) {
    await logLifecycle("receipt_email_skipped", params.tenantId, params.invoiceId, "No billingEmail", { transactionId: params.transactionId });
    // A skipped receipt must never be silent: alert the operator (once per transaction).
    await escalateMissingReceiptRecipient({
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      invoiceNumber: params.invoiceNumber,
      transactionId: params.transactionId,
      tenantName: recipient.tenantName,
    }).catch(() => false);
    return false;
  }
  if (recipient.source === "tenant_billing_user") {
    await alertReceiptUserFallbackUsed({
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      tenantName: recipient.tenantName,
      to,
    }).catch(() => undefined);
  }
  const brand = resolveInvoiceEmailBranding(recipient.settings || {}, recipient.tenantName);
  const portalInvoiceUrl = billingInvoicePortalUrl(params.invoiceId);
  const tpl = paymentReceiptEmail({
    invoiceNumber: params.invoiceNumber,
    totalCents: params.totalCents,
    paidAt: new Date(),
    billingInvoiceId: params.invoiceId,
    transactionId: params.transactionId,
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

// ─── Refund confirmation email ────────────────────────────────────────────────

/** Idempotency guard — did we already send a refund email for this transactionId? */
async function hasRefundEmailForTransaction(transactionId: string): Promise<boolean> {
  const e = await (db as any).billingEventLog.findFirst({
    where: { type: "refund_emailed", message: transactionId },
  });
  return !!e;
}

/**
 * Queue a refund confirmation email exactly once per transactionId.
 * Safe to call multiple times (idempotent via billingEventLog sentinel).
 */
export async function queueRefundEmailOnce(params: {
  tenantId: string;
  invoiceId: string | null;
  invoiceNumber: string;
  refundedAmountCents: number;
  transactionId: string;
  cardLabel?: string | null;
  originalPaymentDate?: Date | null;
  isDuplicateChargeRefund?: boolean;
}): Promise<boolean> {
  if (await hasRefundEmailForTransaction(params.transactionId)) return false;
  const recipient = await resolveBillingEmailRecipient({ tenantId: params.tenantId, invoiceId: params.invoiceId });
  const to = recipient.to;
  if (!to) {
    await logLifecycle("refund_email_skipped", params.tenantId, params.invoiceId ?? null, "No billingEmail", { transactionId: params.transactionId });
    return false;
  }
  const brand = resolveInvoiceEmailBranding(recipient.settings || {}, recipient.tenantName);
  const portalInvoiceUrl = params.invoiceId ? billingInvoicePortalUrl(params.invoiceId) : null;
  const tpl = paymentRefundedEmail({
    customerName: recipient.tenantName ?? null,
    invoiceNumber: params.invoiceNumber,
    refundedAmountCents: params.refundedAmountCents,
    cardLabel: params.cardLabel ?? null,
    originalPaymentDate: params.originalPaymentDate ?? null,
    refundIssuedDate: new Date(),
    portalInvoiceUrl,
    isDuplicateChargeRefund: params.isDuplicateChargeRefund ?? false,
    brand,
  });
  await (db as any).emailJob.create({
    data: buildBillingEmailJobCreateData({
      tenantId: params.tenantId,
      invoiceId: null,
      to,
      type: "BILLING_REFUND",
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    }),
  });
  await (db as any).billingEventLog.create({
    data: {
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      type: "refund_emailed",
      message: params.transactionId,
      metadata: { emailType: "BILLING_REFUND", to, recipientSource: recipient.source },
    },
  });
  return true;
}

// ─── One-time apology email ────────────────────────────────────────────────────

/** Idempotency guard — did we already send an apology email for this tenant? */
async function hasApologyEmailForTenant(tenantId: string): Promise<boolean> {
  const e = await (db as any).billingEventLog.findFirst({
    where: { tenantId, type: "apology_email_sent" },
  });
  return !!e;
}

export type QueueApologyEmailParams = {
  tenantId: string;
  invoiceId: string | null;
  invoiceNumber?: string | null;
  refundedAmountCents?: number | null;
  originalPaymentDate?: Date | null;
  adminUserId: string;
  /** true = preview only; does NOT record apology_email_sent and CAN be resent */
  isPreview?: boolean;
};

/**
 * Queue a one-time duplicate-charge apology email.
 * Idempotent: re-runs return false if already sent (unless isPreview=true).
 * Hard rule: only SUPER_ADMIN callers may invoke this; enforce at route layer.
 */
export async function queueApologyEmailOnce(params: QueueApologyEmailParams): Promise<{ queued: boolean; reason?: string }> {
  if (!params.isPreview && await hasApologyEmailForTenant(params.tenantId)) {
    return { queued: false, reason: "already_sent" };
  }
  const recipient = await resolveBillingEmailRecipient({ tenantId: params.tenantId, invoiceId: params.invoiceId });
  const to = recipient.to;
  if (!to) {
    return { queued: false, reason: "no_billing_email" };
  }
  const brand = resolveInvoiceEmailBranding(recipient.settings || {}, recipient.tenantName);
  const portalInvoiceUrl = params.invoiceId ? billingInvoicePortalUrl(params.invoiceId) : null;
  const tpl = billingApologyEmail({
    customerName: recipient.tenantName ?? null,
    refundedAmountCents: params.refundedAmountCents ?? null,
    invoiceNumber: params.invoiceNumber ?? null,
    portalInvoiceUrl,
    brand,
  });
  await (db as any).emailJob.create({
    data: buildBillingEmailJobCreateData({
      tenantId: params.tenantId,
      invoiceId: null,
      to,
      type: "BILLING_APOLOGY",
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    }),
  });
  if (!params.isPreview) {
    await (db as any).billingEventLog.create({
      data: {
        tenantId: params.tenantId,
        invoiceId: params.invoiceId,
        type: "apology_email_sent",
        message: `Apology email sent by admin ${params.adminUserId}`,
        metadata: { adminUserId: params.adminUserId, emailType: "BILLING_APOLOGY", to },
      },
    });
  }
  return { queued: true };
}
