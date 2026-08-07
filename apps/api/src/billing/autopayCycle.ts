import type { BillingSchedule } from "./billingSchedule";

/**
 * Find the non-VOID tenant invoice for the current autopay billing period.
 *
 * ⛔ Operator-created invoices (`source: "MANUAL"`) are excluded on purpose.
 * Autopay picks the most recently created invoice overlapping the period, so a
 * custom invoice — even a one-day one for a handset — used to be able to
 * (a) be auto-charged in place of the monthly bill, and (b) suppress creation of
 * the monthly invoice entirely, because the lookup found it and concluded the
 * period was already invoiced. A custom invoice must be purely additive: you
 * collect it yourself with a payment link or "Charge now".
 *
 * This cannot double-charge: a PAID manual invoice covering the period still
 * stops the autopay charge via findPaidBillingPeriodCoverage.
 */
export function autopayPeriodInvoiceWhere(tenantId: string, schedule: BillingSchedule) {
  return {
    tenantId,
    billingProfileId: null,
    status: { not: "VOID" as const },
    source: { not: "MANUAL" as const },
    OR: [
      { periodStart: schedule.periodStart, periodEnd: schedule.periodEnd },
      {
        periodStart: { lte: schedule.scheduledChargeAt },
        periodEnd: { gte: schedule.scheduledChargeAt },
      },
    ],
  };
}

export type AutopayCycleEventType =
  | "autopay_invoice_generation_started"
  | "autopay_invoice_created"
  | "autopay_invoice_skipped_existing"
  | "autopay_invoice_generation_failed"
  | "autopay_reminder_email_sent"
  | "autopay_reminder_email_skipped_existing"
  | "autopay_charge_started"
  | "autopay_charge_succeeded"
  | "autopay_charge_failed"
  | "autopay_missing_invoice_on_due_date";
