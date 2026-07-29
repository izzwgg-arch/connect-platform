/**
 * Notification reconciler + canary — the permanent safety net for user alerts.
 *
 * WHY THIS EXISTS (2026-07-29): voicemail / missed-call / SMS alerts kept
 * silently dying because they were sent only from real-time fast paths spread
 * across three services — any broken resolver, lost race, or refactor killed a
 * path and nothing noticed. The durable FACTS, however, are always written
 * (Voicemail rows, missed ConnectCdr rows, inbound ConnectChatMessage rows).
 *
 * RECONCILER (every 60s): re-derives alerts from those facts. Any fact inside
 * the sweep window with no NotificationLedger claim gets its alert sent here,
 * at most ~2 minutes late. Even if every fast path breaks, alerts still flow.
 *
 * CANARY (hourly): counts resolvable facts older than the sweep grace with NO
 * ledger claim. In a healthy system that number is ZERO (the reconciler would
 * have swept them). Anything else means alert delivery is degraded — it logs
 * loudly and writes a PUSH_CANARY_ALERT audit row so the outage is visible
 * instead of silent.
 *
 * Both loops are additive and read-mostly; they never block or modify the
 * fast paths. Exactly-once is enforced by claimNotification's unique insert.
 */
import { db, claimNotification } from "@connect/db";

type SendPushFn = (input: {
  tenantId: string;
  userId: string;
  payload: Record<string, unknown>;
}) => Promise<unknown>;

type SendSmsPushFn = (input: {
  tenantId: string;
  userId: string;
  conversationId: string;
  messageId: string;
  phoneNumber: string;
  preview: string;
  timestamp: string;
}) => Promise<void>;

export interface NotificationReconcilerDeps {
  sendPush: SendPushFn;
  sendSmsPush: SendSmsPushFn;
}

// Sweep window: facts newer than MAX_AGE are eligible; facts newer than GRACE
// are left to the fast paths (they win the claim within seconds normally).
const SWEEP_MAX_AGE_MS = 30 * 60 * 1000;
const SWEEP_GRACE_MS = 2 * 60 * 1000;
// Canary looks at a window that the reconciler must have fully processed.
const CANARY_MAX_AGE_MS = 70 * 60 * 1000;
const CANARY_GRACE_MS = 5 * 60 * 1000;

const previewOf = (body: string): string => {
  const t = String(body || "").replace(/\s+/g, " ").trim();
  if (!t) return "New SMS message";
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
};

// ── Fact collection (shared by reconciler and canary) ────────────────────────

interface AlertCandidate {
  type: "voicemail" | "missed_call" | "sms_message";
  entityId: string;
  tenantId: string;
  userId: string;
  send: () => Promise<unknown>;
}

