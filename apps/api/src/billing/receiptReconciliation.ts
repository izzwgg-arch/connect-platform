/**
 * Receipt email reconciliation sweep — the safety net that guarantees every
 * approved payment eventually produces a receipt email.
 *
 * Why this exists: receipts have repeatedly gone missing in production because
 * the primary path (queueReceiptEmailOnce right after a charge) silently
 * skipped when the tenant had no billing email, or the EmailJob failed all
 * retries with nobody watching. This sweep runs periodically in BOTH the API
 * and the worker (redundancy) and, for every APPROVED PaymentTransaction in
 * the lookback window:
 *
 *   1. If a BILLING_RECEIPT EmailJob exists for the transaction
 *      (matched via the connect-billing-transaction:<id> marker):
 *        - SENT / QUEUED / RUNNING / retrying  → nothing to do.
 *        - FAILED with attempts exhausted      → revive it (reset attempts) at
 *          most once per RETRY_INTERVAL, so delivery is retried forever.
 *   2. If no EmailJob exists → queue the receipt now (force=true bypasses the
 *      stale receipt_emailed sentinel). If no recipient can be resolved at
 *      all, queueReceiptEmailOnce escalates an ADMIN_ALERT (once per tx) and
 *      the sweep retries again after RETRY_INTERVAL — self-healing once a
 *      billing email is configured.
 *
 * MANUAL (external) payments are only reconciled when a receipt was actually
 * intended at posting time (evidenced by a receipt_emailed / receipt_email_skipped /
 * receipt_email_escalated event) — operators may legitimately opt out.
 *
 * Every action is throttled per-transaction via BillingEventLog sentinels
 * (receipt_email_reconcile_attempted / receipt_email_revived), which also
 * makes concurrent API + worker sweeps effectively race-safe. Any sweep that
 * takes an action queues one ADMIN_ALERT summary so the operator always knows.
 */

import { db } from "@connect/db";
import { queueReceiptEmailOnce, queueBillingAdminAlertEmail } from "./billingEmailLifecycle";
import { externalMethodLabel, type ExternalPaymentMethodType } from "./externalPayment";

export const RECEIPT_SWEEP_LOOKBACK_DAYS = 30;
/** Ignore very fresh transactions — the primary path gets time to queue first. */
export const RECEIPT_SWEEP_MIN_AGE_MS = 10 * 60_000;
/** Minimum interval between reconcile attempts / revives for the same transaction. */
export const RECEIPT_SWEEP_RETRY_INTERVAL_MS = 6 * 3600_000;
const RECEIPT_EMAIL_MAX_ATTEMPTS_DEFAULT = 5;

export type ReceiptSweepSummary = {
  scanned: number;
  /** Receipts newly queued by the sweep (primary path had missed them). */
  queued: number;
  /** Permanently-failed receipt jobs reset for another round of retries. */
  revived: number;
  /** Transactions newly escalated to the operator (no recipient at all). */
  escalated: number;
  errors: number;
  details: string[];
};

function cardLabelForTransaction(tx: any): string | null {
  if (tx?.paymentMethod?.last4) {
    return `${tx.paymentMethod.brand || "Card"} ending ${tx.paymentMethod.last4}`;
  }
  if (tx?.externalMethod) {
    try {
      return externalMethodLabel(tx.externalMethod as ExternalPaymentMethodType);
    } catch {
      return String(tx.externalMethod);
    }
  }
  return null;
}

async function hasEventForTransaction(type: string, transactionId: string, sinceMs?: number): Promise<boolean> {
  const where: any = { type, message: transactionId };
  if (sinceMs) where.createdAt = { gte: new Date(Date.now() - sinceMs) };
  const e = await (db as any).billingEventLog.findFirst({ where });
  return !!e;
}

/** MANUAL payments: was a receipt ever intended for this transaction? */
async function manualReceiptWasIntended(transactionId: string): Promise<boolean> {
  if (await hasEventForTransaction("receipt_emailed", transactionId)) return true;
  if (await hasEventForTransaction("receipt_email_escalated", transactionId)) return true;
  const skipped = await (db as any).billingEventLog.findFirst({
    where: { type: "receipt_email_skipped", metadata: { path: ["transactionId"], equals: transactionId } },
  }).catch(() => null);
  return !!skipped;
}

