// Payment transaction alerts — Izzy is emailed on EVERY settled transaction.
//
// Izzy, 2026-08-23: "Every time there is a successful transaction, I should get
// an email to Izzy@loopcom.net, same every time there is a declined
// transaction."
//
// ⛔⛔ THIS IS A SWEEP, NOT A HOOK IN THE CHARGE PATH, AND THAT IS THE WHOLE
// DESIGN. Two reasons, both load-bearing:
//
//   1. SAFETY. Nothing here runs inside a charge, so a fault in this file can
//      never fail, delay or double a customer's payment. The worst case is a
//      late alert email.
//   2. COVERAGE. A payment settles from FIVE places today — chargeBillingInvoice
//      (autopay + admin retry), chargeBillingInvoiceWithSut (public pay page),
//      the combined pay-link route, the Sola webhook reconciler, and
//      externalPayment (an operator posting a check/Zelle/cash). Hooking each is
//      exactly how the two IVR publish paths and the two invite paths shipped
//      half-broken. Every one of them ends at a PaymentTransaction row reaching
//      a settled status, so watching THAT covers all five — and every path
//      added later, for free.
//
// ⛔ PAY-LINK ALLOCATION ROWS ARE SKIPPED. A combined pay link is ONE card
// charge that then writes a child PaymentTransaction per invoice it covered
// (rawResponseSafeJson.allocation === true). Alerting on those would report one
// $300 charge as four separate payments and quadruple the day's total.
//
// ⛔ Type is PAYMENT_TRANSACTION_ALERT, NEVER "ADMIN_ALERT" — that category is
// muted at the send door (server.ts) and would build clean, log clean and reach
// nobody.

import { db } from "@connect/db";
import { emailShell } from "./emailTemplates";
import { resolveInvoiceEmailBranding } from "./invoiceBranding";
import { canonicalPortalOrigin } from "../publicOrigins";

type Log =
  | { info?: (o: any, m?: string) => void; warn?: (o: any, m?: string) => void; error?: (o: any, m?: string) => void }
  | undefined;

export const PAYMENT_ALERT_EMAIL_TYPE = "PAYMENT_TRANSACTION_ALERT";

/**
 * Nothing that settled before this instant is ever emailed. Without it the first
 * sweep after deploy would mail the entire back catalogue (77 rows on
 * 2026-08-23) in one burst. Set to the moment this shipped; override with
 * PAYMENT_ALERT_CUTOVER_AT only to deliberately replay a window.
 */
export const DEFAULT_PAYMENT_ALERT_CUTOVER_AT = new Date("2026-08-23T21:00:00Z");

/** How far back a sweep will look. Bounds the query and any catch-up burst. */
export const DEFAULT_PAYMENT_ALERT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The one status that is NOT alerted: the charge has not settled yet, so there
 * is nothing true to say about it. Every other status — present or future — is
 * alerted, so a new enum value can never silently vanish from the stream.
 * paymentTransactionAlerts.test.ts reads the enum out of schema.prisma and
 * fails if a member is added that this file would drop.
 */
export const UNSETTLED_TRANSACTION_STATUS = "PENDING";

export function paymentAlertEmailTo(): string {
  return (process.env.PAYMENT_ALERT_EMAIL || "izzy@loopcom.net").trim();
}

/** EmailJob.tenantId is required; platform mail rides the admin tenant, as the compliance reminders do. */
export function paymentAlertTenantId(): string {
  return (process.env.PAYMENT_ALERT_TENANT_ID || "connect-admin-tenant-v1").trim();
}

export function paymentAlertCutoverAt(): Date {
  const raw = (process.env.PAYMENT_ALERT_CUTOVER_AT || "").trim();
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return DEFAULT_PAYMENT_ALERT_CUTOVER_AT;
}

export function paymentAlertLookbackMs(): number {
  const raw = Number(process.env.PAYMENT_ALERT_LOOKBACK_MS || 0);
  if (Number.isFinite(raw) && raw >= 60_000) return raw;
  return DEFAULT_PAYMENT_ALERT_LOOKBACK_MS;
}

