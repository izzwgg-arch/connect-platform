import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { VoipMsSmsProvider } from "@connect/integrations";
import { buildChatAttachmentIdSignedDownloadUrl, buildChatDbSignedDownloadUrl } from "@connect/shared/chatSignedUrl";
import { convertAudioAttachmentsForMms } from "./mmsAudioConvert";

type VoipMsStoredCreds = { username: string; password: string; apiBaseUrl?: string };

function bodyWithoutMediaLinks(body: string | null | undefined): string {
  return String(body || "")
    .split(/\r?\n/)
    .filter((line) => !/^Media:\s*https?:\/\//i.test(line.trim()))
    .join("\n")
    .trim();
}

function providerMmsBody(body: string | null | undefined, input: { audioCount: number; mediaCount: number }): string | undefined {
  const cleanBody = bodyWithoutMediaLinks(body);
  if (cleanBody) return cleanBody;
  // Some MMS carrier paths silently drop audio-only MMS with an empty text part,
  // even after VoIP.ms accepts and stores the media.
  if (input.audioCount > 0 && input.audioCount === input.mediaCount) return "Voice note";
  return undefined;
}

function isMmsConvertedVoiceArtifact(attachment: { fileName: string; mimeType: string }): boolean {
  const fileName = String(attachment.fileName || "").toLowerCase();
  const mimeType = String(attachment.mimeType || "").toLowerCase();
  return /^voice-note-.*\.(mp3|wav|mp4)$/.test(fileName) && (
    mimeType === "audio/mpeg" ||
    mimeType === "audio/wav" ||
    mimeType === "video/mp4"
  );
}

function smsSegmentsForBody(body: string | null | undefined): string[] {
  const clean = bodyWithoutMediaLinks(body);
  if (!clean) return [];
  const segments: string[] = [];
  for (let i = 0; i < clean.length; i += 150) {
    const segment = clean.slice(i, i + 150).trim();
    if (segment) segments.push(segment);
  }
  return segments;
}

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
      const sourceAttachments = msg.attachments.filter((a) => !isMmsConvertedVoiceArtifact(a));
      const audioAttachments = sourceAttachments.filter((a) => String(a.mimeType || "").toLowerCase().startsWith("audio/"));
      const nonAudioAttachments = sourceAttachments.filter((a) => !String(a.mimeType || "").toLowerCase().startsWith("audio/"));
      let mmsAttachments = nonAudioAttachments.map((a) => ({ id: a.id, storageKey: a.storageKey, mimeType: a.mimeType, fileName: a.fileName, sizeBytes: a.sizeBytes }));
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
          mmsAttachments = [...mmsAttachments, ...converted.map((a) => ({ id: a.attachmentId, storageKey: a.storageKey, mimeType: a.mimeType, fileName: a.fileName, sizeBytes: a.sizeBytes }))];
        } catch (convertErr: any) {
          console.warn(JSON.stringify({ event: "voipms_audio_convert_failed", tenantId: data.tenantId, threadId: msg.threadId, messageId: msg.id, err: String(convertErr?.message || convertErr).slice(0, 300) }));
          forceFallbackErr = convertErr;
        }
      }
      const mediaUrls = mmsAttachments.map((a) => buildChatDbSignedDownloadUrl(publicBase, a.id, a.storageKey, a.sizeBytes, 3600));
      const providerBody = providerMmsBody(msg.body, {
        audioCount: audioAttachments.length,
        mediaCount: mmsAttachments.length,
      });
      console.info(JSON.stringify({
        event: "voipms_payload_prepared",
        tenantId: data.tenantId,
        threadId: msg.threadId,
        messageId: msg.id,
        mediaCount: mediaUrls.length,
        bodyLength: providerBody?.length ?? 0,
        mediaUrls: mediaUrls.map((u) => u.replace(/([?&]sig=)[^&]+/i, "$1[redacted]")),
      }));
      try {
        if (forceFallbackErr) throw forceFallbackErr;
        r = await provider.sendMms({
          tenantId: data.tenantId,
          to: ext,
          from: tenantDid,
          body: providerBody,
          mediaUrls,
        });
        console.info(JSON.stringify({ event: "voipms_response", ok: true, tenantId: data.tenantId, threadId: msg.threadId, messageId: msg.id, providerMessageId: r.providerMessageId ?? null }));
      } catch (mmsErr: any) {
        console.warn(JSON.stringify({ event: "mms_send_failed", tenantId: data.tenantId, threadId: msg.threadId, messageId: msg.id, err: String(mmsErr?.message || mmsErr).slice(0, 300), falling_back: true }));
        // VoIP.ms often rejects MMS when carrier limits apply or media URLs are not reachable from their servers.
        // Fall back to one or more SMS segments with signed HTTPS links so delivery still succeeds.
        const links = sourceAttachments.map((a) => buildChatAttachmentIdSignedDownloadUrl(publicBase, a.id, 86_400));
        const fallbackMessages = [...smsSegmentsForBody(msg.body), ...links];
        await db.connectChatMessage.update({
          where: { id: msg.id },
          data: {
            metadata: {
              ...metadata,
              smsLinkFallback: true,
              smsMediaLinks: links,
              smsMmsFallbackReason: String(mmsErr?.message || mmsErr).slice(0, 500),
            },
          },
        });
        let fallbackResult: { providerMessageId?: string } | null = null;
        for (const fallbackBody of fallbackMessages) {
          fallbackResult = await provider.sendMessage({
            tenantId: data.tenantId,
            to: ext,
            from: tenantDid,
            body: fallbackBody,
          });
        }
        if (!fallbackResult) throw new Error("MMS_FALLBACK_EMPTY");
        r = fallbackResult;
        console.info(JSON.stringify({ event: "chat_link_fallback_sent", tenantId: data.tenantId, threadId: msg.threadId, messageId: msg.id, mediaCount: links.length, segmentCount: fallbackMessages.length, providerMessageId: r.providerMessageId ?? null }));
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