export async function sweepMissingReceiptEmails(options?: {
  lookbackDays?: number;
  minAgeMs?: number;
  retryIntervalMs?: number;
  limit?: number;
  /** e.g. "api" | "worker" — recorded in events + alerts. */
  runner?: string;
}): Promise<ReceiptSweepSummary> {
  const lookbackDays = options?.lookbackDays ?? RECEIPT_SWEEP_LOOKBACK_DAYS;
  const minAgeMs = options?.minAgeMs ?? RECEIPT_SWEEP_MIN_AGE_MS;
  const retryIntervalMs = options?.retryIntervalMs ?? RECEIPT_SWEEP_RETRY_INTERVAL_MS;
  const runner = options?.runner || "api";
  const summary: ReceiptSweepSummary = { scanned: 0, queued: 0, revived: 0, escalated: 0, errors: 0, details: [] };

  const transactions: any[] = await (db as any).paymentTransaction.findMany({
    where: {
      status: "APPROVED",
      invoiceId: { not: null },
      amountCents: { gt: 0 },
      createdAt: {
        gte: new Date(Date.now() - lookbackDays * 24 * 3600_000),
        lte: new Date(Date.now() - minAgeMs),
      },
    },
    include: {
      invoice: { select: { id: true, invoiceNumber: true, totalCents: true } },
      paymentMethod: { select: { brand: true, last4: true } },
    },
    orderBy: { createdAt: "asc" },
    take: options?.limit ?? 500,
  });

  for (const tx of transactions) {
    summary.scanned += 1;
    try {
      if (!tx.invoice) continue;
      const marker = `connect-billing-transaction:${tx.id}`;
      const job = await (db as any).emailJob.findFirst({
        where: { tenantId: tx.tenantId, type: "BILLING_RECEIPT", htmlBody: { contains: marker } },
        orderBy: { createdAt: "desc" },
      });

      if (job) {
        if (job.status === "SENT" || job.status === "QUEUED" || job.status === "RUNNING") continue;
        const maxAttempts = Number(job.maxAttempts ?? RECEIPT_EMAIL_MAX_ATTEMPTS_DEFAULT) || RECEIPT_EMAIL_MAX_ATTEMPTS_DEFAULT;
        if (job.status === "FAILED" && Number(job.attempts ?? 0) < maxAttempts) continue; // retry still pending
        // Permanently failed — revive it (throttled), so it retries forever.
        if (await hasEventForTransaction("receipt_email_revived", tx.id, retryIntervalMs)) continue;
        await (db as any).billingEventLog.create({
          data: {
            tenantId: tx.tenantId,
            invoiceId: tx.invoiceId,
            type: "receipt_email_revived",
            message: tx.id,
            metadata: { emailJobId: job.id, lastErrorCode: job.lastErrorCode ?? null, runner },
          },
        });
        await (db as any).emailJob.update({
          where: { id: job.id },
          data: { status: "QUEUED", attempts: 0, nextRunAt: new Date(), lastErrorCode: null, lastErrorMessage: null },
        });
        summary.revived += 1;
        summary.details.push(`REVIVED failed receipt job ${job.id} (tx ${tx.id}, invoice ${tx.invoice.invoiceNumber}, lastError ${job.lastErrorCode || "?"})`);
        continue;
      }

      // No receipt EmailJob exists for this approved payment.
      if (tx.source === "MANUAL" && !(await manualReceiptWasIntended(tx.id))) continue;

      // Throttle attempts per transaction; also acts as a soft lock across
      // concurrent API/worker sweeps (sentinel is written before queueing).
      if (await hasEventForTransaction("receipt_email_reconcile_attempted", tx.id, retryIntervalMs)) continue;
      const hadEscalation = await hasEventForTransaction("receipt_email_escalated", tx.id);
      await (db as any).billingEventLog.create({
        data: {
          tenantId: tx.tenantId,
          invoiceId: tx.invoiceId,
          type: "receipt_email_reconcile_attempted",
          message: tx.id,
          metadata: { runner },
        },
      });

      const queued = await queueReceiptEmailOnce({
        tenantId: tx.tenantId,
        invoiceId: tx.invoiceId,
        invoiceNumber: tx.invoice.invoiceNumber,
        totalCents: tx.amountCents ?? tx.invoice.totalCents,
        transactionId: tx.id,
        cardLabel: cardLabelForTransaction(tx),
        force: true,
      });
      if (queued) {
        await (db as any).billingEventLog.create({
          data: {
            tenantId: tx.tenantId,
            invoiceId: tx.invoiceId,
            type: "receipt_email_reconciled",
            message: tx.id,
            metadata: { runner },
          },
        });
        summary.queued += 1;
        summary.details.push(`QUEUED missing receipt for tx ${tx.id} (invoice ${tx.invoice.invoiceNumber}, $${((tx.amountCents ?? 0) / 100).toFixed(2)})`);
      } else if (!hadEscalation) {
        // queueReceiptEmailOnce already logged the skip + escalated the alert.
        summary.escalated += 1;
        summary.details.push(`ESCALATED tx ${tx.id} (invoice ${tx.invoice.invoiceNumber}) — no recipient resolvable`);
      }
    } catch (err: any) {
      summary.errors += 1;
      summary.details.push(`ERROR tx ${tx?.id}: ${String(err?.message || err).slice(0, 200)}`);
    }
  }

  if (summary.queued > 0 || summary.revived > 0 || summary.escalated > 0 || summary.errors > 0) {
    await queueBillingAdminAlertEmail(
      `Receipt reconciliation sweep (${runner}): ${summary.queued} queued, ${summary.revived} revived, ${summary.escalated} escalated`,
      [
        `The receipt reconciliation sweep found approved payments whose receipt emails`,
        `were missing or stuck, and took action:`,
        ``,
        ...summary.details,
        ``,
        `Scanned ${summary.scanned} approved payment transaction(s) from the last ${lookbackDays} day(s).`,
      ],
    ).catch(() => false);
  }

  return summary;
}
