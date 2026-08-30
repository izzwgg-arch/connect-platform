/**
 * Outbound chat SMS/MMS on a SIGNALWIRE number — the worker-side dispatch that
 * `processConnectChatSmsJob` branches into when the thread's TenantSmsNumber
 * row reads `provider: "SIGNALWIRE"`. VoIP.ms numbers are untouched: this is
 * the "the system sees it's a SignalWire number, so it uses this" switch Izzy
 * asked for (2026-08-29), never a replacement of the VoIP.ms path.
 *
 * WHY VOICE NOTES ARE DIFFERENT HERE: the VoIP.ms path must transcode audio
 * attachments to MP4 before MMS (their carrier surface rejects real audio
 * types), so a voice note arrives as a "video". SignalWire's Compatibility API
 * accepts audio MIME types directly — so on a SignalWire number the ORIGINAL
 * audio attachment ships as-is and the recipient gets a real playable voice
 * note. ⛔ Do not add convertAudioAttachmentsForMms to this path; removing the
 * conversion IS the feature.
 *
 * Credentials: the platform-wide AgentSecret row `signalwire_credentials`
 * (AES-256-GCM under CREDENTIALS_MASTER_KEY — the same key this worker already
 * uses for the VoIP.ms credentials), written from the API's /apps/signalwire
 * bench. Env vars are a dev fallback only.
 *
 * Failure directions, deliberately mirroring the VoIP.ms path:
 *  - MMS refused → fall back to SMS with signed HTTPS links so delivery still
 *    succeeds (a text with a link beats a silent failure).
 *  - Nothing is ever RETRIED at the provider — a duplicate text is worse than
 *    a failed one the person can resend.
 */
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import {
  SIGNALWIRE_MMS_MEDIA_PER_MESSAGE,
  SignalWireSmsProvider,
  signalWireBodyChunks,
  type SignalWireSmsCredentials,
} from "@connect/integrations";
import { buildChatAttachmentIdSignedDownloadUrl, buildChatDbSignedDownloadUrl } from "@connect/shared/chatSignedUrl";
import { resolveSmsPublicApiBase } from "./smsPublicApiBase";

/** Same AgentSecret key the API writes — see apps/api/src/signalwire/signalWireCredentials.ts. */
export const SIGNALWIRE_SECRET_KEY = "signalwire_credentials";

export async function loadSignalWireCredsWorker(): Promise<SignalWireSmsCredentials | null> {
  try {
    const row = await db.agentSecret.findUnique({ where: { key: SIGNALWIRE_SECRET_KEY } });
    if (row?.valueEnc) {
      const stored = decryptJson<{ spaceUrl?: string; projectId?: string; apiToken?: string }>(row.valueEnc);
      if (stored?.spaceUrl && stored.projectId && stored.apiToken) {
        return { spaceUrl: stored.spaceUrl, projectId: stored.projectId, apiToken: stored.apiToken };
      }
    }
  } catch {
    // fall through to env
  }
  const spaceUrl = String(process.env.SIGNALWIRE_SPACE_URL || "").trim();
  const projectId = String(process.env.SIGNALWIRE_PROJECT_ID || "").trim();
  const apiToken = String(process.env.SIGNALWIRE_API_TOKEN || "").trim();
  if (spaceUrl && projectId && apiToken) return { spaceUrl, projectId, apiToken };
  return null;
}

type ChatMsgRow = {
  id: string;
  threadId: string;
  body: string | null;
  metadata: unknown;
  attachments: Array<{ id: string; storageKey: string; mimeType: string | null; fileName: string | null; sizeBytes: number | null }>;
};

