/**
 * Customer-facing delivery-failure copy (unified messaging, 2026-09-16).
 *
 * ⛔ THE RULE (Izzy, verbatim): "The customer should never see the word Telnyx
 * or SignalWire or VoIP.ms, nothing." `ConnectChatMessage.deliveryError` is a
 * carrier-facing string — "Telnyx refused the message: …", "SIGNALWIRE_21610",
 * "VOIPMS_NOT_CONFIGURED" — and until 2026-09-16 it shipped RAW to every
 * client and rendered in the chat meta line. This module is the ONE door the
 * messages projection sends errors through for non-platform viewers; platform
 * staff (SUPER_ADMIN) keep the raw string.
 *
 * Whitelist by construction: the output is always one of the fixed phrases
 * below — never a transformation of the raw string — so no carrier name, code
 * or provider detail can survive into it. The test corpus includes the real
 * production strings.
 */

const FIXED_PHRASES = {
  media: "Media can't be sent from this number — sent as a link instead when possible.",
  incomplete: "This conversation is missing a phone number.",
  landlineish: "This number can't receive text messages.",
  generic: "Not delivered.",
} as const;

export function sanitizeCustomerDeliveryError(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const u = s.toUpperCase();
  if (u === "MMS_NOT_AVAILABLE") return FIXED_PHRASES.media;
  if (u === "SMS_THREAD_INCOMPLETE") return FIXED_PHRASES.incomplete;
  if (/LANDLINE|NOT.SMS.CAPABLE|UNREACHABLE.DESTINATION/i.test(s)) return FIXED_PHRASES.landlineish;
  return FIXED_PHRASES.generic;
}

/** Every phrase a customer can ever see — exported so the guard test can prove
 *  none carries a carrier name, and future phrases inherit the proof. */
export const CUSTOMER_DELIVERY_PHRASES: readonly string[] = Object.values(FIXED_PHRASES);
