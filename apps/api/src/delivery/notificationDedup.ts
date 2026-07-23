// Notification idempotency/dedup — PURE. Prevents duplicate customer notifications and
// carries the opt-out gate. The service persists sent keys (DeliveryNotification.idempotencyKey).

import type { NotificationTrigger } from "./smsTemplates";

/** Deterministic key: one notification per (order, trigger). */
export function notificationIdempotencyKey(orderId: string, trigger: NotificationTrigger): string {
  return `${orderId}:${trigger}`;
}

export interface SendDecision {
  send: boolean;
  reason?: "duplicate" | "opted_out" | "no_consent";
  key: string;
}

/**
 * Decide whether to send. Pure. `sentKeys` = idempotency keys already recorded for the order.
 * `optedOut` honors STOP for all delivery texts (compliance).
 */
export function decideSend(
  orderId: string,
  trigger: NotificationTrigger,
  opts: { sentKeys: ReadonlySet<string>; optedOut: boolean },
): SendDecision {
  const key = notificationIdempotencyKey(orderId, trigger);
  if (opts.optedOut) return { send: false, reason: "opted_out", key };
  if (opts.sentKeys.has(key)) return { send: false, reason: "duplicate", key };
  return { send: true, key };
}