export async function sendConnectChatMessageViaSignalWire(input: {
  msg: ChatMsgRow;
  tenantId: string;
  to: string;
  from: string;
}): Promise<void> {
  const { msg, tenantId, to, from } = input;
  const creds = await loadSignalWireCredsWorker();
  if (!creds) {
    await db.connectChatMessage.update({
      where: { id: msg.id },
      data: { deliveryStatus: "failed", deliveryError: "SIGNALWIRE_NOT_CONFIGURED" },
    });
    return;
  }
  const testMode = (process.env.SMS_PROVIDER_TEST_MODE || "true").toLowerCase() !== "false";
  const provider = new SignalWireSmsProvider(creds, testMode);
  const publicBase = resolveSmsPublicApiBase(process.env);
  const metadata = msg.metadata && typeof msg.metadata === "object" && !Array.isArray(msg.metadata) ? (msg.metadata as Record<string, any>) : {};

  try {
    let r: { providerMessageId?: string } = {};
    const attachments = msg.attachments ?? [];
    if (attachments.length > 0 && !metadata.smsLinkFallback) {
      // Real MMS — the ORIGINAL files, voice notes included. Signed URLs so
      // SignalWire's fetchers can read them; 1h is plenty (they fetch once).
      const mediaUrls = attachments.map((a) => buildChatDbSignedDownloadUrl(publicBase, a.id, a.storageKey, a.sizeBytes ?? 0, 3600));
      const body = signalWireBodyChunks(String(msg.body || ""))[0] ?? "";
      console.info(JSON.stringify({
        event: "signalwire_mms_send",
        tenantId, threadId: msg.threadId, messageId: msg.id,
        mediaCount: mediaUrls.length,
        chunkCount: Math.max(1, Math.ceil(mediaUrls.length / SIGNALWIRE_MMS_MEDIA_PER_MESSAGE)),
      }));
      try {
        let last: { providerMessageId?: string } | null = null;
        for (let i = 0; i < mediaUrls.length; i += SIGNALWIRE_MMS_MEDIA_PER_MESSAGE) {
          // Body rides the FIRST message only; more than 10 media = extra
          // messages, never dropped attachments (same rule as the VoIP.ms
          // 3-per-message chunking).
          last = await provider.sendMessage({
            tenantId, to, from,
            body: i === 0 ? body : "",
            mediaUrls: mediaUrls.slice(i, i + SIGNALWIRE_MMS_MEDIA_PER_MESSAGE),
          });
        }
        r = last ?? {};
      } catch (mmsErr: any) {
        console.warn(JSON.stringify({
          event: "signalwire_mms_failed", tenantId, threadId: msg.threadId, messageId: msg.id,
          err: String(mmsErr?.message || mmsErr).slice(0, 300), falling_back: true,
        }));
        // Same fallback direction as VoIP.ms: signed links as plain SMS, so a
        // carrier MMS refusal still delivers SOMETHING the person can open.
        const links = attachments.map((a) => buildChatAttachmentIdSignedDownloadUrl(publicBase, a.id, 86_400));
        await db.connectChatMessage.update({
          where: { id: msg.id },
          data: {
            metadata: { ...metadata, smsLinkFallback: true, smsMediaLinks: links, smsMmsFallbackReason: String(mmsErr?.message || mmsErr).slice(0, 500) },
          },
        });
        let lastFallback: { providerMessageId?: string } | null = null;
        const fallbackBodies = [...signalWireBodyChunks(String(msg.body || "")).filter(Boolean), ...links];
        for (const fb of fallbackBodies) {
          lastFallback = await provider.sendMessage({ tenantId, to, from, body: fb });
        }
        if (!lastFallback) throw mmsErr;
        r = lastFallback;
      }
    } else {
      let last: { providerMessageId?: string } | null = null;
      for (const chunk of signalWireBodyChunks(String(msg.body || ""))) {
        last = await provider.sendMessage({ tenantId, to, from, body: chunk });
      }
      r = last ?? {};
    }
    await db.connectChatMessage.update({
      where: { id: msg.id },
      data: { deliveryStatus: "sent", smsProviderMessageId: r.providerMessageId ?? null, deliveryError: null },
    });
    console.info(JSON.stringify({ event: "signalwire_chat_sent", tenantId, threadId: msg.threadId, messageId: msg.id, providerMessageId: r.providerMessageId ?? null }));
  } catch (e: any) {
    await db.connectChatMessage.update({
      where: { id: msg.id },
      data: { deliveryStatus: "failed", deliveryError: String(e?.message || e).slice(0, 2000) },
    });
    throw e;
  }
}
