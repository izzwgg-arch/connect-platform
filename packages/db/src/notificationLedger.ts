/**
 * Exactly-once claim ledger for user-visible mobile alerts.
 *
 * EVERY sender of a voicemail / missed_call / sms_message alert — the
 * real-time fast paths in api and worker AND the safety-net reconciler —
 * must claim (type, entityId, userId) here BEFORE sending. The database's
 * unique constraint arbitrates: exactly one caller wins and sends; every
 * other caller (parallel process, retry, reconciler sweep) gets false and
 * skips. This is what makes delivery race-proof and double-send-proof no
 * matter how many code paths exist now or are added later.
 *
 * FAIL-OPEN on infrastructure errors: if the claim insert fails for any
 * reason OTHER than the unique conflict (e.g. table missing during a
 * migration window), we return true so the alert still goes out — a rare
 * duplicate beats a silently dropped notification.
 */
import type { PrismaClient } from "@prisma/client";

export type NotificationLedgerType = "voicemail" | "missed_call" | "sms_message";

export async function claimNotification(
  db: PrismaClient,
  input: {
    type: NotificationLedgerType;
    entityId: string;
    userId: string;
    tenantId?: string | null;
    source: string;
  },
): Promise<boolean> {
  try {
    await (db as any).notificationLedger.create({
      data: {
        type: input.type,
        entityId: input.entityId,
        userId: input.userId,
        tenantId: input.tenantId ?? null,
        source: input.source,
      },
    });
    return true;
  } catch (err: any) {
    // Prisma unique-violation → someone else already claimed this alert.
    if (err?.code === "P2002") return false;
    console.warn(
      `[notification-ledger] claim failed (${err?.code ?? "unknown"}) — failing OPEN and sending anyway:`,
      err?.message ?? err,
    );
    return true;
  }
}
