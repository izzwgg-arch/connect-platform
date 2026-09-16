import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { VoipMsSmsProvider } from "@connect/integrations";
import { buildChatAttachmentIdSignedDownloadUrl, buildChatDbSignedDownloadUrl } from "@connect/shared/chatSignedUrl";
import { splitVoipMsSendSmsParts, voipMsSmsPayloadLogFields } from "@connect/shared";
import { convertAudioAttachmentsForMms } from "./mmsAudioConvert";
import { getOutboundChatAdapter, type OutboundChatAdapterInput } from "./messagingDispatch";
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

async function loadVoipMsCredsWorker(accountId: string = "default"): Promise<VoipMsStoredCreds | null> {
  const row = await db.globalVoipMsConfig.findUnique({ where: { id: accountId } });
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
  // concern (credentials included). A SignalWire/Telnyx number must never fail
  // "VOIPMS_NOT_CONFIGURED", and its MMS capability is that carrier's
  // business, not the VoIP.ms `mmsCapable` sync flag. This is the "system sees
  // whose number it is, so it uses this" switch (Izzy, 2026-08-29), now a
  // REGISTRY (messagingDispatch.ts) instead of an inline if/else — VoIP.ms
  // numbers (and any unknown provider value, exactly as before) take the
  // unchanged path below.
  const primaryProvider = String((smsRow as any)?.provider || "VOIPMS").toUpperCase();
  const fallbackProvider = String((smsRow as any)?.fallbackProvider || "").toUpperCase() || null;
  const adapterInput: OutboundChatAdapterInput = {
    msg: { id: msg.id, threadId: msg.threadId, body: msg.body, metadata: msg.metadata, attachments: msg.attachments as any },
    tenantId: data.tenantId,
    to: ext,
    from: tenantDid,
  };
  const primaryAdapter = await getOutboundChatAdapter(primaryProvider);
  if (primaryAdapter) {
    try {
      await primaryAdapter(adapterInput);
      return;
    } catch (primaryErr: any) {
      const handled = await attemptProviderFallback({
        messageId: msg.id, threadId: msg.threadId, tenantId: data.tenantId,
        primaryProvider, fallbackProvider, primaryErr, to: ext, from: tenantDid,
      });
      if (handled) return;
      if (primaryErr?.__configError) {
        // Not configured and no working backup route: stamp failed WITHOUT a
        // BullMQ rethrow — a missing credential does not fix itself in 12
        // exponential retries (matches the pre-registry not-configured
        // semantics of all three providers).
        await db.connectChatMessage.update({
          where: { id: msg.id },
          data: { deliveryStatus: "failed", deliveryError: String(primaryErr?.code || primaryErr?.message || primaryErr).slice(0, 2000) },
        });
        return;
      }
      throw primaryErr;
    }
  }

  // The number's row says which VoIP.ms ACCOUNT owns it (second-account
  // support, 2026-09-15). A never-synced from-number falls back to the
  // primary "default" row — the exact pre-multi-account behaviour.
  const voipmsAccountId = String((smsRow as any)?.voipmsAccountId || "default");
  const cfg = await db.globalVoipMsConfig.findUnique({ where: { id: voipmsAccountId } });
  const creds = await loadVoipMsCredsWorker(voipmsAccountId);
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
  // Fallback contract: flips true on the FIRST VoIP.ms acceptance. The
  // tracking wrapper is transparent — same calls, same results — it only
  // records that the carrier accepted something, so the provider-level backup
  // route below can never duplicate a partially delivered message.
  const acceptance = { anySent: false };
  const provider = trackVoipMsAcceptance(
    new VoipMsSmsProvider(
      {
        username: creds.username,
        password: creds.password,
        fromNumber: tenantDid,
        apiBaseUrl: cfg?.apiBaseUrl || creds.apiBaseUrl,
      },
      testMode,
    ),
    acceptance,
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
    if (e && typeof e === "object" && e.__anySent === undefined) e.__anySent = acceptance.anySent;
    const handled = await attemptProviderFallback({
      messageId: msg.id, threadId: msg.threadId, tenantId: data.tenantId,
      primaryProvider, fallbackProvider, primaryErr: e, to: ext, from: tenantDid,
    });
    if (handled) return;
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

/** Transparent acceptance tracker for the VoIP.ms provider — see the fallback contract. */
function trackVoipMsAcceptance(p: VoipMsSmsProvider, flag: { anySent: boolean }): VoipMsSmsProvider {
  return {
    sendMessage: async (input: any) => {
      const r = await p.sendMessage(input);
      flag.anySent = true;
      return r;
    },
    sendMms: async (input: any) => {
      const r = await p.sendMms(input);
      flag.anySent = true;
      return r;
    },
  } as unknown as VoipMsSmsProvider;
}

/**
 * Provider-level BACKUP ROUTE (unified messaging Phase 1). Fires ONLY when:
 *  - the number has a `fallbackProvider` configured (null = today's behaviour,
 *    the default for every existing row), and it differs from the primary;
 *  - the primary provably accepted NOTHING (`__anySent !== true` — a partial
 *    delivery is NEVER duplicated through a second carrier; an error that
 *    carries no flag is treated as "may have sent" and is not retried);
 *  - a registry adapter exists for the backup carrier (VOIPMS as a backup
 *    target is deliberately not supported yet — it needs the VoIP.ms path
 *    extracted from the job body; documented in the handoff).
 *
 * On success the message reads `sent` (stamped by the adapter) and the
 * metadata records the route for the message-info drawer — the CUSTOMER-facing
 * copy for this is "sent via backup route"; carrier names surface only on
 * platform-staff screens.
 */
export type ProviderFallbackDeps = {
  getAdapter: typeof getOutboundChatAdapter;
  loadMessage: (messageId: string, tenantId: string) => Promise<{
    id: string; threadId: string; body: string | null; metadata: unknown;
    attachments: Array<{ id: string; storageKey: string; mimeType: string | null; fileName: string | null; sizeBytes: number | null }>;
  } | null>;
  readMetadata: (messageId: string) => Promise<unknown>;
  writeMetadata: (messageId: string, metadata: Record<string, unknown>) => Promise<void>;
};

const defaultFallbackDeps: ProviderFallbackDeps = {
  getAdapter: getOutboundChatAdapter,
  loadMessage: async (messageId, tenantId) => {
    const row = await db.connectChatMessage.findFirst({
      where: { id: messageId, tenantId },
      include: { attachments: { orderBy: { createdAt: "asc" } } },
    });
    return row ? { id: row.id, threadId: row.threadId, body: row.body, metadata: row.metadata, attachments: row.attachments as any } : null;
  },
  readMetadata: async (messageId) => {
    const row = await db.connectChatMessage.findFirst({ where: { id: messageId }, select: { metadata: true } });
    return row?.metadata ?? null;
  },
  writeMetadata: async (messageId, metadata) => {
    await db.connectChatMessage.update({ where: { id: messageId }, data: { metadata: metadata as any } });
  },
};

export async function attemptProviderFallback(input: {
  messageId: string;
  threadId: string;
  tenantId: string;
  primaryProvider: string;
  fallbackProvider: string | null;
  primaryErr: any;
  to: string;
  from: string;
}, deps: ProviderFallbackDeps = defaultFallbackDeps): Promise<boolean> {
  const fb = String(input.fallbackProvider || "").toUpperCase();
  if (!fb || fb === input.primaryProvider) return false;
  // ⛔ Conservative by construction: the backup fires ONLY when the error says
  // `__anySent === false` EXPLICITLY. A flag of true is a partial delivery; a
  // MISSING flag is an error from outside the adapters ("may have sent") and
  // is never retried — a duplicate text is worse than a failed one.
  if (!input.primaryErr || typeof input.primaryErr !== "object" || input.primaryErr.__anySent !== false) return false;
  const adapter = await deps.getAdapter(fb);
  if (!adapter) return false;
  const primaryError = String(input.primaryErr?.code || input.primaryErr?.message || input.primaryErr).slice(0, 300);
  console.warn(JSON.stringify({
    event: "chat_provider_fallback",
    tenantId: input.tenantId, threadId: input.threadId, messageId: input.messageId,
    primaryProvider: input.primaryProvider, backupProvider: fb, primaryError,
  }));
  try {
    // Fresh read: the primary attempt may have rewritten metadata (link
    // fallback flags) or attachments-adjacent state; the backup adapter must
    // see the row as it is NOW, not as the job first loaded it.
    const fresh = await deps.loadMessage(input.messageId, input.tenantId);
    if (!fresh) return false;
    await adapter({
      msg: fresh,
      tenantId: input.tenantId,
      to: input.to,
      from: input.from,
    });
    const postMeta = await deps.readMetadata(input.messageId);
    const meta = postMeta && typeof postMeta === "object" && !Array.isArray(postMeta) ? (postMeta as Record<string, any>) : {};
    await deps.writeMetadata(input.messageId, {
      ...meta,
      sentViaBackupRoute: true,
      backupCarrier: fb,
      primaryCarrier: input.primaryProvider,
      primaryError,
    });
    console.info(JSON.stringify({
      event: "chat_provider_fallback_sent",
      tenantId: input.tenantId, threadId: input.threadId, messageId: input.messageId,
      backupProvider: fb,
    }));
    return true;
  } catch (fbErr: any) {
    console.warn(JSON.stringify({
      event: "chat_provider_fallback_failed",
      tenantId: input.tenantId, threadId: input.threadId, messageId: input.messageId,
      backupProvider: fb, err: String(fbErr?.message || fbErr).slice(0, 300),
    }));
    return false;
  }
}
