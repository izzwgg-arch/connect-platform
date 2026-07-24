// SMS message templates — PURE. Outbound notifications + inbound replies. Concise,
// opt-out-aware, and NEVER include sensitive data (no address, payment, private instructions).

export type NotificationTrigger =
  | "out_for_delivery" | "approaching" | "delayed" | "delivered" | "failed" | "rescheduled";

export interface SmsContext {
  storeName: string;
  orderRef: string; // e.g. "#8842"
  etaText?: string | null;
  trackUrl?: string | null;
  statusLabel?: string | null;
}

const track = (url?: string | null) => (url ? ` Track: ${url}.` : "");
const optOut = " Reply STOP to opt out.";

/** Outbound trigger notification body. */
export function buildOutboundSms(trigger: NotificationTrigger, c: SmsContext): string {
  const eta = c.etaText ? `, ETA ${c.etaText}` : "";
  switch (trigger) {
    case "out_for_delivery":
      return `${c.storeName}: your order ${c.orderRef} is out for delivery${eta}.${track(c.trackUrl)}${optOut}`;
    case "approaching":
      return `${c.storeName}: your order ${c.orderRef} is arriving soon${eta}.${track(c.trackUrl)}`;
    case "delayed":
      return `${c.storeName}: your order ${c.orderRef} is running a little late. New estimate ${c.etaText || "shortly"}.${track(c.trackUrl)}`;
    case "delivered":
      return `${c.storeName}: your order ${c.orderRef} has been delivered. Thank you!${track(c.trackUrl)}`;
    case "failed":
      return `${c.storeName}: we attempted your order ${c.orderRef} but couldn't complete it. The store will follow up.${track(c.trackUrl)}`;
    case "rescheduled":
      return `${c.storeName}: your order ${c.orderRef} has been rescheduled.${track(c.trackUrl)}`;
  }
}

// ── Inbound replies ─────────────────────────────────────────────────────────────
export function buildStatusReply(c: SmsContext): string {
  const eta = c.etaText ? `, ETA ${c.etaText}` : "";
  return `Your order ${c.orderRef} is ${c.statusLabel || "in progress"}${eta}.${track(c.trackUrl)} Reply HELP for help.`;
}

export function buildTrackReply(c: SmsContext): string {
  return `Here is your tracking link for order ${c.orderRef}:${c.trackUrl ? ` ${c.trackUrl}` : " (unavailable — contact the store)"}`;
}

export function buildHelpReply(storeName: string): string {
  return `${storeName} delivery: reply STATUS for your order, TRACK for a link, ETA for arrival, or your order number. Reply STOP to opt out.`;
}

export function buildNoMatchReply(): string {
  return `We couldn't find an active order for this number. Reply with your order number, or contact the store for help.`;
}

export function buildMultiMatchReply(orderRefs: string[]): string {
  const list = orderRefs.slice(0, 5).join(", ");
  return `You have ${orderRefs.length} active orders: ${list}. Reply with the order number to check one.`;
}

export function buildOptOutReply(storeName: string): string {
  return `You've opted out of ${storeName} delivery texts. Reply START to opt back in.`;
}

export function buildOptInReply(storeName: string): string {
  return `You're opted back in to ${storeName} delivery texts. Reply STATUS any time.`;
}

/** Approx GSM-7 segment count (160 single / 153 concatenated). For length sanity in tests. */
export function approxSegments(body: string): number {
  const len = body.length;
  if (len <= 160) return 1;
  return Math.ceil(len / 153);
}