async function collectCandidates(
  deps: NotificationReconcilerDeps,
  from: Date,
  to: Date,
): Promise<AlertCandidate[]> {
  const out: AlertCandidate[] = [];

  // 1) Voicemails: new inbox rows. receivedAt is indexed; ingest can lag
  //    receivedAt by many minutes, so pre-filter generously then gate on
  //    createdAt (the moment Connect learned about it).
  const vms = await db.voicemail.findMany({
    where: {
      folder: "inbox",
      listened: false,
      deletedAt: null,
      tenantId: { not: null },
      receivedAt: { gte: new Date(from.getTime() - 60 * 60 * 1000) },
      createdAt: { gte: from, lte: to },
    },
    select: { id: true, tenantId: true, extension: true, callerName: true, callerNumber: true },
    take: 200,
  });
  for (const vm of vms) {
    const ext = await db.extension.findFirst({
      where: { tenantId: vm.tenantId!, extNumber: vm.extension, status: "ACTIVE", ownerUserId: { not: null } },
      select: { id: true, ownerUserId: true },
    });
    if (!ext?.ownerUserId) continue;
    out.push({
      type: "voicemail",
      entityId: vm.id,
      tenantId: vm.tenantId!,
      userId: ext.ownerUserId,
      send: () =>
        deps.sendPush({
          tenantId: vm.tenantId!,
          userId: ext.ownerUserId!,
          payload: {
            type: "voicemail",
            voicemailId: vm.id,
            tenantId: vm.tenantId!,
            extensionId: ext.id,
            recipientUserId: ext.ownerUserId!,
            callerNameOrNumber: vm.callerName || vm.callerNumber || "Unknown caller",
            timestamp: new Date().toISOString(),
          },
        }),
    });
  }

  // 2) Missed calls: incoming ConnectCdr rows classified missed. startedAt is
  //    indexed. Recipient resolution: the CallInvite for the same pbxCallId
  //    (authoritative — CDR toNumber is usually the DID, not the extension),
  //    falling back to an extension-number match when toNumber looks like one.
  const missed = await db.connectCdr.findMany({
    where: {
      direction: "incoming",
      disposition: "missed",
      tenantId: { not: null },
      startedAt: { gte: new Date(from.getTime() - 15 * 60 * 1000), lte: to },
      createdAt: { gte: from, lte: to },
    },
    select: { linkedId: true, tenantId: true, fromNumber: true, fromName: true, toNumber: true },
    take: 200,
  });
  for (const cdr of missed) {
    let userId: string | null = null;
    let extensionId: string | null = null;
    const invite = await db.callInvite.findFirst({
      where: { pbxCallId: cdr.linkedId },
      orderBy: { createdAt: "desc" },
      select: { userId: true },
    });
    if (invite?.userId) {
      userId = invite.userId;
    } else if (/^\d{2,6}$/.test(String(cdr.toNumber || "").trim())) {
      const ext = await db.extension.findFirst({
        where: { tenantId: cdr.tenantId!, extNumber: String(cdr.toNumber).trim(), status: "ACTIVE", ownerUserId: { not: null } },
        select: { id: true, ownerUserId: true },
      });
      userId = ext?.ownerUserId ?? null;
      extensionId = ext?.id ?? null;
    }
    if (!userId) continue;
    out.push({
      type: "missed_call",
      entityId: cdr.linkedId,
      tenantId: cdr.tenantId!,
      userId,
      send: () =>
        deps.sendPush({
          tenantId: cdr.tenantId!,
          userId: userId!,
          payload: {
            type: "missed_call",
            callId: cdr.linkedId,
            tenantId: cdr.tenantId!,
            ...(extensionId ? { extensionId } : {}),
            recipientUserId: userId!,
            callerNumber: cdr.fromNumber || "Unknown caller",
            callerNameOrNumber: cdr.fromName || cdr.fromNumber || "Unknown caller",
            timestamp: new Date().toISOString(),
          },
        }),
    });
  }

  // 3) Inbound SMS: INBOUND messages on SMS threads, fanned out per
  //    unmuted participant.
  const msgs = await db.connectChatMessage.findMany({
    where: {
      direction: "INBOUND",
      createdAt: { gte: from, lte: to },
      deletedForEveryoneAt: null,
      thread: { type: "SMS" },
    },
    select: {
      id: true,
      tenantId: true,
      threadId: true,
      body: true,
      thread: { select: { externalSmsE164: true } },
    },
    take: 300,
  });
  for (const m of msgs) {
    const participants = await db.connectChatParticipant.findMany({
      where: { threadId: m.threadId, leftAt: null, muted: false, userId: { not: null } },
      select: { userId: true },
    });
    for (const p of participants) {
      if (!p.userId) continue;
      out.push({
        type: "sms_message",
        entityId: m.id,
        tenantId: m.tenantId,
        userId: p.userId,
        send: () =>
          deps.sendSmsPush({
            tenantId: m.tenantId,
            userId: p.userId!,
            conversationId: m.threadId,
            messageId: m.id,
            phoneNumber: m.thread?.externalSmsE164 || "",
            preview: previewOf(m.body),
            timestamp: new Date().toISOString(),
          }),
      });
    }
  }

  return out;
}

