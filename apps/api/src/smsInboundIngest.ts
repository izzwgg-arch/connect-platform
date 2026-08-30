/**
 * Inbound-SMS ingest registry — how a NON-VoIP.ms webhook reaches the chat
 * system without a second ingest implementation.
 *
 * The whole inbound pipeline (sender canonicalisation → TenantSmsNumber lookup
 * → thread create/dedupe → participants → message row → MMS mirror → routing
 * log → pushes → CRM hook) lives ONCE, inside `registerConnectChatRoutes`
 * (apps/api/src/connectChatRoutes.ts), because it needs the route closure's
 * `deps.sendPushToUserDevices`. ⛔ Duplicating that tail for SignalWire is the
 * exact two-publish-paths defect this repo keeps paying for — instead, the
 * chat routes REGISTER their ingest function here at boot, and any other
 * inbound door (SignalWire's `/webhooks/signalwire/sms`, a future carrier)
 * calls it after doing its OWN authentication.
 *
 * ⛔ THE CALLER AUTHENTICATES; THIS DOES NOT. An ingest call means "a verified
 * carrier webhook delivered this message" — every door must fail closed on its
 * own signature check before calling (the VoIP.ms door checks its webhook
 * secret; SignalWire verifies X-SignalWire-Signature with the signing key).
 *
 * `providerMessageId` arrives FULLY PREFIXED (`voipms:123`, `signalwire:SM…`)
 * so dedupe against the worker's poll and status webhooks stays exact.
 */

export type InboundSmsIngestInput = {
  rawFrom: string;
  rawTo: string;
  message: string;
  /** Fully prefixed provider message id (`signalwire:SM…`), or null. */
  providerMessageId: string | null;
  mmsUrls: string[];
  /** The raw webhook payload — stored on the SmsRoutingLog row. */
  payload: unknown;
  log?: { info?: (...a: any[]) => void; warn?: (...a: any[]) => void };
};

export type InboundSmsIngestOutcome = "routed" | "invalid_to" | "unassigned" | "duplicate";

export type InboundSmsIngestFn = (input: InboundSmsIngestInput) => Promise<InboundSmsIngestOutcome>;

let ingest: InboundSmsIngestFn | null = null;

export function registerInboundSmsIngest(fn: InboundSmsIngestFn): void {
  ingest = fn;
}

export function getInboundSmsIngest(): InboundSmsIngestFn | null {
  return ingest;
}
