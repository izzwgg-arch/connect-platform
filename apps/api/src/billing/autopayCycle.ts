import type { BillingSchedule } from "./billingSchedule";

/** Find the non-VOID tenant invoice for the current autopay billing period. */
export function autopayPeriodInvoiceWhere(tenantId: string, schedule: BillingSchedule) {
  return {
    tenantId,
    billingProfileId: null,
    status: { not: "VOID" as const },
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
