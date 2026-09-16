/**
 * Outbound chat SMS/MMS on a TELNYX number — the worker-side dispatch the
 * messaging registry (messagingDispatch.ts) hands `processConnectChatSmsJob`
 * when the thread's TenantSmsNumber row reads `provider: "TELNYX"`. VoIP.ms
 * and SignalWire numbers are untouched — this is the third entry in the same
 * "the system sees whose number it is" switch, never a replacement.
 *
 * Mirrors signalWireChatSend.ts deliberately:
 *  - ⛔ NO convertAudioAttachmentsForMms — Telnyx's media_urls fetch accepts
 *    real audio MIME types, so a voice note ships as the actual audio file.
 *    Removing the conversion IS the feature (the SignalWire rule).
 *  - MMS refused → fall back to SMS with signed HTTPS links so delivery still
 *    succeeds (a text with a link beats a silent failure).
 *  - Nothing is ever RETRIED at the provider — a duplicate text is worse than
 *    a failed one the person can resend.
 *
 * Credentials: the platform-wide AgentSecret row `telnyx_credentials`
 * (AES-256-GCM under CREDENTIALS_MASTER_KEY), written from the API's
 * /apps/telnyx bench (apps/api/src/telnyx/telnyxCredentials.ts). Env
 * TELNYX_API_KEY is a dev fallback only.
 *
 * FALLBACK CONTRACT (unified messaging Phase 1): every thrown error carries
 * `__anySent` — true the moment Telnyx accepted ANY part of this message.
 * The job's provider-level fallback fires ONLY when `__anySent !== true`,
 * so a partial delivery can never be duplicated through a backup carrier.
 * ⛔ TELNYX_NOT_CONFIGURED THROWS (with `__configError = true`) instead of
 * silently stamping failed — the job decides whether a backup route exists;
 * with none it stamps failed without a BullMQ rethrow, matching the
 * not-configured semantics of the other two providers.
 */
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import {
  TELNYX_MMS_MEDIA_PER_MESSAGE,
  TelnyxSmsProvider,
  telnyxBodyChunks,
  type TelnyxSmsCredentials,
} from "@connect/integrations";
import { buildChatAttachmentIdSignedDownloadUrl, buildChatDbSignedDownloadUrl } from "@connect/shared/chatSignedUrl";
import { resolveSmsPublicApiBase } from "./smsPublicApiBase";

/** Same AgentSecret key the API writes — see apps/api/src/telnyx/telnyxCredentials.ts. */
export const TELNYX_SECRET_KEY = "telnyx_credentials";

export async function loadTelnyxCredsWorker(): Promise<TelnyxSmsCredentials | null> {
  try {
    const row = await db.agentSecret.findUnique({ where: { key: TELNYX_SECRET_KEY } });
    if (row?.valueEnc) {
      const stored = decryptJson<{ apiKey?: string }>(row.valueEnc);
      const apiKey = String(stored?.apiKey ?? "").trim();
      if (apiKey) return { apiKey };
    }
  } catch {
    // fall through to env
  }
  const apiKey = String(process.env.TELNYX_API_KEY || "").trim();
  if (apiKey) return { apiKey };
  return null;
}

type ChatMsgRow = {
  id: string;
  threadId: string;
  body: string | null;
  metadata: unknown;
  attachments: Array<{ id: string; storageKey: string; mimeType: string | null; fileName: string | null; sizeBytes: number | null }>;
};