// ── The decision ─────────────────────────────────────────────────────────────

export type PaymentAlertCandidate = {
  id: string;
  status?: string | null;
  createdAt: Date;
  alertEmailedStatus?: string | null;
  rawResponseSafeJson?: unknown;
};

export type PaymentAlertSkipReason =
  | "send"
  | "not_settled"
  | "before_cutover"
  | "too_old"
  | "already_emailed"
  | "allocation_split"
  | "no_status";

export type PaymentAlertDecision = { send: boolean; reason: PaymentAlertSkipReason };

/** True for the per-invoice child rows a combined pay link writes under one real charge. */
export function isPayLinkAllocationRow(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  return (raw as Record<string, unknown>).allocation === true;
}

/**
 * Pure. The ONLY place the rule lives — the sweep queries a coarse window and
 * asks this about every row, so the query and the rule can never drift apart.
 */
export function decidePaymentAlert(
  tx: PaymentAlertCandidate,
  opts: { now: Date; cutoverAt: Date; lookbackMs: number },
): PaymentAlertDecision {
  const status = String(tx.status ?? "").trim();
  if (!status) return { send: false, reason: "no_status" };
  if (status === UNSETTLED_TRANSACTION_STATUS) return { send: false, reason: "not_settled" };
  if (isPayLinkAllocationRow(tx.rawResponseSafeJson)) return { send: false, reason: "allocation_split" };
  const created = tx.createdAt instanceof Date ? tx.createdAt.getTime() : new Date(tx.createdAt as any).getTime();
  if (!Number.isFinite(created)) return { send: false, reason: "no_status" };
  if (created < opts.cutoverAt.getTime()) return { send: false, reason: "before_cutover" };
  if (created < opts.now.getTime() - opts.lookbackMs) return { send: false, reason: "too_old" };
  // Keyed on the status too, so an approved payment that is later refunded
  // produces a second, correct alert rather than being swallowed as a duplicate.
  if ((tx.alertEmailedStatus ?? null) === status) return { send: false, reason: "already_emailed" };
  return { send: true, reason: "send" };
}

// ── Wording ──────────────────────────────────────────────────────────────────

export function paymentAlertHeadline(status: string): string {
  switch (status) {
    case "APPROVED":
      return "Payment approved";
    case "DECLINED":
      return "Payment DECLINED";
    case "ERROR":
      return "Payment error";
    case "REFUNDED":
      return "Payment refunded";
    case "VOIDED":
      return "Payment voided";
    default:
      return `Payment ${status.toLowerCase()}`;
  }
}

const EXTERNAL_METHOD_LABELS: Record<string, string> = {
  QUICKPAY: "QuickPay",
  ZELLE: "Zelle",
  CHECK: "Check",
  CASH: "Cash",
  CARD_EXTERNAL: "Card (outside Connect)",
  ACH_EXTERNAL: "Bank transfer (outside Connect)",
  OTHER: "Other",
};

/**
 * How the money moved, in words, and never claiming more than the row proves.
 * A saved-card charge is autopay OR an admin pressing charge — the row does not
 * distinguish them, so neither does this.
 */
