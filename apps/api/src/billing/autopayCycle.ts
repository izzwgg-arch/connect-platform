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
 *
 * ⛔ The exclusion MUST be written as `OR [source IS NULL, source <> 'MANUAL']`.
 * `source: { not: "MANUAL" }` alone is a NULL trap: in SQL `NULL <> 'MANUAL'` is
 * NULL, not true, so every auto-created invoice would be filtered out — and the
 * auto path never sets the column, so `source` is NULL on all of them. Written
 * the wrong way this matches ZERO invoices and blocks every autopay charge.
 * Verified against live data: Gesheft has 5 invoices, 4 with source NULL.
 */
export function autopayPeriodInvoiceWhere(tenantId: string, schedule: BillingSchedule) {
  return {
    tenantId,
    billingProfileId: null,
    status: { not: "VOID" as const },
    AND: [
      // NULL-safe "not an operator-created invoice"
      { OR: [{ source: null }, { source: { not: "MANUAL" as const } }] },
      {
        OR: [
          { periodStart: schedule.periodStart, periodEnd: schedule.periodEnd },
          {
            periodStart: { lte: schedule.scheduledChargeAt },
            periodEnd: { gte: schedule.scheduledChargeAt },
          },
        ],
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
