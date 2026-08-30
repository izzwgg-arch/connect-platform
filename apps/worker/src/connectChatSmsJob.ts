import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { VoipMsSmsProvider } from "@connect/integrations";
import { buildChatAttachmentIdSignedDownloadUrl, buildChatDbSignedDownloadUrl } from "@connect/shared/chatSignedUrl";
import { splitVoipMsSendSmsParts, voipMsSmsPayloadLogFields } from "@connect/shared";
import { convertAudioAttachmentsForMms } from "./mmsAudioConvert";
import { resolveSmsPublicApiBase } from "./smsPublicApiBase";

type VoipMsStoredCreds = { username: string; password: string; apiBaseUrl?: string };

/**
 * VoIP.ms `sendMMS` accepts media1..media3 — the CARRIER API's parameter
 * surface, not a product cap. A message with more attachments is sent as
 * ceil(n / 3) MMS messages (body on the first one only). ⛔ Never "simplify"
 * back to one send that silently drops the tail — that is how two of a
 * customer's five photos vanished on the INBOUND side (2026-08-30).
 */
export const MMS_MEDIA_PER_MESSAGE = 3;

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
  return splitVoipMsSendSmsParts(clean);
}

async function sendVoipMsSmsParts(
  provider: VoipMsSmsProvider,
  input: { tenantId: string; to: string; from: string; body: string },
  logContext: { threadId: string; messageId: string },
): Promise<{ providerMessageId?: string }> {
  const parts = splitVoipMsSendSmsParts(input.body);
  if (!parts.length) throw new Error("SMS_EMPTY");
  let last: { providerMessageId?: string } = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    console.info(JSON.stringify({
      event: "voipms_sms_part_send",
      tenantId: input.tenantId,
      threadId: logContext.threadId,
      messageId: logContext.messageId,
      partIndex: i + 1,
      partCount: parts.length,
      ...voipMsSmsPayloadLogFields(part),
    }));
    last = await provider.sendMessage({ ...input, body: part });
  }
  return last;
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

  const smsRow = await db.tenantSmsNumber.findFirst({ where: { phoneE164: tenantDid, tenantId: data.tenantId } });

  // ⛔ PROVIDER DISPATCH — decided by the NUMBER's row, before any VoIP.ms
  // concern (credentials included). A SignalWire number must never fail
  // "VOIPMS_NOT_CONFIGURED", and its MMS capability is SignalWire's business,
  // not the VoIP.ms `mmsCapable` sync flag. This is the "system sees it's a
  // SignalWire number, so it uses this" switch (Izzy, 2026-08-29) — VoIP.ms
  // numbers take the unchanged path below.
  if (String((smsRow as any)?.provider || "") === "SIGNALWIRE") {
    const { sendConnectChatMessageViaSignalWire } = await import("./signalWireChatSend");
    await sendConnectChatMessageViaSignalWire({
      msg: { id: msg.id, threadId: msg.threadId, body: msg.body, metadata: msg.metadata, attachments: msg.attachments as any },
      tenantId: data.tenantId,
      to: ext,
      from: tenantDid,
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

  // ⛔ ONE derivation, in smsPublicApiBase.ts, with the bare-origin guard the
  // 2026-08-19 MMS regression earned: `PUBLIC_API_URL` was a pathless origin
  // and every media URL built on it 404'd at VoIP.ms. Never inline this chain
  // again — the guard is what keeps a pathless env value from silently
  // breaking every picture-by-text.
  const publicBase = resolveSmsPublicApiBase(process.env);

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
      // `sourceId` = the ORIGINAL attachment id (a converted voice note maps
      // back to the voice note it was made from) — it is what the link
      // fallback needs to know which attachments were already delivered by a
      // successful MMS chunk before a later chunk failed.
      let mmsAttachments = nonAudioAttachments.map((a) => ({ id: a.id, sourceId: a.id, storageKey: a.storageKey, mimeType: a.mimeType, fileName: a.fileName, sizeBytes: a.sizeBytes }));
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
          mmsAttachments = [...mmsAttachments, ...converted.map((a) => ({ id: a.attachmentId, sourceId: a.convertedFromAttachmentId, storageKey: a.storageKey, mimeType: a.mimeType, fileName: a.fileName, sizeBytes: a.sizeBytes }))];
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
        // ⛔ VoIP.ms `sendMMS` carries at most media1..media3 — that is the
        // CARRIER API's parameter surface, not our cap. More attachments are
        // never dropped (Izzy 2026-08-30: "there shouldn't be a cap"): they
        // ship as additional MMS messages, the body riding the FIRST one only.
        // A failed chunk records how much already went out so the link
        // fallback below covers ONLY the undelivered attachments — a chunk is
        // never re-sent (a duplicate MMS bills and confuses; the rule is the
        // same as "never retry a synthesis POST").
        if (mediaUrls.length === 0) {
          r = await provider.sendMms({ tenantId: data.tenantId, to: ext, from: tenantDid, body: providerBody, mediaUrls: [] });
        } else {
          let last: { providerMessageId?: string } | null = null;
          for (let i = 0; i < mediaUrls.length; i += MMS_MEDIA_PER_MESSAGE) {
            const chunk = mediaUrls.slice(i, i + MMS_MEDIA_PER_MESSAGE);
            try {
              last = await provider.sendMms({
                tenantId: data.tenantId,
                to: ext,
                from: tenantDid,
                body: i === 0 ? providerBody : "",
                mediaUrls: chunk,
              });
            } catch (chunkErr: any) {
              chunkErr.__sentMediaCount = i;
              throw chunkErr;
            }
          }
          r = last!;
        }
        console.info(JSON.stringify({ event: "voipms_response", ok: true, tenantId: data.tenantId, threadId: msg.threadId, messageId: msg.id, mediaCount: mediaUrls.length, chunkCount: Math.max(1, Math.ceil(mediaUrls.length / MMS_MEDIA_PER_MESSAGE)), providerMessageId: r.providerMessageId ?? null }));
      } catch (mmsErr: any) {
        const sentMediaCount = Math.max(0, Number(mmsErr?.__sentMediaCount ?? 0)) || 0;
        console.warn(JSON.stringify({ event: "mms_send_failed", tenantId: data.tenantId, threadId: msg.threadId, messageId: msg.id, sentMediaCount, err: String(mmsErr?.message || mmsErr).slice(0, 300), falling_back: true }));
        // VoIP.ms often rejects MMS when carrier limits apply or media URLs are not reachable from their servers.
        // Fall back to one or more SMS segments with signed HTTPS links so delivery still succeeds.
        // Only for what has NOT already been delivered: attachments covered by
        // a successful earlier chunk are excluded (their sourceIds map converted
        // voice notes back to the original), and the body segments go out only
        // when the first chunk — which carries the body — never left.
        const deliveredSourceIds = new Set(mmsAttachments.slice(0, sentMediaCount).map((a) => a.sourceId));
        const undelivered = sourceAttachments.filter((a) => !deliveredSourceIds.has(a.id));
        const links = undelivered.map((a) => buildChatAttachmentIdSignedDownloadUrl(publicBase, a.id, 86_400));
        const fallbackMessages = [...(sentMediaCount === 0 ? smsSegmentsForBody(msg.body) : []), ...links];
        await db.connectChatMessage.update({
          where: { id: msg.id },
          data: {
            metadata: {
              ...metadata,
              smsLinkFallback: true,
              smsMediaLinks: links,
              smsMmsDeliveredViaMms: sentMediaCount,
              smsMmsFallbackReason: String(mmsErr?.message || mmsErr).slice(0, 500),
            },
          },
        });
        let fallbackResult: { providerMessageId?: string } | null = null;
        for (const fallbackBody of fallbackMessages) {
          fallbackResult = await sendVoipMsSmsParts(
            provider,
            { tenantId: data.tenantId, to: ext, from: tenantDid, body: fallbackBody },
            { threadId: msg.threadId, messageId: msg.id },
          );
        }
        if (!fallbackResult) throw new Error("MMS_FALLBACK_EMPTY");
        r = fallbackResult;
        console.info(JSON.stringify({ event: "chat_link_fallback_sent", tenantId: data.tenantId, threadId: msg.threadId, messageId: msg.id, mediaCount: links.length, segmentCount: fallbackMessages.length, providerMessageId: r.providerMessageId ?? null }));
      }
    } else {
      r = await sendVoipMsSmsParts(
        provider,
        { tenantId: data.tenantId, to: ext, from: tenantDid, body: msg.body || "" },
        { threadId: msg.threadId, messageId: msg.id },
      );
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
