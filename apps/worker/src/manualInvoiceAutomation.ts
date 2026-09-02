import type { BillingSchedule } from "./billingSchedule";

/**
 * Manual-pay invoice automation — for tenants that pay their invoices
 * THEMSELVES, with autopay deliberately OFF.
 *
 * Born for Yossis Wood Works (Izzy, 2026-09-02): "Leave auto-pay switched off
 * for them. They usually do it themselves. Just send in the reminder and then
 * the invoice again on the day of payment ... build it to happen every month
 * automatically." The autopay sweep in main.ts filters
 * `autoBillingEnabled: true`, so an autopay-off tenant otherwise gets NO
 * invoice and NO email, ever — August 2026 had to be invoiced by hand.
 *
 * Two phases per tenant, and ⛔ NEVER A CHARGE — this module must not import
 * or call anything that can move money (a source guard in
 * manualInvoiceAutomation.test.ts pins the absence of chargeBillingInvoice):
 *
 *   1. T-3 (upcoming.reminderDue): ensure the upcoming period's invoice
 *      exists. Creating it queues the ordinary invoice email (with the pay
 *      link) via the finalize hook; for an invoice that already exists (e.g.
 *      made by hand) the finalize email is re-attempted — its own dedupe makes
 *      that a no-op when the email already went.
 *   2. Payment day (current.due): re-send the invoice email ONCE if the bill
 *      is still unpaid.
 *
 * ⛔ OPT-IN PER TENANT via TenantBillingSettings.metadata
 * `billingManualInvoiceAutomation: true`. A blanket "every autopay-off tenant"
 * sweep would start emailing monthly invoices to a dozen companies nobody
 * decided to bill this way.
 */
export function manualInvoiceAutomationEnabled(metadata: unknown): boolean {
  const meta = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
  return meta.billingManualInvoiceAutomation === true;
}

type InvoiceEmailShape = {
  id: string;
  tenantId: string;
  invoiceNumber: string;
  totalCents: number;
  balanceDueCents?: number;
  dueDate: Date;
  periodStart?: Date | null;
  periodEnd?: Date | null;
};

export type ManualInvoiceAutomationDeps = {
  db: any;
  now?: Date;
  buildBillingSchedule: (input: { now?: Date; billingDayOfMonth: number; metadata?: unknown }) => BillingSchedule;
  buildUpcomingBillingSchedule: (input: { now?: Date; billingDayOfMonth: number; metadata?: unknown }) => BillingSchedule;
  findPaidBillingPeriodCoverage: (input: { tenantId: string; periodStart: Date; periodEnd: Date }) => Promise<any | null>;
  checkActiveSolaScheduleBlock: (tenantId: string) => Promise<any | null>;
  findPeriodInvoice: (tenantId: string, schedule: BillingSchedule) => Promise<any | null>;
  createInvoice: (setting: any, schedule: BillingSchedule) => Promise<any>;
  queueInvoiceSentOnFinalize: (invoice: InvoiceEmailShape) => Promise<{ queued: boolean; reason?: string }>;
  queueInvoicePaymentDayResendOnce: (invoice: InvoiceEmailShape, scheduledChargeAt: Date) => Promise<{ queued: boolean; reason?: string }>;
};

function toEmailShape(invoice: any): InvoiceEmailShape {
  return {
    id: invoice.id,
    tenantId: invoice.tenantId,
    invoiceNumber: invoice.invoiceNumber,
    totalCents: invoice.totalCents,
    balanceDueCents: invoice.balanceDueCents ?? invoice.totalCents,
    dueDate: invoice.dueDate,
    periodStart: invoice.periodStart ?? null,
    periodEnd: invoice.periodEnd ?? null,
  };
}