// ── Reconciler ───────────────────────────────────────────────────────────────

let sweeping = false;

export async function runNotificationReconcileCycle(deps: NotificationReconcilerDeps): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = Date.now();
    const from = new Date(now - SWEEP_MAX_AGE_MS);
    const to = new Date(now - SWEEP_GRACE_MS);
    const candidates = await collectCandidates(deps, from, to);

    let sent = 0;
    const byType: Record<string, number> = {};
    for (const c of candidates) {
      // NOTE for the SMS path: sendSmsPush claims internally (shared choke
      // point with the poll path), so pre-claim only for the other types.
      if (c.type !== "sms_message") {
        const claimed = await claimNotification(db as any, {
          type: c.type,
          entityId: c.entityId,
          userId: c.userId,
          tenantId: c.tenantId,
          source: "reconciler",
        });
        if (!claimed) continue;
      } else {
        // Cheap existence check to avoid noisy send attempts; the claim
        // inside sendSmsPush remains the authoritative gate.
        const existing = await (db as any).notificationLedger.findUnique({
          where: { type_entityId_userId: { type: c.type, entityId: c.entityId, userId: c.userId } },
          select: { id: true },
        }).catch(() => null);
        if (existing) continue;
      }
      await c.send().catch((err: any) => {
        console.warn(
          `[notification-reconciler] send failed type=${c.type} entityId=${c.entityId} user=${c.userId}:`,
          err?.message ?? err,
        );
      });
      sent += 1;
      byType[c.type] = (byType[c.type] ?? 0) + 1;
    }
    if (sent > 0) {
      console.info(
        `[notification-reconciler] swept ${sent} missed alert(s): ${JSON.stringify(byType)} — a fast path failed to deliver these; check its logs`,
      );
    }
  } catch (err: any) {
    console.error("[notification-reconciler] cycle failed:", err?.message ?? err);
  } finally {
    sweeping = false;
  }
}

// ── Canary ───────────────────────────────────────────────────────────────────

let canaryRunning = false;

export async function runNotificationCanaryCycle(deps: NotificationReconcilerDeps): Promise<void> {
  if (canaryRunning) return;
  canaryRunning = true;
  try {
    const now = Date.now();
    const from = new Date(now - CANARY_MAX_AGE_MS);
    const to = new Date(now - CANARY_GRACE_MS);
    const candidates = await collectCandidates(deps, from, to);

    const unnotified: AlertCandidate[] = [];
    for (const c of candidates) {
      const row = await (db as any).notificationLedger.findUnique({
        where: { type_entityId_userId: { type: c.type, entityId: c.entityId, userId: c.userId } },
        select: { id: true },
      }).catch(() => null);
      if (!row) unnotified.push(c);
    }

    if (unnotified.length === 0) {
      console.info(
        `[notification-canary] healthy — ${candidates.length} resolvable alert fact(s) in the last hour, all claimed in the ledger`,
      );
      return;
    }

    // Degraded: resolvable facts exist that NOBODY (fast path or reconciler)
    // alerted on. This should be impossible while the reconciler runs — treat
    // it as an incident, loudly.
    const sample = unnotified.slice(0, 5).map((c) => `${c.type}:${c.entityId}→${c.userId}`);
    console.error(
      `[notification-canary] ALERT DELIVERY DEGRADED — ${unnotified.length} unclaimed alert fact(s) older than the sweep grace: ${sample.join(", ")}`,
    );
    await db.auditLog
      .create({
        data: {
          tenantId: unnotified[0]!.tenantId,
          action: "PUSH_CANARY_ALERT",
          entityType: "NotificationLedger",
          entityId: `degraded:${unnotified.length}`,
        },
      })
      .catch(() => undefined);
  } catch (err: any) {
    console.error("[notification-canary] cycle failed:", err?.message ?? err);
  } finally {
    canaryRunning = false;
  }
}