export async function sendConnectChatMessageViaTelnyx(input: {
  msg: ChatMsgRow;
  tenantId: string;
  to: string;
  from: string;
}): Promise<void> {
  const { msg, tenantId, to, from } = input;
  const creds = await loadTelnyxCredsWorker();
  if (!creds) {
    const err: any = new Error("TELNYX_NOT_CONFIGURED");
    err.code = "TELNYX_NOT_CONFIGURED";
    err.__configError = true;
    err.__anySent = false;
    throw err;
  }
  const testMode = (process.env.SMS_PROVIDER_TEST_MODE || "true").toLowerCase() !== "false";
  const provider = new TelnyxSmsProvider(creds, testMode);
  const publicBase = resolveSmsPublicApiBase(process.env);
  const metadata = msg.metadata && typeof msg.metadata === "object" && !Array.isArray(msg.metadata) ? (msg.metadata as Record<string, any>) : {};

  // The fallback contract: flips true on the FIRST provider acceptance and is
  // attached to every error that leaves this function.
  let anySent = false;

  try {
    let r: { providerMessageId?: string } = {};
    const attachments = msg.attachments ?? [];
    if (attachments.length > 0 && !metadata.smsLinkFallback) {
      // Real MMS — the ORIGINAL files, voice notes included. Signed URLs so
      // Telnyx's fetchers can read them; 1h is plenty (they fetch once).
      const mediaUrls = attachments.map((a) => buildChatDbSignedDownloadUrl(publicBase, a.id, a.storageKey, a.sizeBytes ?? 0, 3600));
      const body = telnyxBodyChunks(String(msg.body || ""))[0] ?? "";
      console.info(JSON.stringify({
        event: "telnyx_mms_send",
        tenantId, threadId: msg.threadId, messageId: msg.id,
        mediaCount: mediaUrls.length,
        chunkCount: Math.max(1, Math.ceil(mediaUrls.length / TELNYX_MMS_MEDIA_PER_MESSAGE)),
      }));
      try {
        let last: { providerMessageId?: string } | null = null;
        for (let i = 0; i < mediaUrls.length; i += TELNYX_MMS_MEDIA_PER_MESSAGE) {
          // Body rides the FIRST message only; more than 10 media = extra
          // messages, never dropped attachments (same rule as the VoIP.ms
          // 3-per-message and SignalWire 10-per-message chunking).
          last = await provider.sendMessage({
            tenantId, to, from,
            body: i === 0 ? body : "",
            mediaUrls: mediaUrls.slice(i, i + TELNYX_MMS_MEDIA_PER_MESSAGE),
          });
          anySent = true;
        }
        r = last ?? {};
      } catch (mmsErr: any) {
        console.warn(JSON.stringify({
          event: "telnyx_mms_failed", tenantId, threadId: msg.threadId, messageId: msg.id,
          err: String(mmsErr?.message || mmsErr).slice(0, 300), falling_back: true,
        }));
        // Same fallback direction as the other carriers: signed links as plain
        // SMS, so a carrier MMS refusal still delivers SOMETHING openable.
        const links = attachments.map((a) => buildChatAttachmentIdSignedDownloadUrl(publicBase, a.id, 86_400));
        await db.connectChatMessage.update({
          where: { id: msg.id },
          data: {
            metadata: { ...metadata, smsLinkFallback: true, smsMediaLinks: links, smsMmsFallbackReason: String(mmsErr?.message || mmsErr).slice(0, 500) },
          },
        });
        let lastFallback: { providerMessageId?: string } | null = null;
        const fallbackBodies = [...telnyxBodyChunks(String(msg.body || "")).filter(Boolean), ...links];
        for (const fb of fallbackBodies) {
          lastFallback = await provider.sendMessage({ tenantId, to, from, body: fb });
          anySent = true;
        }
        if (!lastFallback) throw mmsErr;
        r = lastFallback;
      }
    } else {
      let last: { providerMessageId?: string } | null = null;
      for (const chunk of telnyxBodyChunks(String(msg.body || ""))) {
        last = await provider.sendMessage({ tenantId, to, from, body: chunk });
        anySent = true;
      }
      r = last ?? {};
    }
    await db.connectChatMessage.update({
      where: { id: msg.id },
      data: { deliveryStatus: "sent", smsProviderMessageId: r.providerMessageId ?? null, deliveryError: null },
    });
    console.info(JSON.stringify({ event: "telnyx_chat_sent", tenantId, threadId: msg.threadId, messageId: msg.id, providerMessageId: r.providerMessageId ?? null }));
  } catch (e: any) {
    if (e && typeof e === "object" && e.__anySent === undefined) e.__anySent = anySent;
    await db.connectChatMessage.update({
      where: { id: msg.id },
      data: { deliveryStatus: "failed", deliveryError: String(e?.message || e).slice(0, 2000) },
    });
    throw e;
  }
}