export function paymentAlertMethodLine(tx: {
  source?: string | null;
  processor?: string | null;
  externalMethod?: string | null;
  externalReference?: string | null;
  payerName?: string | null;
  paymentMethodId?: string | null;
  paymentMethod?: { brand?: string | null; last4?: string | null } | null;
  billingChargeOperation?: { chargeType?: string | null } | null;
  rawResponseSafeJson?: unknown;
}): string {
  const isExternal = tx.source === "MANUAL" || tx.processor === "MANUAL";
  if (isExternal) {
    const label = EXTERNAL_METHOD_LABELS[String(tx.externalMethod || "")] || "External payment";
    const bits = [`${label} — posted by an operator`];
    if (tx.externalReference) bits.push(`ref ${tx.externalReference}`);
    if (tx.payerName) bits.push(`from ${tx.payerName}`);
    return bits.join(" · ");
  }
  const raw = (tx.rawResponseSafeJson || {}) as Record<string, any>;
  const payLinkCode = raw?.payLink?.code ? String(raw.payLink.code) : "";
  const brand = tx.paymentMethod?.brand || (raw.cardBrand ? String(raw.cardBrand) : "");
  const last4 = tx.paymentMethod?.last4 || (raw.cardLast4 ? String(raw.cardLast4) : "");
  const card = last4 ? `${brand || "Card"} ending ${last4}` : brand || "Card";
  if (payLinkCode) return `${card} — combined pay link ${payLinkCode}`;
  const chargeType = tx.billingChargeOperation?.chargeType || "";
  if (chargeType === "new_card" || (!tx.paymentMethodId && chargeType !== "saved_card")) {
    return `${card} — entered at checkout (one-time)`;
  }
  return `${card} — saved card on file`;
}

export function formatUsd(amountCents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(
      (Number(amountCents) || 0) / 100,
    );
  } catch {
    return `$${((Number(amountCents) || 0) / 100).toFixed(2)}`;
  }
}

/**
 * ⛔ Always New York time with the zone named. The server runs in France, so a
 * bare timestamp is six hours wrong to the only person reading this.
 */
export function formatEastern(when: Date): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(when);
  } catch {
    return when.toISOString();
  }
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type PaymentAlertEmailInput = {
  status: string;
  amountCents: number;
  currency?: string | null;
  tenantName?: string | null;
  tenantId: string;
  invoiceNumber?: string | null;
  invoiceCount?: number;
  methodLine: string;
  reason?: string | null;
  processorRef?: string | null;
  transactionId: string;
  occurredAt: Date;
  customerBillingUrl?: string | null;
};

function row(label: string, value: string): string {
  return `
        <tr>
          <td class="summary-label" style="padding:7px 12px 7px 0;font-size:13px;line-height:19px;color:#6b7280;white-space:nowrap;vertical-align:top;">${esc(label)}</td>
          <td class="summary-value" style="padding:7px 0;font-size:14px;line-height:20px;color:#111827;font-weight:600;">${value}</td>
        </tr>`;
}

export function buildPaymentAlertEmail(input: PaymentAlertEmailInput): { subject: string; html: string; text: string } {
  const headline = paymentAlertHeadline(input.status);
  const amount = formatUsd(input.amountCents, input.currency || "USD");
  const company = (input.tenantName || "").trim() || "Unknown company";
  const subject = `${headline} — ${amount} — ${company}`;
  const when = formatEastern(input.occurredAt);

  const invoiceText =
    input.invoiceCount && input.invoiceCount > 1
      ? `${input.invoiceCount} invoices (combined payment)`
      : input.invoiceNumber || "No invoice on this transaction";

  const rows = [
    row("Company", esc(company)),
    row("Amount", esc(amount)),
    row("Result", esc(headline)),
    ...(input.reason ? [row(input.status === "APPROVED" ? "Processor" : "Reason", esc(input.reason))] : []),
    row("Paid with", esc(input.methodLine)),
    row("Invoice", esc(invoiceText)),
    row("When", esc(when)),
    ...(input.processorRef ? [row("Processor ref", esc(input.processorRef))] : []),
    row("Transaction", esc(input.transactionId)),
  ].join("");

  const cta = input.customerBillingUrl
    ? `<p style="margin:18px 0 0;font-size:14px;line-height:20px;"><a href="${esc(
        input.customerBillingUrl,
      )}" style="color:#22a8ff;font-weight:700;text-decoration:none;">Open this customer's billing &rarr;</a></p>`
    : "";

  const lead =
    input.status === "APPROVED"
      ? `<strong>${esc(amount)}</strong> was collected from <strong>${esc(company)}</strong>.`
      : input.status === "DECLINED"
        ? `A <strong>${esc(amount)}</strong> payment from <strong>${esc(company)}</strong> was declined.`
        : input.status === "REFUNDED"
          ? `<strong>${esc(amount)}</strong> was refunded to <strong>${esc(company)}</strong>.`
          : `A <strong>${esc(amount)}</strong> payment from <strong>${esc(company)}</strong> ended as ${esc(
              headline.toLowerCase(),
            )}.`;

  const body = `
    <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#111827;">${lead}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border-top:1px solid #e5e7eb;">${rows}
    </table>
    ${cta}
  `;

  const html = emailShell(headline, body, resolveInvoiceEmailBranding({}, null), {
    eyebrow: "Payments",
    footerNote: "Sent by Loopcom payment monitoring.",
    includeSupportBlock: false,
  });

  const text = [
    `${headline}: ${amount} — ${company}`,
    "",
    `Result: ${headline}`,
    ...(input.reason ? [`${input.status === "APPROVED" ? "Processor" : "Reason"}: ${input.reason}`] : []),
    `Paid with: ${input.methodLine}`,
    `Invoice: ${invoiceText}`,
    `When: ${when}`,
    ...(input.processorRef ? [`Processor ref: ${input.processorRef}`] : []),
    `Transaction: ${input.transactionId}`,
    ...(input.customerBillingUrl ? ["", `Customer billing: ${input.customerBillingUrl}`] : []),
  ].join("\n");

  return { subject, html, text };
}

