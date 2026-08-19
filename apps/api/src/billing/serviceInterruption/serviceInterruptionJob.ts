/**
 * The daily sweep. Reads every tenant's billing state, asks
 * `decideForTenant` what should happen, and carries it out.
 *
 * ⛔⛔ THE CUTOVER IS THE SAFETY PROPERTY OF THIS WHOLE FEATURE.
 * Izzy, 2026-08-17: "Even if anything is past due, don't cut anything off. If
 * anything is past due right now, I will do it manually, but the rule goes
 * from now on." So `SERVICE_INTERRUPTION_CUTOVER_AT` must be set to the moment
 * this was armed, and any payment failure older than that is never acted on.
 * ⛔ Unset means the sweep does NOTHING AT ALL — see `serviceInterruptionCutover`.
 * Failing closed on a missing date is the only safe default: the alternative
 * is a first run that cuts off every overdue customer at once.
 */

import { decideForTenant, type SweepDecision } from "./serviceInterruptionSweep";
import { clearCountdown, readServiceInterruption, startCountdown, writeServiceInterruption } from "./serviceInterruptionSettings";

export type SweepDeps = {
  db: any;
  log: { info: (o: any, m: string) => void; warn: (o: any, m: string) => void; error: (o: any, m: string) => void };
  now?: () => Date;
  /** Queues the daily reminder. */
  sendReminder: (p: { tenantId: string; invoiceId: string; daysLeft: number; interruptAt: Date }) => Promise<void>;
  /** Switches the tenant's outbound members off. Returns what it disabled. */
  interrupt: (p: { tenantId: string; invoiceId: string }) => Promise<Array<{ arsId: string; outboundRouteId: string }>>;
  /** Switches back exactly what was recorded. */
  restore: (p: { tenantId: string; members: Array<{ arsId: string; outboundRouteId: string }> }) => Promise<void>;
};

export type SweepSummary = {
  considered: number;
  remindersSent: number;
  interrupted: number;
  restored: number;
  skippedPreCutover: number;
  errors: Array<{ tenantId: string; error: string }>;
};

/**
 * The moment the feature was armed. Anything that failed before this is the
 * existing backlog and is handled by hand.
 * ⛔ Returns null when unset, and a null cutover DISABLES the sweep entirely.
 */