export async function runManualInvoiceAutomationCore(deps: ManualInvoiceAutomationDeps): Promise<any[]> {
  const { db } = deps;
  const now = deps.now ?? new Date();
  const results: any[] = [];

  const settings = await db.tenantBillingSettings.findMany({
    where: { autoBillingEnabled: false },
    include: { tenant: true },
  });
  const enabled = (settings || []).filter(
    (s: any) => manualInvoiceAutomationEnabled(s.metadata) && s.tenant && !s.tenant.pbxRemovedAt,
  );

  for (const setting of enabled) {
    try {
      const upcoming = deps.buildUpcomingBillingSchedule({
        now,
        billingDayOfMonth: setting.billingDayOfMonth,
        metadata: setting.metadata,
      });
      const current = deps.buildBillingSchedule({
        now,
        billingDayOfMonth: setting.billingDayOfMonth,
        metadata: setting.metadata,
      });

      // ── Phase 1 — T-3: the upcoming period's invoice must exist. ──────────
      if (upcoming.reminderDue) {
        const activeSolaBlock = await deps.checkActiveSolaScheduleBlock(setting.tenantId);
        if (activeSolaBlock) {
          results.push({ tenantId: setting.tenantId, phase: "manual_t3", skipped: "active_sola_schedule" });
        } else {
          const paidCoverage = await deps.findPaidBillingPeriodCoverage({
            tenantId: setting.tenantId,
            periodStart: upcoming.periodStart,
            periodEnd: upcoming.periodEnd,
          });
          if (paidCoverage) {
            results.push({ tenantId: setting.tenantId, phase: "manual_t3", skipped: "period_already_paid", invoiceId: paidCoverage.invoiceId });
          } else {
            let invoice = await deps.findPeriodInvoice(setting.tenantId, upcoming);
            if (!invoice) {
              invoice = await deps.createInvoice(setting, upcoming);
              await db.billingEventLog.create({
                data: {
                  tenantId: setting.tenantId,
                  invoiceId: invoice.id,
                  type: "manual_invoice_created",
                  message: "Manual-pay T-3 — invoice created and emailed ahead of the payment date (no autopay charge).",
                  metadata: { invoiceNumber: invoice.invoiceNumber, paymentDate: upcoming.paymentDate, source: "worker_manual_t3" },
                },
              }).catch(() => null);
              results.push({ tenantId: setting.tenantId, phase: "manual_t3", invoiceId: invoice.id, created: true });
            } else if (invoice.status !== "PAID" && invoice.status !== "VOID") {
              // Exists (e.g. created by hand) — make sure its email went out.
              // queueInvoiceSentOnFinalize dedupes itself, so this is a no-op
              // when the email already landed.
              const sent = await deps.queueInvoiceSentOnFinalize(toEmailShape(invoice)).catch(() => ({ queued: false, reason: "email_failed" }));
              results.push({ tenantId: setting.tenantId, phase: "manual_t3", invoiceId: invoice.id, created: false, emailQueued: sent.queued, emailReason: sent.reason ?? null });
            } else {
              results.push({ tenantId: setting.tenantId, phase: "manual_t3", invoiceId: invoice.id, skipped: "already_settled" });
            }
          }
        }
      }

      // ── Phase 2 — payment day: re-send the open bill once. ────────────────
      // ⛔ The lookup is "newest OPEN/OVERDUE auto invoice whose periodEnd is
      // at/after today's payment instant", NOT autopayPeriodInvoiceWhere —
      // a transition month after a billing-day move (Yossis Sep 2026: period
      // Sep 5 → Oct 4, payment day the 4th) STARTS after the payment instant,
      // so the containment lookup finds the previous month's PAID invoice
      // instead of the bill actually being paid today.
      if (current.due) {
        const openBill = await db.billingInvoice.findFirst({
          where: {
            tenantId: setting.tenantId,
            billingProfileId: null,
            status: { in: ["OPEN", "OVERDUE"] },
            AND: [
              // NULL-safe "not an operator-created invoice" (the Prisma `not`
              // NULL trap — see autopayCycle.ts).
              { OR: [{ source: null }, { source: { not: "MANUAL" } }] },
              { periodEnd: { gte: current.scheduledChargeAt } },
            ],
          },
          orderBy: { createdAt: "desc" },
        });
        const balanceDue = Math.max(0, openBill?.balanceDueCents ?? openBill?.totalCents ?? 0);
        if (openBill && balanceDue > 0) {
          const resend = await deps.queueInvoicePaymentDayResendOnce(toEmailShape(openBill), current.scheduledChargeAt);
          if (resend.queued) {
            await db.billingEventLog.create({
              data: {
                tenantId: setting.tenantId,
                invoiceId: openBill.id,
                type: "manual_invoice_payment_day_resent",
                message: `Manual-pay payment day (${current.paymentDate}) — invoice email re-sent; still unpaid, no charge attempted.`,
                metadata: { invoiceNumber: openBill.invoiceNumber, paymentDate: current.paymentDate },
              },
            }).catch(() => null);
          }
          results.push({ tenantId: setting.tenantId, phase: "manual_payment_day", invoiceId: openBill.id, resendQueued: resend.queued, resendReason: resend.reason ?? null });
        } else {
          results.push({ tenantId: setting.tenantId, phase: "manual_payment_day", skipped: openBill ? "zero_balance" : "no_open_bill" });
        }
      }
    } catch (err: any) {
      results.push({ tenantId: setting.tenantId, error: err?.message || "manual_invoice_automation_failed" });
      await db.billingEventLog.create({
        data: {
          tenantId: setting.tenantId,
          type: "manual_invoice_automation_failed",
          message: err?.message ? String(err.message) : "manual_invoice_automation_failed",
        },
      }).catch(() => null);
    }
  }

  return results;
}
