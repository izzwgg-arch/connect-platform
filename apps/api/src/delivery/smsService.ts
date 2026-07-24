// Delivery SMS service (Phase 7). TEST-MODE by default: outbound notifications are recorded
// (deduped, consent-gated) but NOT actually sent unless DELIVERY_SMS_LIVE=1 AND the production
// provider/queue wiring is completed under separate approval. Inbound command handling +
// STOP/START consent are fully functional (used by the test/simulate endpoint).

import { db } from "@connect/db";
import { parseSmsCommand } from "./smsCommands";
import {
  buildOutboundSms, buildStatusReply, buildTrackReply, buildHelpReply, buildNoMatchReply,
  buildMultiMatchReply, buildOptOutReply, buildOptInReply, type NotificationTrigger,
} from "./smsTemplates";
import { decideSend } from "./notificationDedup";
import { publicStatus } from "./customerView";
import { getDeliverySettings } from "./settingsService";
import { mintTrackingLink } from "./customerTrackingService";
import { writeDeliveryAudit } from "./audit";
import type { DeliveryOrderStatus } from "./status";

const SMS_LIVE = process.env.DELIVERY_SMS_LIVE === "1"; // production dispatch stays OFF unless set
const TRACK_BASE = (process.env.PUBLIC_TRACKING_BASE_URL || "").replace(/\/$/, "");

function last10(raw: string | null | undefined): string {
  return String(raw || "").replace(/\D/g, "").slice(-10);
}

async function isOptedOut(tenantId: string, phone: string): Promise<boolean> {
  const row = await db.deliverySmsConsent.findUnique({
    where: { tenantId_phoneE164: { tenantId, phoneE164: last10(phone) } },
    select: { optedOut: true },
  });
  return Boolean(row?.optedOut);
}

async function setConsent(tenantId: string, phone: string, optedOut: boolean) {
  const now = new Date();
  await db.deliverySmsConsent.upsert({
    where: { tenantId_phoneE164: { tenantId, phoneE164: last10(phone) } },
    create: { tenantId, phoneE164: last10(phone), optedOut, optedOutAt: optedOut ? now : null, optedInAt: optedOut ? null : now },
    update: { optedOut, optedOutAt: optedOut ? now : undefined, optedInAt: optedOut ? undefined : now },
  });
}

const NOTIFY_FLAG: Partial<Record<NotificationTrigger, string>> = {
  out_for_delivery: "notifyOutForDelivery",
  delayed: "notifyDelayed",
  delivered: "notifyDelivered",
  approaching: "notifyApproaching",
};

/** Record (and, when live, send) a trigger notification for an order. Deduped + consent-gated. */
export async function notifyOrder(tenantId: string, orderId: string, trigger: NotificationTrigger, storeName = "Delivery") {
  const order = await db.deliveryOrder.findFirst({
    where: { id: orderId, tenantId },
    select: { id: true, sourceId: true, customerPhone: true },
  });
  if (!order) return { ok: false as const, code: "not_found" };

  const settings: any = await getDeliverySettings(tenantId);
  const flag = NOTIFY_FLAG[trigger];
  if (flag && settings[flag] === false) return { ok: true as const, skipped: "trigger_disabled" as const };

  const phone = order.customerPhone;
  const optedOut = phone ? await isOptedOut(tenantId, phone) : false;

  const sent = await db.deliveryNotification.findMany({ where: { tenantId, orderId }, select: { idempotencyKey: true } });
  const decision = decideSend(orderId, trigger, { sentKeys: new Set(sent.map((s) => s.idempotencyKey)), optedOut });
  if (!decision.send) return { ok: true as const, skipped: decision.reason };

  // Mint a fresh tracking link for the message.
  const link = await mintTrackingLink(tenantId, orderId, 72);
  const trackUrl = link.ok && TRACK_BASE ? `${TRACK_BASE}/track/${link.token}` : link.ok ? `/track/${link.token}` : null;
  const body = buildOutboundSms(trigger, { storeName, orderRef: `#${order.sourceId}`, trackUrl });

  try {
    await db.deliveryNotification.create({
      data: {
        tenantId, orderId, trigger, channel: "SMS", toPhone: phone ?? null, body,
        idempotencyKey: decision.key, status: SMS_LIVE ? "QUEUED" : "TEST",
      },
    });
  } catch (e: any) {
    if (e?.code === "P2002") return { ok: true as const, skipped: "duplicate" as const };
    throw e;
  }

  writeDeliveryAudit({ tenantId, action: "delivery.notification.recorded", entityType: "DeliveryOrder", entityId: orderId, metadata: { trigger, live: SMS_LIVE } });
  // Production dispatch (enqueue to sms-send) is intentionally gated behind SMS_LIVE + approved
  // provider wiring — not activated here.
  return { ok: true as const, recorded: true, live: SMS_LIVE, body };
}

/** Handle an inbound SMS command. Returns the reply text (caller sends it). */
export async function handleInboundSms(tenantId: string, from: string, rawBody: string, storeName = "Delivery") {
  const parsed = parseSmsCommand(rawBody);

  if (parsed.intent === "stop") { await setConsent(tenantId, from, true); return { reply: buildOptOutReply(storeName), intent: parsed.intent }; }
  if (parsed.intent === "start") { await setConsent(tenantId, from, false); return { reply: buildOptInReply(storeName), intent: parsed.intent }; }
  if (parsed.intent === "help") return { reply: buildHelpReply(storeName), intent: parsed.intent };

  // Resolve active orders for this sender (last-10 match, tenant-scoped).
  const phone = last10(from);
  const candidates = await db.deliveryOrder.findMany({
    where: { tenantId, status: { notIn: ["DELIVERED", "CANCELED"] } },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: { id: true, sourceId: true, status: true, customerPhone: true },
  });
  let orders = candidates.filter((o) => last10(o.customerPhone) === phone);

  // ORDER <#> narrows to that order.
  if (parsed.intent === "order" && parsed.orderNumber) {
    orders = orders.filter((o) => o.sourceId.toUpperCase().endsWith(parsed.orderNumber!.toUpperCase()));
  }

  if (orders.length === 0) return { reply: buildNoMatchReply(), intent: parsed.intent };
  if (orders.length > 1 && parsed.intent !== "order") {
    return { reply: buildMultiMatchReply(orders.map((o) => `#${o.sourceId}`)), intent: parsed.intent };
  }

  const order = orders[0];
  const link = await mintTrackingLink(tenantId, order.id, 72);
  const trackUrl = link.ok && TRACK_BASE ? `${TRACK_BASE}/track/${link.token}` : link.ok ? `/track/${link.token}` : null;
  const label = publicStatus(order.status as DeliveryOrderStatus).label;
  const ctx = { storeName, orderRef: `#${order.sourceId}`, statusLabel: label, trackUrl };

  if (parsed.intent === "track") return { reply: buildTrackReply(ctx), intent: parsed.intent };
  return { reply: buildStatusReply(ctx), intent: parsed.intent }; // status / eta / order
}
