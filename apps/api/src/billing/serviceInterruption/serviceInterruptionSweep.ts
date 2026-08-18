/**
 * The daily decision, for one tenant. Pure — decides, does not act.
 *
 * One function answers "what should happen to this customer today", so the
 * whole state machine can be read and tested in one place instead of being
 * spread across a job with database calls in the middle of it.
 */

import {
  SERVICE_INTERRUPTION_GRACE_DAYS,
  computeInterruptionState,
} from "./serviceInterruptionPolicy";
import { readServiceInterruption } from "./serviceInterruptionSettings";

export type SweepInput = {
  /** `TenantBillingSettings.metadata`. */
  metadata: unknown;
  /** The tenant's oldest unpaid failed invoice, if any. */
  openFailedInvoice: { id: string; firstFailedAt: Date; balanceDueCents: number } | null;
  now: Date;
};

export type SweepDecision =
  | { action: "none"; reason: string }
  | { action: "start_countdown"; invoiceId: string; failedAt: Date }
  | { action: "send_reminder"; daysLeft: number; interruptAt: Date; invoiceId: string }
  | { action: "interrupt"; invoiceId: string }
  | { action: "restore"; reason: "paid" };

/**
 * ⛔ ORDER MATTERS AND RESTORE COMES FIRST. A customer who has paid must be
 * put back before anything else is considered — getting this wrong leaves a
 * paying customer switched off for a day, which is the worst outcome here.
 */
export function decideForTenant(input: SweepInput): SweepDecision {
  const s = readServiceInterruption(input.metadata);
  const interrupted = Boolean(s.interruptedAt) && !s.restoredAt;

  // 1. Paid up? Put them back, whether or not the switch is still on. Turning
  //    the feature off must never strand somebody in the interrupted state.
  if (!input.openFailedInvoice) {
    if (interrupted) return { action: "restore", reason: "paid" };
    return { action: "none", reason: s.countdownStartedAt ? "no open failure — countdown will be cleared" : "nothing owed" };
  }

  // 2. The switch. Off means the countdown never runs at all.
  if (!s.enabled) return { action: "none", reason: "service interruption is switched off for this tenant" };

  const invoice = input.openFailedInvoice;

  // 3. No clock yet — start it from this failure.
  if (!s.countdownStartedAt || s.invoiceId !== invoice.id) {
    return { action: "start_countdown", invoiceId: invoice.id, failedAt: invoice.firstFailedAt };
  }

  // 4. Already switched off — nothing further to do until they pay.
  if (interrupted) return { action: "none", reason: "already interrupted, waiting for payment" };

  const state = computeInterruptionState({
    firstFailedAt: new Date(s.countdownStartedAt),
    now: input.now,
    graceDays: s.graceDays ?? SERVICE_INTERRUPTION_GRACE_DAYS,
  });

  // 5. Time is up.
  if (state.dueForInterruption) return { action: "interrupt", invoiceId: invoice.id };

  // 6. Otherwise a reminder, at most one per day.
  //    ⛔ Keyed on the days-left NUMBER, not on elapsed time: a worker restart
  //    or a slow sweep must not send "3 days left" twice, and a sweep that
  //    runs late must not skip a day silently.
  if (s.lastReminderDaysLeft === state.daysLeft) {
    return { action: "none", reason: `already told them ${state.daysLeft} days left` };
  }
  return {
    action: "send_reminder",
    daysLeft: state.daysLeft,
    interruptAt: state.interruptAt,
    invoiceId: invoice.id,
  };
}
