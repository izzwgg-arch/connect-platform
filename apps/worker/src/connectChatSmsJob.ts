import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { VoipMsSmsProvider } from "@connect/integrations";
import { buildChatSignedDownloadUrl } from "@connect/shared";

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
  if (!creds || !cfg?.smsEnabled) {
    await db.connectChatMessage.update({
      where: { id: msg.id },
      data: { deliveryStatus: "failed", deliveryError: "VOIPMS_NOT_CONFIGURED" },
    });
    return;
  }

  const smsRow = await db.tenantSmsNumber.findFirst({ where: { phoneE164: tenantDid, tenantId: data.tenantId } });
  const hasMedia = msg.attachments.length > 0;
  if (hasMedia && (!cfg.mmsEnabled || !smsRow?.mmsCapable)) {
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
    "http://127.0.0.1:3001"
  ).replace(/\/+$/, "");

  const testMode = (process.env.SMS_PROVIDER_TEST_MODE || "true").toLowerCase() !== "false";
  const provider = new VoipMsSmsProvider(
    {
      username: creds.username,
      password: creds.password,
      fromNumber: tenantDid,
      apiBaseUrl: cfg.apiBaseUrl || creds.apiBaseUrl,
    },
    testMode,
  );

  try {
    let r: { providerMessageId?: string };
    if (hasMedia) {
      const mediaUrls = msg.attachments.map((a) => buildChatSignedDownloadUrl(publicBase, a.storageKey, 3600));
      r = await provider.sendMms({
        tenantId: data.tenantId,
        to: ext,
        from: tenantDid,
        body: msg.body || undefined,
        mediaUrls,
      });
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
