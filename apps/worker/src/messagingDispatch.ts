/**
 * The Messaging Router's provider registry — the ONE place that maps a
 * TenantSmsNumber's `provider` to its outbound chat adapter (2026-09-16
 * unified messaging build, Phase 1).
 *
 * This replaces the hardcoded `if (provider === "SIGNALWIRE")` branch that
 * lived inline in connectChatSmsJob.ts:116 — the seam the whole
 * provider-agnostic architecture hangs on. Adding a carrier = adding one
 * entry here + one adapter file; the job never grows another if/else.
 *
 * ⛔ INVARIANTS (source-guarded in messagingDispatch.test.ts):
 *  - Dispatch is decided by the NUMBER's row BEFORE any VoIP.ms concern —
 *    a SignalWire/Telnyx number must never fail VOIPMS_NOT_CONFIGURED.
 *  - VoIP.ms itself is NOT in this registry: its send path (segmenting, the
 *    3-media MMS chunking, the audio→MP4 conversion, link fallback) stays
 *    verbatim in connectChatSmsJob.ts as the registry-miss fallthrough, so
 *    the path carrying most live traffic is byte-identical to before.
 *  - An UNKNOWN provider value falls through to the VoIP.ms path — exactly
 *    the pre-registry behaviour (only SIGNALWIRE ever branched).
 *
 * Adapters use dynamic import so the worker only loads what a number
 * actually uses (the same pattern the inline branch used).
 *
 * FALLBACK CONTRACT: every adapter attaches `__anySent` to any error it
 * throws — true the moment the carrier accepted ANY part of the message.
 * The job's provider-level backup route fires only on `__anySent !== true`;
 * a partial delivery is never duplicated through a second carrier.
 */

export type OutboundChatAdapterInput = {
  msg: {
    id: string;
    threadId: string;
    body: string | null;
    metadata: unknown;
    attachments: Array<{ id: string; storageKey: string; mimeType: string | null; fileName: string | null; sizeBytes: number | null }>;
  };
  tenantId: string;
  to: string;
  from: string;
};

export type OutboundChatAdapter = (input: OutboundChatAdapterInput) => Promise<void>;

/** Providers with a registry adapter. VoIP.ms is deliberately absent — see header. */
export const REGISTERED_CHAT_PROVIDERS = ["SIGNALWIRE", "TELNYX"] as const;

export async function getOutboundChatAdapter(provider: string): Promise<OutboundChatAdapter | null> {
  switch (String(provider || "").toUpperCase()) {
    case "SIGNALWIRE": {
      const { sendConnectChatMessageViaSignalWire } = await import("./signalWireChatSend");
      return (input) => sendConnectChatMessageViaSignalWire(input);
    }
    case "TELNYX": {
      const { sendConnectChatMessageViaTelnyx } = await import("./telnyxChatSend");
      return (input) => sendConnectChatMessageViaTelnyx(input);
    }
    default:
      return null;
  }
}