export function serviceInterruptionCutover(env: NodeJS.ProcessEnv = process.env): Date | null {
  const raw = (env.SERVICE_INTERRUPTION_CUTOVER_AT || "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The invoice statuses that mean "a payment failed and the balance is still
 * owed". ⛔⛔ Every value MUST be a member of `BillingInvoiceStatus` in
 * `packages/db/prisma/schema.prisma` (DRAFT | OPEN | PAID | FAILED | OVERDUE |
 * VOID). Until 2026-08-19 this list carried `"UNPAID"`, which is not in the
 * enum — Prisma rejected the WHOLE query with `Invalid value for argument 'in'`,
 * the tenant landed in `errors[]`, and the reminder/cutoff logic had never run
 * for anyone. `serviceInterruptionJob.test.ts` checks this list against the
 * real schema now.
 *
 * - `FAILED`  — a charge was attempted and declined (`solaBillingPayments.ts`).
 * - `OVERDUE` — marked past due by hand in the invoice editor.
 * ⛔ `OPEN` is deliberately NOT here: an OPEN invoice is issued but nobody has
 * tried to collect it yet — invoices are created ahead of the payment date, so
 * counting OPEN would start the countdown before the card was even charged.
 * The owner's rule is "when a payment FAILS".
 */
export const UNPAID_FAILURE_STATUSES = ["FAILED", "OVERDUE"] as const;

/** The tenant's oldest still-unpaid failed invoice. */
async function oldestOpenFailure(db: any, tenantId: string) {
  const inv = await db.billingInvoice.findFirst({
    where: {
      tenantId,
      status: { in: [...UNPAID_FAILURE_STATUSES] },
      balanceDueCents: { gt: 0 },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, balanceDueCents: true, createdAt: true, metadata: true, updatedAt: true },
  });
  if (!inv) return null;
  // The FIRST failure, from the dunning slice (`mergeDunningAfterFailure`
  // stamps `firstFailedAt` once and never moves it) — never the latest attempt,
  // or an autopay retry would push the cutoff back forever. An invoice that
  // failed before that stamp existed falls back to `createdAt`, which is
  // earlier than the real failure — it errs towards LESS grace, never more.
  const dunning = (inv.metadata as any)?.dunning ?? {};
  const firstFailedAt = dunning.firstFailedAt ? new Date(dunning.firstFailedAt) : new Date(inv.createdAt);
  return {
    id: inv.id,
    balanceDueCents: Number(inv.balanceDueCents || 0),
    firstFailedAt: Number.isNaN(firstFailedAt.getTime()) ? new Date(inv.createdAt) : firstFailedAt,
  };
}

export async function runServiceInterruptionSweep(deps: SweepDeps): Promise<SweepSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoverAt = serviceInterruptionCutover();
  const summary: SweepSummary = {
    considered: 0,
    remindersSent: 0,
    interrupted: 0,
    restored: 0,
    skippedPreCutover: 0,
    errors: [],
  };

  if (!cutoverAt) {
    deps.log.warn(
      { reason: "SERVICE_INTERRUPTION_CUTOVER_AT is not set" },
      "[SERVICE_INTERRUPTION] sweep disabled — refusing to run without a cutover date",
    );
    return summary;
  }

  const settings = await deps.db.tenantBillingSettings.findMany({
    select: { tenantId: true, metadata: true },
  });

  for (const row of settings) {
    const s = readServiceInterruption(row.metadata);
    const interrupted = Boolean(s.interruptedAt) && !s.restoredAt;
    // Skip cheaply: a tenant that is switched off and not currently cut off
    // can never need anything. ⛔ The `interrupted` half matters — someone cut
    // off before the switch was turned off must still be able to be restored.
    if (!s.enabled && !interrupted && !s.countdownStartedAt) continue;
    summary.considered++;

    try {
      const openFailedInvoice = await oldestOpenFailure(deps.db, row.tenantId);
      const decision: SweepDecision = decideForTenant({
        metadata: row.metadata,
        openFailedInvoice,
        now,
        cutoverAt,
      });

      if (decision.action === "none") {
        if (decision.reason.includes("before the cutover")) summary.skippedPreCutover++;
        // Paid, but a stale countdown is lying around — tidy it away.
        if (!openFailedInvoice && s.countdownStartedAt && !interrupted) {
          await deps.db.tenantBillingSettings.update({
            where: { tenantId: row.tenantId },
            data: { metadata: clearCountdown(row.metadata, now) },
          });
        }
        continue;
      }

      if (decision.action === "start_countdown") {
        await deps.db.tenantBillingSettings.update({
          where: { tenantId: row.tenantId },
          data: { metadata: startCountdown(row.metadata, { invoiceId: decision.invoiceId, failedAt: decision.failedAt }) },
        });
        deps.log.info({ tenantId: row.tenantId, invoiceId: decision.invoiceId }, "[SERVICE_INTERRUPTION] countdown started");
        continue;
      }

      if (decision.action === "send_reminder") {
        await deps.sendReminder({
          tenantId: row.tenantId,
          invoiceId: decision.invoiceId,
          daysLeft: decision.daysLeft,
          interruptAt: decision.interruptAt,
        });
        // ⛔ Stamped AFTER the send. Stamping first would silently swallow a
        // day's reminder whenever the queue insert failed.
        await deps.db.tenantBillingSettings.update({
          where: { tenantId: row.tenantId },
          data: {
            metadata: writeServiceInterruption(row.metadata, {
              lastReminderAt: now.toISOString(),
              lastReminderDaysLeft: decision.daysLeft,
            }),
          },
        });
        summary.remindersSent++;
        continue;
      }

      if (decision.action === "interrupt") {
        const disabled = await deps.interrupt({ tenantId: row.tenantId, invoiceId: decision.invoiceId });
        await deps.db.tenantBillingSettings.update({
          where: { tenantId: row.tenantId },
          data: {
            metadata: writeServiceInterruption(row.metadata, {
              interruptedAt: now.toISOString(),
              disabledArsMembers: disabled,
            }),
          },
        });
        summary.interrupted++;
        deps.log.warn(
          { tenantId: row.tenantId, invoiceId: decision.invoiceId, members: disabled.length },
          "[SERVICE_INTERRUPTION] service interrupted",
        );
        continue;
      }

      if (decision.action === "restore") {
        await deps.restore({ tenantId: row.tenantId, members: s.disabledArsMembers });
        await deps.db.tenantBillingSettings.update({
          where: { tenantId: row.tenantId },
          data: { metadata: clearCountdown(row.metadata, now) },
        });
        summary.restored++;
        deps.log.info({ tenantId: row.tenantId }, "[SERVICE_INTERRUPTION] service restored");
      }
    } catch (e: any) {
      // ⛔ One tenant's failure must never stop the sweep — the customer after
      // them may be the one waiting to be restored.
      summary.errors.push({ tenantId: row.tenantId, error: e?.message || String(e) });
      deps.log.error({ tenantId: row.tenantId, err: e?.message || String(e) }, "[SERVICE_INTERRUPTION] tenant failed");
    }
  }

  return summary;
}