// ── The sweep ────────────────────────────────────────────────────────────────

export type PaymentAlertSweepResult = {
  considered: number;
  emailed: number;
  skipped: Record<string, number>;
  errors: string[];
};

export async function runPaymentTransactionAlertSweep(
  dbc: any = db,
  log?: Log,
  now = new Date(),
): Promise<PaymentAlertSweepResult> {
  const cutoverAt = paymentAlertCutoverAt();
  const lookbackMs = paymentAlertLookbackMs();
  const windowStart = new Date(Math.max(cutoverAt.getTime(), now.getTime() - lookbackMs));
  const skipped: Record<string, number> = {};
  const errors: string[] = [];
  let emailed = 0;

  let rows: any[] = [];
  try {
    rows = await dbc.paymentTransaction.findMany({
      where: { createdAt: { gte: windowStart } },
      orderBy: { createdAt: "asc" },
      take: 200,
      include: {
        tenant: { select: { id: true, name: true } },
        invoice: { select: { invoiceNumber: true } },
        paymentMethod: { select: { brand: true, last4: true } },
        billingChargeOperation: { select: { chargeType: true } },
      },
    });
  } catch (err: any) {
    errors.push(`query: ${String(err?.message || err).slice(0, 200)}`);
    log?.warn?.({ errors }, "[PAYMENT_ALERT] sweep could not read transactions");
    return { considered: 0, emailed: 0, skipped, errors };
  }

  for (const tx of rows) {
    const decision = decidePaymentAlert(tx, { now, cutoverAt, lookbackMs });
    if (!decision.send) {
      skipped[decision.reason] = (skipped[decision.reason] || 0) + 1;
      continue;
    }
    const previous = tx.alertEmailedStatus ?? null;

    // Claim the slot FIRST, conditioned on the value we read, so the second api
    // process during a blue/green rollout cannot send the same alert twice.
    try {
      const claim = await dbc.paymentTransaction.updateMany({
        where: { id: tx.id, alertEmailedStatus: previous },
        data: { alertEmailedStatus: tx.status, alertEmailedAt: now },
      });
      if (!claim?.count) {
        skipped.already_emailed = (skipped.already_emailed || 0) + 1;
        continue;
      }
    } catch (err: any) {
      errors.push(`claim ${tx.id}: ${String(err?.message || err).slice(0, 160)}`);
      continue;
    }

    try {
      const raw = (tx.rawResponseSafeJson || {}) as Record<string, any>;
      const allocations = Array.isArray(raw?.payLink?.allocations) ? raw.payLink.allocations : null;
      const mail = buildPaymentAlertEmail({
        status: String(tx.status),
        amountCents: tx.amountCents,
        currency: tx.currency,
        tenantName: tx.tenant?.name ?? null,
        tenantId: tx.tenantId,
        invoiceNumber: tx.invoice?.invoiceNumber ?? null,
        invoiceCount: allocations ? allocations.length : undefined,
        methodLine: paymentAlertMethodLine(tx),
        reason: tx.responseMessage ?? null,
        processorRef: tx.processorTransactionId ?? null,
        transactionId: tx.id,
        occurredAt: tx.paymentDate instanceof Date ? tx.paymentDate : tx.createdAt,
        customerBillingUrl: `${canonicalPortalOrigin()}/admin/billing/customer/${encodeURIComponent(tx.tenantId)}`,
      });
      await dbc.emailJob.create({
        data: {
          tenantId: paymentAlertTenantId(),
          // ⛔ EmailJob.invoiceId is the FK to the LEGACY Invoice table, never a
          // BillingInvoice id. Always null here.
          invoiceId: null,
          type: PAYMENT_ALERT_EMAIL_TYPE,
          toEmail: paymentAlertEmailTo(),
          subject: mail.subject,
          htmlBody: mail.html,
          textBody: mail.text,
        },
        select: { id: true },
      });
      emailed++;
      log?.info?.({ transactionId: tx.id, status: tx.status, amountCents: tx.amountCents }, "[PAYMENT_ALERT] queued");
    } catch (err: any) {
      // ⛔ RELEASE THE CLAIM. This is the opposite of a money operation, where a
      // spent claim must stay spent: re-sending an alert is harmless, never
      // sending one is the failure this whole file exists to prevent.
      await dbc.paymentTransaction
        .updateMany({
          where: { id: tx.id, alertEmailedStatus: tx.status },
          data: { alertEmailedStatus: previous, alertEmailedAt: null },
        })
        .catch(() => null);
      errors.push(`email ${tx.id}: ${String(err?.message || err).slice(0, 160)}`);
    }
  }

  if (errors.length) log?.warn?.({ errors, emailed }, "[PAYMENT_ALERT] sweep finished with errors");
  return { considered: rows.length, emailed, skipped, errors };
}

