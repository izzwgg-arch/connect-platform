/**
 * Structured log helper — ensures every log emitted from the telephony service
 * carries consistent fields for correlation in Loki / log search tools.
 *
 * Fields:
 *   tenantId      — which tenant this event belongs to (or null for system events)
 *   extension     — SIP extension number, if applicable
 *   linkedId      — call linked ID (Asterisk CDR linkedid)
 *   callId        — channel name or ARI call ID
 *   eventType     — machine-readable event type (e.g. call_start, call_end, ami_disconnect)
 *   errorCode     — short code for errors (e.g. AMI_TIMEOUT, CDR_POST_FAIL)
 *   plainMsg      — non-technical plain-English description for operators
 */

import { childLogger } from "./logger";

const log = childLogger("Structured");

export type StructuredFields = {
  tenantId?: string | null;
  extension?: string | null;
  linkedId?: string | null;
  callId?: string | null;
  eventType: string;
  errorCode?: string | null;
  plainMsg: string;
  [key: string]: unknown;
};

export function logEvent(fields: StructuredFields): void {
  const { eventType, plainMsg, ...rest } = fields;
  log.info({ eventType, ...rest }, plainMsg);
}

export function logWarn(fields: StructuredFields): void {
  const { eventType, plainMsg, ...rest } = fields;
  log.warn({ eventType, ...rest }, plainMsg);
}

export function logError(fields: StructuredFields & { err?: unknown }): void {
  const { eventType, plainMsg, err, ...rest } = fields;
  log.error({ eventType, err, ...rest }, plainMsg);
}

// ── Common event types ────────────────────────────────────────────────────────

export const EventType = {
  // PBX connectivity
  AMI_CONNECTED:    "ami_connected",
  AMI_DISCONNECTED: "ami_disconnected",
  AMI_ERROR:        "ami_error",
  ARI_CONNECTED:    "ari_connected",
  ARI_DISCONNECTED: "ari_disconnected",

  // Call lifecycle
  CALL_START:       "call_start",
  CALL_ANSWERED:    "call_answered",
  CALL_ENDED:       "call_ended",
  CALL_MISSED:      "call_missed",
  CALL_FAILED:      "call_failed",
  CALL_HELD:        "call_held",
  CALL_TRANSFERRED: "call_transferred",

  // CDR
  CDR_POSTED:       "cdr_posted",
  CDR_SKIP:         "cdr_skip",
  CDR_POST_FAIL:    "cdr_post_fail",

  // Extension/registration
  EXT_REGISTERED:   "ext_registered",
  EXT_UNREGISTERED: "ext_unregistered",
  EXT_UNREACHABLE:  "ext_unreachable",

  // System
  SERVICE_STARTED:  "service_started",
  SERVICE_STOPPED:  "service_stopped",
} as const;
