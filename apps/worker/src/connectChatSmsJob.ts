import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { VoipMsSmsProvider } from "@connect/integrations";
import { buildChatSignedDownloadUrl } from "@connect/shared/chatSignedUrl";
import { convertAudioAttachmentsForMms } from "./mmsAudioConvert";

type VoipMsStoredCreds = { username: string; password: string; apiBaseUrl?: string };

async function loadVoipMsCredsWorker(): Promise<VoipMsStoredCreds | null> {
  const row = await db.globalVoipMsConfig.findUnique({ where: { id: "default" } });
  if (!row?.credentialsEncrypted) return null;
  try {
    return decryptJson<VoipMsStoredCreds>(row.credentialsEncrypted);
  } catch {
    return null;
  }
}

export async function processConnectChatSmsJob(data: { connectChatMessageId: string; tenantId: string }): Promise<void> {
  const msg = await db.connectChatMessage.findFirst({
    where: { id: data.connectChatMessageId, tenantId: data.tenantId },
    include: {
      thread: true,
      attachments: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!msg || msg.thread.type !== "SMS" || msg.direction !== "OUTBOUND") return;
  if (msg.deliveryStatus === "sent" && msg.smsProviderMessageId) return;

  const ext = msg.thread.externalSmsE164;
  const tenantDid = msg.thread.tenantSmsE164;
  if (!ext || !tenantDid) {
    await db.connectChatMessage.update({
      where: { id: msg.id },
      data: { deliveryStatus: "failed", deliveryError: "SMS_THREAD_INCOMPLETE" },
    });
    return;
  }

  const cfg = await db.globalVoipMsConfig.findUnique({ where: { id: "default" } });
  const creds = await loadVoipMsCredsWorker();
  if (!creds) {
    await db.connectChatMessage.update({
      where: { id: msg.id },
      data: { deliveryStatus: "failed", deliveryError: "VOIPMS_NOT_CONFIGURED" },
    });
    return;
  }

  const smsRow = await db.tenantSmsNumber.findFirst({ where: { phoneE164: tenantDid, tenantId: data.tenantId } });
  const hasMedia = msg.attachments.length > 0;
  // API marks this when SMS should send signed media links instead of MMS.
  const metadata = msg.metadata && typeof msg.metadata === "object" && !Array.isArray(msg.metadata) ? msg.metadata as Record<string, any> : {};
  const linkFallback = Boolean(metadata.smsLinkFallback);
  // Per-number `mmsCapable` is the real authority for MMS routing. The legacy
  // `cfg.mmsEnabled` flag is only honoured when the assigned DID is also
  // MMS-capable; otherwise we have already routed via `smsLinkFallback`.
  if (hasMedia && !linkFallback && !smsRow?.mmsCapable) {
    await db.connectChatMessage.update({
      where: { id: msg.id },
      data: { deliveryStatus: "failed", deliveryError: "MMS_NOT_AVAILABLE" },
    });
    return;
  }

  const publicBase = (
    process.env.PUBLIC_API_BASE_URL ||
    process.env.API_PUBLIC_URL ||
    process.env.PORTAL_PUBLIC_URL ||
    "https://app.connectcomunications.com/api"
  ).replace(/\/+$/, "");

  const testMode = (process.env.SMS_PROVIDER_TEST_MODE || "true").toLowerCase() !== "false";
  const provider = new VoipMsSmsProvider(
    {
      username: creds.username,
      password: creds.password,
      fromNumber: tenantDid,
      apiBaseUrl: cfg?.apiBaseUrl || creds.apiBaseUrl,
    },
    testMode,
  );

  try {
    let r: { providerMessageId?: string };
    if (hasMedia && !linkFallback) {
      console.info(JSON.stringify({ event: "mms_send_requested", tenantId: data.tenantId, threadId: msg.threadId, messageId: msg.id, mediaCount: msg.attachments.length }));
      const audioAttachments = msg.attachments.filter((a) => String(a.mimeType || "").toLowerCase().startsWith("audio/"));
      const nonAudioAttachments = msg.attachments.filter((a) => !String(a.mimeType || "").toLowerCase().startsWith("audio/"));
      let mmsAttachments = nonAudioAttachments.map((a) => ({ storageKey: a.storageKey, mimeType: a.mimeType, fileName: a.fileName, sizeBytes: a.sizeBytes }));
      let forceFallbackErr: any = null;
      if (audioAttachments.length) {
        try {
          const converted = await convertAudioAttachmentsForMms(
            audioAttachments.map((a) => ({
              id: a.id,
              tenantId: a.tenantId,
              messageId: a.messageId,
              storageKey: a.storageKey,
              mimeType: a.mimeType,
              fileName: a.fileName,
              sizeBytes: a.sizeBytes,
            })),
            msg.threadId,
          );
          for (const item of converted) {
            console.info(JSON.stringify({ event: "voipms_audio_converted", tenantId: data.tenantId, threadId: msg.threadId, messageId: msg.id, fromAttachmentId: item.convertedFromAttachmentId, toBytes: item.sizeBytes, toMime: item.mimeType }));
          }
          mmsAttachments = [...mmsAttachments, ...converted];
        } catch (convertErr: any) {
          console.warn(JSON.stringify({ event: "voipms_audio_convert_failed", tenantId: data.tenantId, threadId: msg.threadId, messageId: msg.id, err: String(convertErr?.message || convertErr).slice(0, 300) }));
          forceFallbackErr = convertErr;
        }
      }
      const mediaUrls = mmsAttachments.map((a) => buildChatSignedDownloadUrl(publicBase, a.storageKey, 3600));
      console.info(JSON.stringify({ event: "voipms_payload_prepared", tenantId: data.tenantId, threadId: msg.threadId, messageId: msg.id, mediaCount: mediaUrls.length, mediaUrls: mediaUrls.map((u) => u.replace(/([?&]sig=)[^&]+/i, "$1[redacted]")) }));
      try {
        if (forceFallbackErr) throw forceFallbackErr;
        r = await provider.sendMms({
          tenantId: data.tenantId,
          to: ext,
          from: tenantDid,
          body: msg.body || undefined,
          mediaUrls,
        });
        console.info(JSON.stringify({ event: "voipms_response", ok: true, tenantId: data.tenantId, threadId: msg.threadId, messageId: msg.id, providerMessageId: r.providerMessageId ?? null }));
      } catch (mmsErr: any) {
        console.warn(JSON.stringify({ event: "mms_send_failed", tenantId: data.tenantId, threadId: msg.threadId, messageId: msg.id, err: String(mmsErr?.message || mmsErr).slice(0, 300), falling_back: true }));
        // VoIP.ms often rejects MMS when carrier limits apply or media URLs are not reachable from their servers.
        // Fall back to one or more SMS segments with signed HTTPS links so delivery still succeeds.
        const links = msg.attachments.map((a) => buildChatSignedDownloadUrl(publicBase, a.storageKey, 86_400));
        const fallbackBody = [String(msg.body || "").trim(), ...links.map((link) => `Media: ${link}`)].filter(Boolean).join("\n");
        await db.connectChatMessage.update({
          where: { id: msg.id },
          data: {
            body: fallbackBody,
            metadata: {
              ...metadata,
              smsLinkFallback: true,
              smsMediaLinks: links,
              smsMmsFallbackReason: String(mmsErr?.message || mmsErr).slice(0, 500),
            },
          },
        });
        r = await provider.sendMessage({
          tenantId: data.tenantId,
          to: ext,
          from: tenantDid,
          body: fallbackBody,
        });
        console.info(JSON.stringify({ event: "chat_link_fallback_sent", tenantId: data.tenantId, threadId: msg.threadId, messageId: msg.id, mediaCount: links.length, providerMessageId: r.providerMessageId ?? null }));
      }
    } else {
      r = await provider.sendMessage({
        tenantId: data.tenantId,
        to: ext,
        from: tenantDid,
        body: msg.body || "",
      });
    }
    await db.connectChatMessage.update({
      where: { id: msg.id },
      data: {
        deliveryStatus: "sent",
        smsProviderMessageId: r.providerMessageId ?? null,
        deliveryError: null,
      },
    });
  } catch (e: any) {
    await db.connectChatMessage.update({
      where: { id: msg.id },
      data: {
        deliveryStatus: "failed",
        deliveryError: String(e?.message || e).slice(0, 2000),
      },
    });
    throw e;
  }
}