// ── Boot wiring ──────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = Math.max(15_000, Number(process.env.PAYMENT_ALERT_SWEEP_INTERVAL_MS || 60_000));
/**
 * ⛔ The boot kick is mandatory, not a nicety. A bare setInterval is starved to
 * nothing on a busy deploy day — every api rollout restarts the process and puts
 * the clock back to zero, which is exactly how the voicemail watchdog went 67
 * minutes without a single run while looking perfectly armed.
 */
const BOOT_DELAY_MS = Math.max(5_000, Number(process.env.PAYMENT_ALERT_BOOT_DELAY_MS || 45_000));
const DISABLED = () => process.env.PAYMENT_TRANSACTION_ALERTS_DISABLED === "1";

export function startPaymentTransactionAlerts(log?: Log): NodeJS.Timeout | null {
  if (DISABLED()) return null;
  log?.info?.(
    {
      intervalMs: SWEEP_INTERVAL_MS,
      bootDelayMs: BOOT_DELAY_MS,
      emailTo: paymentAlertEmailTo(),
      cutoverAt: paymentAlertCutoverAt().toISOString(),
    },
    "PAYMENT_TRANSACTION_ALERTS_ARMED",
  );

  const first = setTimeout(() => {
    void runPaymentTransactionAlertSweep(db, log).catch(() => {});
  }, BOOT_DELAY_MS) as unknown as NodeJS.Timeout;
  (first as any).unref?.();

  const timer = setInterval(() => {
    void runPaymentTransactionAlertSweep(db, log).catch(() => {});
  }, SWEEP_INTERVAL_MS) as unknown as NodeJS.Timeout;
  (timer as any).unref?.();
  return timer;
}
