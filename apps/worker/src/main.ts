import { randomUUID } from "crypto";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import {
  normalizeProviderError,
  SmsProvider,
  TwilioCredentials,
  TwilioSmsProvider,
  VoipMsCredentials,
  VoipMsSmsProvider,
  SolaCardknoxAdapter,
  WirePbxClient,
  VitalPbxClient,
} from "@connect/integrations";
import { processConnectChatSmsJob } from "./connectChatSmsJob";

const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const smsQueue = new Queue("sms-send", { connection: redis });

const providerCache = new Map<string, { provider: SmsProvider; expiresAt: number }>();
const providerCacheTtlMs = 60_000;
const smsProviderTestMode = (process.env.SMS_PROVIDER_TEST_MODE || "true").toLowerCase() !== "false";
const mobilePushSimulate = (process.env.MOBILE_PUSH_SIMULATE || "false").toLowerCase() === "true";
const expoPushAccessToken = process.env.EXPO_PUSH_ACCESS_TOKEN || "";
const tokenBuckets = new Map<string, { tokens: number; lastRefillMs: number }>();
const pbxPollCursorByInstance = new Map<string, string>();
const pbxPollSeenCalls = new Map<string, number>();
const pbxPollBackoffUntil = new Map<string, number>();

type ProviderName = "TWILIO" | "VOIPMS";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function providerCacheKey(tenantId: string, provider: ProviderName): string {
  return `${tenantId}:${provider}`;
}

function bucketStart5m(now = new Date()): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5);
  return d;
}

async function getProviderClient(tenantId: string, provider: ProviderName): Promise<SmsProvider | null> {
  const key = providerCacheKey(tenantId, provider);
  const cached = providerCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.provider;

  const credential = await db.providerCredential.findUnique({ where: { tenantId_provider: { tenantId, provider } } });
  if (!credential || !credential.isEnabled) return null;

  try {
    if (provider === "TWILIO") {
      const decrypted = decryptJson<TwilioCredentials>(credential.credentialsEncrypted);
      if (!decrypted.accountSid || !decrypted.authToken || (!decrypted.messagingServiceSid && !decrypted.fromNumber)) return null;
      const client = new TwilioSmsProvider(decrypted, smsProviderTestMode);
      providerCache.set(key, { provider: client, expiresAt: Date.now() + providerCacheTtlMs });
      return client;
    }

    const decrypted = decryptJson<VoipMsCredentials>(credential.credentialsEncrypted);
    if (!decrypted.username || !decrypted.password || !decrypted.fromNumber) return null;
    const client = new VoipMsSmsProvider(decrypted, smsProviderTestMode);
    providerCache.set(key, { provider: client, expiresAt: Date.now() + providerCacheTtlMs });
    return client;
  } catch {
    return null;
  }
}

async function enforcePerSecondTokenBucket(tenantId: string, perSecondRateLimit: number) {
  const now = Date.now();
  const rate = Math.max(1, Math.min(20, perSecondRateLimit));
  const bucket = tokenBuckets.get(tenantId) || { tokens: rate, lastRefillMs: now };

  const elapsedSec = (now - bucket.lastRefillMs) / 1000;
  bucket.tokens = Math.min(rate, bucket.tokens + elapsedSec * rate);
  bucket.lastRefillMs = now;

  if (bucket.tokens < 1) {
    const waitMs = Math.ceil(((1 - bucket.tokens) / rate) * 1000);
    tokenBuckets.set(tenantId, bucket);
    await sleep(waitMs);
    return enforcePerSecondTokenBucket(tenantId, rate);
  }

  bucket.tokens -= 1;
  tokenBuckets.set(tenantId, bucket);
}

async function countDaily(tenantId: string): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return db.smsMessage.count({ where: { campaign: { tenantId }, status: { not: "FAILED" }, createdAt: { gte: start } } });
}

async function countHourly(tenantId: string): Promise<number> {
  const start = new Date(Date.now() - 60 * 60 * 1000);
  return db.smsMessage.count({ where: { campaign: { tenantId }, status: { not: "FAILED" }, createdAt: { gte: start } } });
}

async function shouldAutoSuspendForFailureRate(tenantId: string): Promise<boolean> {
  const start = new Date(Date.now() - 15 * 60 * 1000);
  const recent = await db.smsMessage.findMany({
    where: {
      campaign: { tenantId },
      OR: [{ createdAt: { gte: start } }, { lastProviderUpdateAt: { gte: start } }]
    },
    select: { status: true, providerStatus: true }
  });

  if (recent.length === 0) return false;
  let failed = 0;
  let total = 0;
  for (const msg of recent) {
    if (msg.status === "QUEUED") continue;
    total += 1;
    if (msg.status === "FAILED" || (msg.providerStatus || "").toLowerCase() === "undelivered") failed += 1;
  }
  if (total === 0) return false;
  return failed > 30 && failed / total > 0.4;
}

async function suspendTenant(tenantId: string, reason: string, actorEntityId: string) {
  await db.tenant.update({ where: { id: tenantId }, data: { smsSuspended: true, smsSuspendedReason: reason, smsSuspendedAt: new Date() } });
  await db.auditLog.create({ data: { tenantId, action: "SMS_TENANT_SUSPENDED", entityType: "Tenant", entityId: actorEntityId } });
}

async function finalizeCampaignStatus(campaignId: string) {
  const remaining = await db.smsMessage.count({ where: { campaignId, status: { in: ["QUEUED", "SENDING"] } } });
  if (remaining > 0) return;
  const failedCount = await db.smsMessage.count({ where: { campaignId, status: "FAILED" } });
  const nextStatus = failedCount > 0 ? "FAILED" : "SENT";
  await db.smsCampaign.update({ where: { id: campaignId }, data: { status: nextStatus } });
}

async function getCircuitOpenUntil(tenantId: string, provider: ProviderName): Promise<Date | null> {
  const row = await db.providerHealth.findFirst({ where: { tenantId, provider }, orderBy: { updatedAt: "desc" } });
  if (!row?.circuitOpenUntil) return null;
  if (row.circuitOpenUntil > new Date()) return row.circuitOpenUntil;

  await db.providerHealth.update({ where: { id: row.id }, data: { circuitOpenUntil: null } });
  await db.auditLog.create({ data: { tenantId, action: "SMS_PROVIDER_CIRCUIT_CLOSED", entityType: "ProviderHealth", entityId: row.id, provider } });
  return null;
}

async function recordProviderHealth(tenantId: string, provider: ProviderName, success: boolean, errorCode?: string): Promise<void> {
  const windowStart = bucketStart5m();
  const row = await db.providerHealth.upsert({
    where: { tenantId_provider_windowStart: { tenantId, provider, windowStart } },
    create: {
      tenantId,
      provider,
      windowStart,
      sentCount: success ? 1 : 0,
      failCount: success ? 0 : 1,
      lastErrorCode: success ? null : errorCode || null,
      lastErrorAt: success ? null : new Date()
    },
    update: {
      sentCount: success ? { increment: 1 } : undefined,
      failCount: success ? undefined : { increment: 1 },
      lastErrorCode: success ? undefined : errorCode || null,
      lastErrorAt: success ? undefined : new Date()
    }
  });

  const total = row.sentCount + row.failCount;
  const failRate = total > 0 ? row.failCount / total : 0;
  if (row.failCount >= 20 && failRate >= 0.4) {
    const openUntil = new Date(Date.now() + 15 * 60 * 1000);
    await db.providerHealth.update({ where: { id: row.id }, data: { circuitOpenUntil: openUntil } });
    await db.auditLog.create({ data: { tenantId, action: "SMS_PROVIDER_CIRCUIT_OPENED", entityType: "ProviderHealth", entityId: row.id, provider } });
  }
}

async function resolveSenderNumber(msg: any, tenantId: string): Promise<any | null> {
  if (msg.fromNumberId) {
    return db.phoneNumber.findFirst({ where: { id: msg.fromNumberId, tenantId, status: "ACTIVE" } });
  }
  return db.phoneNumber.findFirst({ where: { tenantId, phoneNumber: msg.fromNumber, status: "ACTIVE" } });
}

function buildRoutingAttemptOrder(tenant: any): Array<{ provider: ProviderName; route: "PRIMARY" | "SECONDARY" | "LOCKED" }> {
  if (tenant.smsProviderLock) {
    return [{ provider: tenant.smsProviderLock as ProviderName, route: "LOCKED" }];
  }
  if (tenant.smsRoutingMode === "SINGLE_PRIMARY") {
    return [{ provider: tenant.smsPrimaryProvider as ProviderName, route: "PRIMARY" }];
  }

  const out: Array<{ provider: ProviderName; route: "PRIMARY" | "SECONDARY" | "LOCKED" }> = [];
  out.push({ provider: tenant.smsPrimaryProvider as ProviderName, route: "PRIMARY" });
  if (tenant.smsSecondaryProvider && tenant.smsSecondaryProvider !== tenant.smsPrimaryProvider) {
    out.push({ provider: tenant.smsSecondaryProvider as ProviderName, route: "SECONDARY" });
  }
  return out;
}


function getSolaAdapter() {
  return new SolaCardknoxAdapter({
    baseUrl: process.env.SOLA_CARDKNOX_API_BASE_URL,
    apiKey: process.env.SOLA_CARDKNOX_API_KEY,
    apiSecret: process.env.SOLA_CARDKNOX_API_SECRET,
    webhookSecret: process.env.SOLA_CARDKNOX_WEBHOOK_SECRET,
    mode: (process.env.SOLA_CARDKNOX_MODE as "sandbox" | "prod" | undefined) || "sandbox",
    simulate: (process.env.SOLA_CARDKNOX_SIMULATE || "false").toLowerCase() === "true",
    chargePath: process.env.SOLA_CARDKNOX_CHARGE_PATH || "/subscriptions/charge"
  });
}

async function runDunningCycle(): Promise<void> {
  const now = new Date();
  const dueSubs = await db.subscription.findMany({ where: { status: "PAST_DUE", nextRetryAt: { lte: now } } });
  for (const sub of dueSubs) {
    const tenant = await db.tenant.findUnique({ where: { id: sub.tenantId } });
    if (!tenant) continue;

    const pastDueSince = sub.pastDueSince || sub.updatedAt;
    const ageMs = now.getTime() - pastDueSince.getTime();
    if (ageMs >= 7 * 24 * 60 * 60 * 1000) {
      await db.subscription.update({ where: { id: sub.id }, data: { status: "CANCELED", nextRetryAt: null } });
      await db.tenant.update({ where: { id: sub.tenantId }, data: { smsSuspended: true, smsSuspendedReason: "BILLING_PAST_DUE", smsSuspendedAt: now } });
      await db.auditLog.create({ data: { tenantId: sub.tenantId, action: "BILLING_SUBSCRIPTION_CANCELED_FOR_NONPAYMENT", entityType: "Subscription", entityId: sub.id } });
      continue;
    }

    if (!sub.providerSubscriptionId) continue;
    const adapter = getSolaAdapter();
    try {
      const charged = await adapter.chargeSubscription(sub.providerSubscriptionId, sub.priceCents || 1000);
      if (charged.status === "SUCCEEDED") {
        const periodStart = new Date();
        const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const amount = charged.amountCents || sub.priceCents || 1000;
        await db.subscription.update({ where: { id: sub.id }, data: { status: "ACTIVE", lastPaymentStatus: "SUCCEEDED", lastPaymentAt: periodStart, lastFailureReason: null, currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, retryCount: 0, nextRetryAt: null, pastDueSince: null } });
        await db.usageLedger.create({ data: { tenantId: sub.tenantId, type: "SMS_SUBSCRIPTION_MONTHLY", quantity: 1, unitPriceCents: amount, totalCents: amount, referenceId: sub.id } });
        await db.receipt.create({ data: { tenantId: sub.tenantId, subscriptionId: sub.id, amountCents: amount, periodStart, periodEnd } });
        await db.tenant.update({ where: { id: sub.tenantId }, data: { smsSuspended: false, smsSuspendedReason: null, smsSuspendedAt: null } });
        await db.auditLog.create({ data: { tenantId: sub.tenantId, action: "SMS_TENANT_UNSUSPENDED", entityType: "Tenant", entityId: sub.tenantId } });
      } else {
        throw new Error("charge_failed");
      }
    } catch {
      const nextCount = (sub.retryCount || 0) + 1;
      const retryDays = nextCount === 1 ? 1 : nextCount === 2 ? 3 : 5;
      const nextRetryAt = new Date(now.getTime() + retryDays * 24 * 60 * 60 * 1000);
      await db.subscription.update({ where: { id: sub.id }, data: { retryCount: nextCount, nextRetryAt, lastFailureReason: "dunning_retry_failed" } });
    }
  }
}



function getPbxClient(input: { baseUrl: string; token: string; secret?: string | null }) {
  return new WirePbxClient({
    baseUrl: input.baseUrl,
    apiToken: input.token,
    apiSecret: input.secret || undefined,
    timeoutMs: Number(process.env.PBX_TIMEOUT_MS || 10000),
    simulate: (process.env.PBX_SIMULATE || "false").toLowerCase() === "true",
    activeCallsPath: process.env.PBX_ACTIVE_CALLS_PATH,
    supportsWebhooks: process.env.PBX_SUPPORTS_WEBHOOKS ? process.env.PBX_SUPPORTS_WEBHOOKS.toLowerCase() === "true" : undefined,
    supportsActiveCallPolling: process.env.PBX_SUPPORTS_ACTIVE_CALL_POLLING ? process.env.PBX_SUPPORTS_ACTIVE_CALL_POLLING.toLowerCase() === "true" : undefined
  });
}

type WorkerMobilePushPayload =
  | { type: "INCOMING_CALL"; inviteId: string; fromNumber: string; toExtension: string; tenantId: string; timestamp: string }
  | { type: "INVITE_CANCELED"; inviteId: string; pbxCallId?: string | null; reason?: string | null; tenantId: string; timestamp: string }
  | { type: "MISSED_CALL"; inviteId: string; fromNumber: string; toExtension: string; tenantId: string; timestamp: string };

async function sendPushToUserDevices(input: {
  tenantId: string;
  userId: string;
  payload: WorkerMobilePushPayload;
}) {
  const devices = await db.mobileDevice.findMany({ where: { tenantId: input.tenantId, userId: input.userId } });
  if (!devices.length) return { queued: 0, simulated: mobilePushSimulate };

  if (mobilePushSimulate) {
    await db.auditLog.create({
      data: {
        tenantId: input.tenantId,
        action: "MOBILE_PUSH_SIMULATED",
        entityType: "CallInvite",
        entityId: input.payload.inviteId,
        actorUserId: input.userId
      }
    });
    return { queued: devices.length, simulated: true };
  }

  // CRITICAL: All call-control pushes (INCOMING_CALL, INVITE_CANCELED,
  // MISSED_CALL) MUST wake the native FirebaseMessagingService on cold-killed
  // apps so we can stop the ringtone started by INCOMING_CALL. When the push
  // includes `title`/`body`/`sound`/`channelId`, Expo produces an FCM
  // "notification message" which Android's FCM SDK displays directly WITHOUT
  // invoking onMessageReceived â€” so our handleCallTerminationNative never runs
  // and the ringtone keeps playing until the 45s native watchdog fires.
  //
  // All FCM data values MUST be strings (Firebase spec). Expo silently
  // promotes the push to a notification message if values fail to serialize,
  // so we stringify every field explicitly.
  const stringifiedData: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.payload)) {
    if (v === undefined || v === null) continue;
    stringifiedData[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  const messages = devices.map((d) => ({
    to: d.expoPushToken,
    priority: "high" as const,
    ttl: 45,
    data: stringifiedData,
  }));

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (expoPushAccessToken) headers.authorization = `Bearer ${expoPushAccessToken}`;

  console.info(
    "[CALL_TIMELINE]",
    JSON.stringify({
      callTimeline: true,
      stage: "PUSH_SEND",
      ts: new Date().toISOString(),
      source: "worker",
      tenantId: input.tenantId,
      userId: input.userId,
      inviteId: input.payload.inviteId,
      payloadType: input.payload.type,
      deviceCount: messages.length,
      toExtension: input.payload.type === "INCOMING_CALL" ? input.payload.toExtension : null
    })
  );

  try {
    const expoRes = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers,
      body: JSON.stringify(messages)
    });
    const expoBody = await expoRes.json().catch(() => null);
    console.info(
      "[CALL_TIMELINE]",
      JSON.stringify({
        callTimeline: true,
        stage: "PUSH_EXPO_RESPONSE",
        ts: new Date().toISOString(),
        source: "worker",
        inviteId: input.payload.inviteId,
        payloadType: input.payload.type,
        expoStatus: expoRes.status,
        expoBody,
        requestSample: messages[0]
      })
    );
  } catch (err: any) {
    console.error("[CALL_TIMELINE] push send failed", err?.message || err);
  }

  await db.auditLog.create({
    data: {
      tenantId: input.tenantId,
      action: "MOBILE_PUSH_SENT",
      entityType: "CallInvite",
      entityId: input.payload.inviteId,
      actorUserId: input.userId
    }
  });

  return { queued: messages.length, simulated: false };
}

function normalizePbxCallState(v: string): "RINGING" | "ANSWERED" | "HANGUP" | "CANCELED" | "UNKNOWN" {
  const x = String(v || "").toLowerCase();
  if (x.includes("ring")) return "RINGING";
  if (x.includes("answer")) return "ANSWERED";
  if (x.includes("cancel") || x.includes("abandon")) return "CANCELED";
  if (x.includes("hang") || x.includes("end") || x.includes("term")) return "HANGUP";
  return "UNKNOWN";
}

async function createMissedCallRecordForInvite(invite: any, disposition: "MISSED" | "CANCELED") {
  if (!invite?.pbxCallId) return;

  // Legacy table write (kept for backward-compat with any existing queries on callRecord).
  await db.callRecord.upsert({
    where: { tenantId_pbxCallId: { tenantId: invite.tenantId, pbxCallId: invite.pbxCallId } },
    create: {
      tenantId: invite.tenantId,
      pbxCallId: invite.pbxCallId,
      direction: "INBOUND",
      fromNumber: invite.fromNumber,
      toNumber: invite.toExtension,
      startedAt: invite.createdAt || new Date(),
      durationSec: 0,
      disposition,
    },
    update: { disposition },
  }).catch((e: any) => {
    console.warn("[worker] callRecord upsert failed for missed invite", invite.pbxCallId, e?.message);
  });

  // Authoritative table write: ensure missed/canceled calls also appear in connectCdr
  // so they are counted by the dashboard KPI endpoint (which only reads connectCdr).
  // Uses pbxCallId as the linkedId â€” matches what the telephony service would use if
  // the AMI CDR event fires, so this is an idempotent upsert (no duplicate if both paths run).
  const now = new Date();
  const startedAt = invite.createdAt ? new Date(invite.createdAt) : now;
  await db.connectCdr.upsert({
    where: { linkedId: String(invite.pbxCallId) },
    create: {
      linkedId:    String(invite.pbxCallId),
      tenantId:    invite.tenantId ?? null,
      fromNumber:  invite.fromNumber ?? null,
      fromName:    invite.callerName ?? null,
      toNumber:    invite.toExtension ?? null,
      direction:   "incoming",
      disposition: disposition === "MISSED" ? "missed" : "canceled",
      startedAt,
      answeredAt:  null,
      endedAt:     now,
      durationSec: 0,
      talkSec:     0,
      rawLegCount: 1,
    },
    update: {
      // Only update disposition if it gets more specific (missed > canceled).
      disposition: disposition === "MISSED" ? "missed" : undefined,
    },
  }).catch((e: any) => {
    console.warn("[worker] connectCdr upsert failed for missed invite", invite.pbxCallId, e?.message);
  });
}

async function processPolledCall(link: any, call: { callId: string; state: string; from: string; toExtension: string; tenantHint?: string; startedAt: string }) {
  const state = normalizePbxCallState(call.state);
  if (call.tenantHint && link.pbxTenantId && String(call.tenantHint) !== String(link.pbxTenantId)) return;

  const ext = await db.extension.findFirst({
    where: { tenantId: link.tenantId, extNumber: String(call.toExtension), status: "ACTIVE", ownerUserId: { not: null } }
  });
  if (!ext?.ownerUserId) return;

  const dedupKey = `${link.tenantId}:${call.callId}`;
  const nowMs = Date.now();
  for (const [k, ts] of pbxPollSeenCalls) {
    if (nowMs - ts > 10 * 60 * 1000) pbxPollSeenCalls.delete(k);
  }

  if (state === "RINGING") {
    if (pbxPollSeenCalls.has(dedupKey)) return;
    pbxPollSeenCalls.set(dedupKey, nowMs);

    const existing = await db.callInvite.findFirst({ where: { tenantId: link.tenantId, pbxCallId: call.callId }, orderBy: { createdAt: "desc" } });
    if (existing && existing.status === "PENDING" && existing.expiresAt > new Date()) return;

    const invite = existing
      ? await db.callInvite.update({
          where: { id: existing.id },
          data: {
            userId: ext.ownerUserId,
            extensionId: ext.id,
            fromNumber: call.from || "unknown",
            toExtension: String(call.toExtension),
            status: "PENDING",
            expiresAt: new Date(Date.now() + 45_000),
            acceptedAt: null,
            declinedAt: null,
            canceledAt: null
          }
        })
      : await db.callInvite.create({
          data: {
            tenantId: link.tenantId,
            userId: ext.ownerUserId,
            extensionId: ext.id,
            pbxCallId: call.callId,
            fromNumber: call.from || "unknown",
            toExtension: String(call.toExtension),
            status: "PENDING",
            expiresAt: new Date(Date.now() + 45_000)
          }
        });

    await sendPushToUserDevices({
      tenantId: link.tenantId,
      userId: ext.ownerUserId,
      payload: {
        type: "INCOMING_CALL",
        inviteId: invite.id,
        fromNumber: invite.fromNumber,
        toExtension: invite.toExtension,
        tenantId: link.tenantId,
        timestamp: new Date().toISOString()
      }
    });

    await db.auditLog.create({ data: { tenantId: link.tenantId, action: "PBX_CALL_INVITE_POLL", entityType: "CallInvite", entityId: invite.id, actorUserId: ext.ownerUserId } });
    return;
  }

  if (state === "ANSWERED" || state === "HANGUP" || state === "CANCELED") {
    const invite = await db.callInvite.findFirst({ where: { tenantId: link.tenantId, pbxCallId: call.callId }, orderBy: { createdAt: "desc" } });
    if (!invite || invite.status !== "PENDING") return;
    if (state === "ANSWERED") {
      await db.callInvite.update({ where: { id: invite.id }, data: { status: "ACCEPTED", acceptedAt: invite.acceptedAt || new Date() } });
      await db.auditLog.create({ data: { tenantId: link.tenantId, action: "CALL_INVITE_ACCEPTED_BY_PBX", entityType: "CallInvite", entityId: invite.id } });
      return;
    }
    const now = new Date();
    const nextStatus = invite.expiresAt < now ? "EXPIRED" : "CANCELED";
    await db.callInvite.update({ where: { id: invite.id }, data: { status: nextStatus, canceledAt: now } });
    await db.auditLog.create({ data: { tenantId: link.tenantId, action: "CALL_INVITE_CANCELED_BY_PBX", entityType: "CallInvite", entityId: invite.id } });
    if (nextStatus === "EXPIRED") {
      await createMissedCallRecordForInvite(invite, "MISSED").catch(() => undefined);
    } else {
      await createMissedCallRecordForInvite(invite, "CANCELED").catch(() => undefined);
      await sendPushToUserDevices({
        tenantId: invite.tenantId,
        userId: invite.userId,
        payload: {
          type: "INVITE_CANCELED",
          inviteId: invite.id,
          pbxCallId: invite.pbxCallId,
          reason: state,
          tenantId: invite.tenantId,
          timestamp: new Date().toISOString()
        }
      }).catch(() => undefined);
    }
  }
}

async function runPbxActiveCallPollCycle(): Promise<void> {
  const links: any[] = await db.tenantPbxLink.findMany({
    where: { status: "LINKED" },
    include: { pbxInstance: { include: { webhookRegistration: true } } }
  } as any);

  for (const link of links) {
    try {
      if (!link?.pbxInstance?.isEnabled) continue;
      const reg = link.pbxInstance.webhookRegistration;
      if (reg && reg.status === "REGISTERED") continue;

      const now = Date.now();
      const blockedUntil = pbxPollBackoffUntil.get(link.pbxInstanceId) || 0;
      if (blockedUntil > now) continue;

      const auth = decryptJson<{ token: string; secret?: string | null }>(link.pbxInstance.apiAuthEncrypted);
      const pbx = getPbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret || null });
      const caps = pbx.capabilities();
      if (!caps.supportsActiveCallPolling) continue;

      const cursor = pbxPollCursorByInstance.get(link.pbxInstanceId);
      const calls = await pbx.pollActiveCalls(cursor);
      for (const call of calls) {
        await processPolledCall(link, call);
      }
      if (calls.length > 0) {
        pbxPollCursorByInstance.set(link.pbxInstanceId, calls[calls.length - 1].callId);
      }
    } catch (e: any) {
      const curr = pbxPollBackoffUntil.get(link.pbxInstanceId) || Date.now();
      const next = Math.min(Date.now() + 60_000, curr + 10_000);
      pbxPollBackoffUntil.set(link.pbxInstanceId, next);
      await db.auditLog.create({ data: { tenantId: link.tenantId, action: "PBX_ACTIVE_CALL_POLL_FAILED", entityType: "PbxInstance", entityId: link.pbxInstanceId } });
    }
  }
}

async function runPbxJobCycle(): Promise<void> {
  const jobs = await db.pbxJob.findMany({ where: { status: { in: ["QUEUED", "FAILED"] }, nextRunAt: { lte: new Date() } }, orderBy: { createdAt: "asc" }, take: 20 });
  for (const job of jobs) {
    try {
      await db.pbxJob.update({ where: { id: job.id }, data: { status: "RUNNING", attempts: { increment: 1 } } });

      const tenantLink: any = await db.tenantPbxLink.findUnique({ where: { tenantId: job.tenantId }, include: { pbxInstance: true } as any });
      if (!tenantLink || tenantLink.status !== "LINKED" || !tenantLink.pbxInstance.isEnabled) {
        throw new Error("PBX_NOT_LINKED");
      }

      const auth = decryptJson<{ token: string; secret?: string | null }>(tenantLink.pbxInstance.apiAuthEncrypted);
      const pbx = getPbxClient({ baseUrl: tenantLink.pbxInstance.baseUrl, token: auth.token, secret: auth.secret || null });

      if (job.type === "CREATE_EXTENSION") {
        const payload = job.payload as any;
        const created = await pbx.createExtension({ pbxTenantId: tenantLink.pbxTenantId || undefined, extensionNumber: String(payload.extensionNumber), displayName: String(payload.displayName) });
        const dev = await pbx.createSipDevice({ pbxExtensionId: created.pbxExtensionId, enableWebrtc: !!payload.enableWebrtc, enableMobile: !!payload.enableMobile });
        await db.pbxExtensionLink.upsert({
          where: { tenantId_extensionId: { tenantId: job.tenantId, extensionId: String(payload.extensionId) } },
          create: {
            tenantId: job.tenantId,
            extensionId: String(payload.extensionId),
            pbxExtensionId: created.pbxExtensionId,
            pbxSipUsername: dev.sipUsername || created.sipUsername,
            pbxDeviceId: dev.pbxDeviceId || null,
            isSuspended: false
          },
          update: {
            pbxExtensionId: created.pbxExtensionId,
            pbxSipUsername: dev.sipUsername || created.sipUsername,
            pbxDeviceId: dev.pbxDeviceId || null,
            isSuspended: false
          }
        });
      }

      if (job.type === "SUSPEND_EXTENSION") {
        const payload = job.payload as any;
        await pbx.suspendExtension(String(payload.pbxExtensionId), true);
        if (payload.pbxExtensionLinkId) await db.pbxExtensionLink.update({ where: { id: String(payload.pbxExtensionLinkId) }, data: { isSuspended: true } });
      }

      if (job.type === "UNSUSPEND_EXTENSION") {
        const payload = job.payload as any;
        await pbx.suspendExtension(String(payload.pbxExtensionId), false);
        if (payload.pbxExtensionLinkId) await db.pbxExtensionLink.update({ where: { id: String(payload.pbxExtensionLinkId) }, data: { isSuspended: false } });
      }

      if (job.type === "ASSIGN_DID") {
        const payload = job.payload as any;
        const number = await db.phoneNumber.findFirst({ where: { id: String(payload.phoneNumberId), tenantId: job.tenantId } });
        if (!number) throw new Error("NUMBER_NOT_FOUND");
        const did = await pbx.createDidRoute({ pbxTenantId: tenantLink.pbxTenantId || undefined, did: number.phoneNumber, routeType: String(payload.routeType), routeTarget: String(payload.routeTarget) });
        await db.pbxDidLink.upsert({
          where: { tenantId_phoneNumberId: { tenantId: job.tenantId, phoneNumberId: number.id } },
          create: { tenantId: job.tenantId, phoneNumberId: number.id, pbxDidId: did.pbxDidId, routeType: String(payload.routeType) as any, routeTarget: String(payload.routeTarget) },
          update: { pbxDidId: did.pbxDidId, routeType: String(payload.routeType) as any, routeTarget: String(payload.routeTarget) }
        });
      }

      await db.pbxJob.update({ where: { id: job.id }, data: { status: "COMPLETED", lastError: null } });
      await db.tenantPbxLink.update({ where: { id: tenantLink.id }, data: { status: "LINKED", lastError: null, lastSyncAt: new Date() } });
      await db.auditLog.create({ data: { tenantId: job.tenantId, action: "PBX_JOB_COMPLETED", entityType: "PbxJob", entityId: job.id } });
    } catch (e: any) {
      const attempts = (job.attempts || 0) + 1;
      const backoffMinutes = Math.min(60, 2 ** Math.min(6, attempts));
      await db.pbxJob.update({ where: { id: job.id }, data: { status: "FAILED", lastError: String(e?.message || "PBX_JOB_FAILED"), nextRunAt: new Date(Date.now() + backoffMinutes * 60 * 1000) } });
      await db.auditLog.create({ data: { tenantId: job.tenantId, action: "PBX_JOB_FAILED", entityType: "PbxJob", entityId: job.id } });
    }
  }
}



async function runCallInviteExpiryCycle(): Promise<void> {
  const now = new Date();
  const pendingExpired = await db.callInvite.findMany({
    where: { status: "PENDING", expiresAt: { lt: now } },
    take: 200
  });

  let marked = 0;
  for (const invite of pendingExpired) {
    const out = await db.callInvite.updateMany({ where: { id: invite.id, status: "PENDING" }, data: { status: "EXPIRED" } });
    if (!out.count) continue;
    marked += out.count;

    await createMissedCallRecordForInvite(invite, "MISSED").catch(() => undefined);
    await sendPushToUserDevices({
      tenantId: invite.tenantId,
      userId: invite.userId,
      payload: {
        type: "MISSED_CALL",
        inviteId: invite.id,
        fromNumber: invite.fromNumber,
        toExtension: invite.toExtension,
        tenantId: invite.tenantId,
        timestamp: new Date().toISOString()
      }
    }).catch(() => undefined);
  }

  if (marked > 0) {
    console.log(`call invite expiry cycle marked ${marked} invites as EXPIRED`);
  }
}


async function runVoiceDiagAlertCycle(): Promise<void> {
  const since5m = new Date(Date.now() - 5 * 60 * 1000);
  const since1h = new Date(Date.now() - 60 * 60 * 1000);

  const [answers, connects, wsDisconnects, recentSessions] = await Promise.all([
    db.voiceDiagEvent.groupBy({ by: ["tenantId"], where: { createdAt: { gte: since5m }, type: "ANSWER_TAPPED" }, _count: { _all: true } }),
    db.voiceDiagEvent.groupBy({ by: ["tenantId"], where: { createdAt: { gte: since5m }, type: "CALL_CONNECTED" }, _count: { _all: true } }),
    db.voiceDiagEvent.groupBy({ by: ["tenantId"], where: { createdAt: { gte: since5m }, type: "WS_DISCONNECTED" }, _count: { _all: true } }),
    db.voiceClientSession.findMany({ where: { startedAt: { gte: since1h } }, select: { tenantId: true, iceHasTurn: true } })
  ]);

  const mapCount = (rows: any[]) => {
    const m = new Map<string, number>();
    for (const row of rows) m.set(String(row.tenantId), Number(row?._count?._all || 0));
    return m;
  };

  const answersByTenant = mapCount(answers as any[]);
  const connectsByTenant = mapCount(connects as any[]);
  const wsByTenant = mapCount(wsDisconnects as any[]);

  const sessionStats = new Map<string, { total: number; noTurn: number }>();
  for (const s of recentSessions) {
    const curr = sessionStats.get(s.tenantId) || { total: 0, noTurn: 0 };
    curr.total += 1;
    if (!s.iceHasTurn) curr.noTurn += 1;
    sessionStats.set(s.tenantId, curr);
  }

  const tenantIds = new Set<string>([
    ...Array.from(answersByTenant.keys()),
    ...Array.from(connectsByTenant.keys()),
    ...Array.from(wsByTenant.keys()),
    ...Array.from(sessionStats.keys())
  ]);

  for (const tenantId of tenantIds) {
    const answersCount = answersByTenant.get(tenantId) || 0;
    const connectsCount = connectsByTenant.get(tenantId) || 0;
    const wsDiscCount = wsByTenant.get(tenantId) || 0;
    const sess = sessionStats.get(tenantId) || { total: 0, noTurn: 0 };
    const connectRatio = answersCount > 0 ? connectsCount / answersCount : 1;
    const noTurnRatio = sess.total > 0 ? sess.noTurn / sess.total : 0;

    const alerts: Array<{ severity: string; message: string; metadata: any }> = [];

    if (answersCount >= 5 && connectRatio < 0.6) {
      alerts.push({
        severity: "HIGH",
        message: "Low answer-to-connect ratio in last 5m",
        metadata: { answersCount, connectsCount, connectRatio: Number(connectRatio.toFixed(3)) }
      });
    }

    if (wsDiscCount >= 20) {
      alerts.push({
        severity: "HIGH",
        message: "WebSocket disconnect spike detected in last 5m",
        metadata: { wsDisconnects: wsDiscCount }
      });
    }

    if (sess.total >= 5 && noTurnRatio > 0.7 && connectRatio < 0.8) {
      alerts.push({
        severity: "MEDIUM",
        message: "High no-TURN usage correlated with call reliability drop",
        metadata: { sessionCount: sess.total, noTurnCount: sess.noTurn, noTurnRatio: Number(noTurnRatio.toFixed(3)), connectRatio: Number(connectRatio.toFixed(3)) }
      });
    }

    for (const alert of alerts) {
      const exists = await db.alert.findFirst({
        where: {
          tenantId,
          category: "VOICE_DIAG",
          message: alert.message,
          createdAt: { gte: since5m }
        }
      });
      if (exists) continue;
      await db.alert.create({
        data: {
          tenantId,
          severity: alert.severity,
          category: "VOICE_DIAG",
          message: alert.message,
          metadata: alert.metadata as any
        }
      });
      await db.auditLog.create({
        data: {
          tenantId,
          action: "VOICE_DIAG_ALERT",
          entityType: "Alert",
          entityId: tenantId
        }
      }).catch(() => undefined);
    }
  }
}


async function runTurnValidationMaintenanceCycle(): Promise<void> {
  const now = new Date();
  const staleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const expiredJobs = await db.turnValidationJob.findMany({
    where: {
      status: { in: ["QUEUED", "RUNNING"] },
      expiresAt: { lt: now },
      finishedAt: null
    },
    take: 200
  });

  for (const job of expiredJobs) {
    await db.turnValidationJob.updateMany({
      where: { id: job.id, finishedAt: null },
      data: { status: "FAILED", finishedAt: now, errorCode: job.errorCode || "EXPIRED" }
    });
  }

  const staleTenants = await db.tenant.findMany({
    where: {
      turnValidationStatus: "VERIFIED",
      turnValidatedAt: { lt: staleCutoff }
    },
    select: { id: true }
  });

  for (const tenant of staleTenants) {
    await db.tenant.update({
      where: { id: tenant.id },
      data: { turnValidationStatus: "STALE" }
    });
  }

  if (expiredJobs.length > 0 || staleTenants.length > 0) {
    console.log(`turn validation maintenance: expiredJobs=${expiredJobs.length}, staleTenants=${staleTenants.length}`);
  }
}


async function runMediaReliabilityMaintenanceCycle(): Promise<void> {
  const now = new Date();
  const staleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const since5m = new Date(Date.now() - 5 * 60 * 1000);

  const staleCandidates = await db.tenant.findMany({
    where: {
      mediaTestStatus: "PASSED",
      mediaTestedAt: { lt: staleCutoff }
    },
    select: { id: true }
  });

  for (const tenant of staleCandidates) {
    await db.tenant.update({
      where: { id: tenant.id },
      data: { mediaTestStatus: "STALE" }
    });
  }

  const gateBlocked = await db.tenant.findMany({
    where: {
      mediaReliabilityGateEnabled: true,
      OR: [
        { mediaTestStatus: { not: "PASSED" } },
        { mediaTestedAt: null },
        { mediaTestedAt: { lt: staleCutoff } }
      ]
    },
    select: { id: true, mediaTestStatus: true, mediaTestedAt: true, mediaLastErrorCode: true }
  });

  for (const tenant of gateBlocked) {
    const exists = await db.alert.findFirst({
      where: {
        tenantId: tenant.id,
        category: "VOICE_DIAG",
        message: "Media reliability gate enabled but tenant is not PASSED",
        createdAt: { gte: since5m }
      }
    });
    if (exists) continue;

    await db.alert.create({
      data: {
        tenantId: tenant.id,
        severity: "MEDIUM",
        category: "VOICE_DIAG",
        message: "Media reliability gate enabled but tenant is not PASSED",
        metadata: {
          mediaTestStatus: tenant.mediaTestStatus,
          mediaTestedAt: tenant.mediaTestedAt,
          mediaLastErrorCode: tenant.mediaLastErrorCode || null
        } as any
      }
    });

    await db.auditLog.create({
      data: {
        tenantId: tenant.id,
        action: "VOICE_MEDIA_GATE_ALERT",
        entityType: "Tenant",
        entityId: tenant.id
      }
    }).catch(() => undefined);
  }

  if (staleCandidates.length > 0 || gateBlocked.length > 0) {
    console.log(`media reliability maintenance: staleTenants=${staleCandidates.length}, gateBlocked=${gateBlocked.length}`);
  }
}

async function runPbxCdrSyncCycle(): Promise<void> {
  const links: any[] = await db.tenantPbxLink.findMany({ where: { status: "LINKED" }, include: { pbxInstance: true } as any } as any);
  for (const link of links) {
    try {
      if (!link?.pbxInstance) continue;
      const auth = decryptJson<{ token: string; secret?: string | null }>(link.pbxInstance.apiAuthEncrypted);
      const pbx = getPbxClient({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret || null });
      const cursor = await db.pbxCdrCursor.upsert({
        where: { tenantId: link.tenantId },
        create: { tenantId: link.tenantId, pbxInstanceId: link.pbxInstanceId, lastSeenCdrId: null, lastSeenTimestamp: null },
        update: { pbxInstanceId: link.pbxInstanceId }
      });

      const fetched = await pbx.fetchCdrs({ pbxTenantId: link.pbxTenantId || undefined, lastSeenCdrId: cursor.lastSeenCdrId || undefined, lastSeenTimestamp: cursor.lastSeenTimestamp ? cursor.lastSeenTimestamp.toISOString() : undefined, limit: 200 });
      for (const rec of fetched.records) {
        await db.callRecord.upsert({
          where: { tenantId_pbxCallId: { tenantId: link.tenantId, pbxCallId: rec.id } },
          create: {
            tenantId: link.tenantId,
            direction: rec.direction,
            fromNumber: rec.from,
            toNumber: rec.to,
            startedAt: new Date(rec.startedAt),
            durationSec: rec.durationSec,
            disposition: rec.disposition || null,
            pbxCallId: rec.id
          },
          update: {
            direction: rec.direction,
            fromNumber: rec.from,
            toNumber: rec.to,
            startedAt: new Date(rec.startedAt),
            durationSec: rec.durationSec,
            disposition: rec.disposition || null
          }
        });
      }

      await db.pbxCdrCursor.update({
        where: { tenantId: link.tenantId },
        data: {
          lastSeenCdrId: fetched.nextCursor?.lastSeenCdrId || cursor.lastSeenCdrId,
          lastSeenTimestamp: fetched.nextCursor?.lastSeenTimestamp ? new Date(fetched.nextCursor.lastSeenTimestamp) : cursor.lastSeenTimestamp,
          pbxInstanceId: link.pbxInstanceId
        }
      });
      await db.tenantPbxLink.update({ where: { id: link.id }, data: { lastSyncAt: new Date(), status: "LINKED", lastError: null } });
    } catch (e: any) {
      await db.tenantPbxLink.update({ where: { id: link.id }, data: { status: "ERROR", lastError: String(e?.message || "PBX_CDR_SYNC_FAILED") } });
      await db.auditLog.create({ data: { tenantId: link.tenantId, action: "PBX_CDR_SYNC_FAILED", entityType: "TenantPbxLink", entityId: link.id } });
    }
  }
}

const worker = new Worker(
  "sms-send",
  async (job) => {
    const raw = job.data as { kind?: string; connectChatMessageId?: string; messageId?: string; tenantId: string };
    if (raw?.kind === "CONNECT_CHAT" && raw.connectChatMessageId) {
      await processConnectChatSmsJob({ connectChatMessageId: raw.connectChatMessageId, tenantId: raw.tenantId });
      return;
    }

    const payload = job.data as { messageId: string; tenantId: string };
    const msg = await db.smsMessage.findUnique({ where: { id: payload.messageId }, include: { campaign: { include: { tenant: true } } } });
    if (!msg) return;

    const tenant = msg.campaign.tenant;

    if (tenant.smsSuspended) {
      await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: "TENANT_SUSPENDED" } });
      await finalizeCampaignStatus(msg.campaignId);
      return;
    }
    if (tenant.smsSendMode === "LIVE" && tenant.smsBillingEnforced && tenant.smsSubscriptionRequired) {
      const sub = await db.subscription.findUnique({ where: { tenantId: tenant.id } });
      if (!sub || sub.status !== "ACTIVE") {
        await db.tenant.update({ where: { id: tenant.id }, data: { smsSuspended: true, smsSuspendedReason: "BILLING_PAST_DUE", smsSuspendedAt: new Date() } });
        await db.auditLog.create({ data: { tenantId: tenant.id, action: "SMS_TENANT_SUSPENDED", entityType: "Tenant", entityId: tenant.id } });
        await db.smsCampaign.updateMany({ where: { id: msg.campaignId }, data: { status: "PAUSED", holdReason: "BILLING_PAST_DUE" } });
        await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: "BILLING_PAST_DUE" } });
        await finalizeCampaignStatus(msg.campaignId);
        return;
      }
    }

    if (await shouldAutoSuspendForFailureRate(tenant.id)) {
      await suspendTenant(tenant.id, "HIGH_FAILURE_RATE", tenant.id);
      await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: "TENANT_SUSPENDED" } });
      await finalizeCampaignStatus(msg.campaignId);
      return;
    }

    const daily = await countDaily(tenant.id);
    if (daily >= tenant.dailySmsLimit) {
      await suspendTenant(tenant.id, "DAILY_LIMIT_EXCEEDED", tenant.id);
      await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: "TENANT_SUSPENDED" } });
      await finalizeCampaignStatus(msg.campaignId);
      return;
    }

    const hourly = await countHourly(tenant.id);
    if (hourly >= tenant.hourlySmsLimit) {
      await db.smsMessage.update({ where: { id: msg.id }, data: { status: "QUEUED", error: "HOURLY_LIMIT_DELAYED_5M" } });
      await smsQueue.add("send", { messageId: msg.id, tenantId: tenant.id }, { delay: 5 * 60 * 1000, removeOnComplete: true, attempts: 3 });
      return;
    }

    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    const sentToRecipientLastMinute = await db.smsMessage.count({
      where: {
        campaign: { tenantId: tenant.id },
        toNumber: msg.toNumber,
        status: { in: ["SENT", "DELIVERED"] },
        createdAt: { gte: oneMinuteAgo }
      }
    });
    if (sentToRecipientLastMinute > 0) {
      await db.smsMessage.update({ where: { id: msg.id }, data: { status: "QUEUED", error: "RECIPIENT_60S_DELAY" } });
      await smsQueue.add("send", { messageId: msg.id, tenantId: tenant.id }, { delay: 60 * 1000, removeOnComplete: true, attempts: 3 });
      return;
    }

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sentToRecipient24h = await db.smsMessage.count({
      where: {
        campaign: { tenantId: tenant.id },
        toNumber: msg.toNumber,
        status: { in: ["SENT", "DELIVERED"] },
        createdAt: { gte: oneDayAgo }
      }
    });
    if (sentToRecipient24h >= 10) {
      await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: "RECIPIENT_RATE_LIMIT" } });
      await finalizeCampaignStatus(msg.campaignId);
      return;
    }

    await enforcePerSecondTokenBucket(tenant.id, tenant.perSecondRateLimit);
    await db.smsMessage.update({ where: { id: msg.id }, data: { status: "SENDING", error: null } });
    await db.smsCampaign.updateMany({ where: { id: msg.campaignId, status: { notIn: ["PAUSED", "FAILED"] } }, data: { status: "SENDING" } });

    try {
      if (tenant.smsSendMode === "TEST") {
        const now = new Date();
        await db.smsMessage.update({
          where: { id: msg.id },
          data: {
            status: "SENT",
            providerMessageId: `SIMULATED_${randomUUID()}`,
            providerStatus: "simulated",
            providerAttemptedAt: now,
            providerRoute: "PRIMARY",
            lastProviderUpdateAt: now,
            sentAt: now,
            error: null
          }
        });
        await db.auditLog.create({ data: { tenantId: tenant.id, action: "SMS_MESSAGE_SIMULATED", entityType: "SmsMessage", entityId: msg.id } });
        await finalizeCampaignStatus(msg.campaignId);
        return;
      }

      const senderNumber = await resolveSenderNumber(msg, tenant.id);
      if (!senderNumber) {
        await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: "NO_SENDER_NUMBER" } });
        await finalizeCampaignStatus(msg.campaignId);
        return;
      }

      let attempts = buildRoutingAttemptOrder(tenant);
      attempts = attempts.filter((a) => a.provider === senderNumber.provider);
      if (attempts.length === 0) {
        await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: "SENDER_PROVIDER_MISMATCH" } });
        await finalizeCampaignStatus(msg.campaignId);
        return;
      }

      let sentOk = false;
      let lastErr: any = null;

      for (let i = 0; i < attempts.length; i += 1) {
        const candidate = attempts[i];

        if (!tenant.smsProviderLock) {
          const openUntil = await getCircuitOpenUntil(tenant.id, candidate.provider);
          if (openUntil) continue;
        }

        const providerClient = await getProviderClient(tenant.id, candidate.provider);
        if (!providerClient) continue;

        try {
          const sent = await providerClient.sendMessage({
            tenantId: tenant.id,
            to: msg.toNumber,
            from: senderNumber.phoneNumber,
            body: msg.body,
            idempotencyKey: msg.id
          });

          const now = new Date();
          await db.smsMessage.update({
            where: { id: msg.id },
            data: {
              status: "SENT",
              provider: candidate.provider,
              providerMessageId: sent.providerMessageId || null,
              providerStatus: sent.providerStatus || "sent",
              providerAttemptedAt: now,
              providerRoute: candidate.route,
              providerErrorCode: null,
              lastProviderUpdateAt: now,
              sentAt: now,
              error: null,
              fromNumberId: senderNumber.id
            }
          });

          await recordProviderHealth(tenant.id, candidate.provider, true);
          await db.auditLog.create({ data: { tenantId: tenant.id, action: "SMS_MESSAGE_SENT", entityType: "SmsMessage", entityId: msg.id, provider: candidate.provider } });
          sentOk = true;
          break;
        } catch (err: any) {
          lastErr = err;
          const normalized = normalizeProviderError(candidate.provider, err);
          await recordProviderHealth(tenant.id, candidate.provider, false, normalized.code);

          await db.smsMessage.update({
            where: { id: msg.id },
            data: {
              provider: candidate.provider,
              providerStatus: "failed",
              providerAttemptedAt: new Date(),
              providerRoute: candidate.route,
              providerErrorCode: normalized.code,
              error: normalized.humanMessage,
              lastProviderUpdateAt: new Date()
            }
          });

          const attemptsMax = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
          const thisAttempt = (job.attemptsMade || 0) + 1;
          const finalAttempt = thisAttempt >= attemptsMax;
          if (finalAttempt || !normalized.retryable) break;
        }
      }

      if (!sentOk) {
        const attemptsMax = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
        const thisAttempt = (job.attemptsMade || 0) + 1;
        const finalAttempt = thisAttempt >= attemptsMax;

        if (finalAttempt) {
          await db.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: String(lastErr?.message || "provider send failed"), providerStatus: "failed", lastProviderUpdateAt: new Date(), deliveryUpdatedAt: new Date() } });
          await db.auditLog.create({ data: { tenantId: tenant.id, action: "SMS_MESSAGE_FAILED_FINAL", entityType: "SmsMessage", entityId: msg.id } });
        } else {
          await db.smsMessage.update({ where: { id: msg.id }, data: { status: "QUEUED", error: "retrying provider send" } });
          await db.auditLog.create({ data: { tenantId: tenant.id, action: "SMS_MESSAGE_RETRY_SCHEDULED", entityType: "SmsMessage", entityId: msg.id } });
          throw lastErr || new Error("provider send failed");
        }
      }
    } catch (err: any) {
      await finalizeCampaignStatus(msg.campaignId);
      throw err;
    }

    await finalizeCampaignStatus(msg.campaignId);
  },
  { connection: redis, concurrency: 5 }
);

worker.on("completed", (job) => console.log(`sms job completed: ${job.id}`));
worker.on("failed", (job, err) => console.error(`sms job failed: ${job?.id} -> ${err.message}`));

console.log("SMS worker started");

// â”€â”€ Voicemail sync helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function getVitalPbxClientForWorker(input: { baseUrl: string; token: string; secret?: string | null }) {
  return new VitalPbxClient({
    baseUrl: input.baseUrl,
    apiToken: input.token,
    apiSecret: input.secret || undefined,
    timeoutMs: Number(process.env.PBX_TIMEOUT_MS || 10000),
  });
}

function vmExtractCallerNumber(callerid: string): string {
  const match = callerid.match(/<([^>]+)>/);
  const raw = match ? match[1]! : callerid.replace(/"/g, "").trim();
  return raw.replace(/\D/g, "");
}

function vmExtractCallerName(callerid: string): string {
  // VitalPBX sends clid like 'LANDAU TOBY<8457828230>' (no quotes), or
  // '"LANDAU TOBY" <8457828230>' (RFC-3261 style). Grab everything before the
  // first '<' as the CNAM, unless it's just a phone number.
  const idx = callerid.indexOf("<");
  if (idx <= 0) return "";
  const name = callerid.slice(0, idx).replace(/^\s*"?/, "").replace(/"?\s*$/, "").trim();
  if (!name || /^[\d\s+\-().]+$/.test(name)) return "";
  return name;
}

function vmNormalizeFolder(folder: string): "inbox" | "old" | "urgent" {
  const f = folder.toLowerCase();
  if (f === "inbox" || f === "in") return "inbox";
  if (f === "urgent") return "urgent";
  return "old";
}

let _voicemailSyncRunning = false;

async function runVoicemailSyncCycle(): Promise<void> {
  if (_voicemailSyncRunning) return;
  _voicemailSyncRunning = true;
  try {
    // We intentionally do NOT filter by status="LINKED" here. The admin tenant
    // refresh cron sets status=ERROR when the /tenants.list sync fails (e.g.
    // one bad endpoint), which should NOT stop voicemail polling. The underlying
    // pbxInstance may still be perfectly usable. We trust isEnabled on the
    // PbxInstance and let the per-request try/catch absorb individual failures.
    // Matches the fallback strategy used by resolvePbxInstanceForCdr for
    // recording playback in the API.
    const links: any[] = await db.tenantPbxLink.findMany({
      where: { pbxInstance: { isEnabled: true } } as any,
      include: { pbxInstance: true } as any,
    } as any);

    if (links.length === 0) return; // nothing wired up yet — silent no-op

    let totalExts = 0;
    let totalRecords = 0;
    let totalUpserts = 0;
    let totalErrors = 0;

    for (const link of links) {
      if (!link?.pbxInstance) continue;
      try {
        const auth = decryptJson<{ token: string; secret?: string | null }>(link.pbxInstance.apiAuthEncrypted);
        const pbx = getVitalPbxClientForWorker({ baseUrl: link.pbxInstance.baseUrl, token: auth.token, secret: auth.secret || null });

        const extensions: any[] = await db.extension.findMany({
          where: { tenantId: link.tenantId, status: "ACTIVE" } as any,
          include: { pbxLink: true } as any,
        } as any);

        for (const ext of extensions) {
          const pbxExtId: string | undefined = ext.pbxLink?.pbxExtensionId;
          if (!pbxExtId) continue;
          totalExts++;
          try {
            const records: any[] = await pbx.getExtensionVoicemailRecords(pbxExtId, link.pbxTenantId || undefined);
            totalRecords += records.length;
            for (const rec of records) {
              // VitalPBX payload uses { date, clid, recfile, filename, msg_id }.
              // Older Asterisk-voicemail dumps used { origtime, callerid, msg_num }.
              // Accept both so future API changes don't silently drop records.
              const origtime = String(rec.date ?? rec.origtime ?? rec.orig_time ?? "");
              if (!origtime || origtime === "0") continue;
              const rawCallerid = String(rec.clid ?? rec.callerid ?? rec.caller_id ?? "");
              const callerNumber = vmExtractCallerNumber(rawCallerid) || null;
              const callerName = vmExtractCallerName(rawCallerid) || null;
              const callerDigits = (callerNumber ?? "").slice(-10);
              const rawFolder = String(rec.folder ?? "INBOX");
              const folder = vmNormalizeFolder(rawFolder);
              const listened = folder !== "inbox";
              // Prefer VitalPBX's own stable msg_id (e.g. "1761219702-000000b2") when
              // present; fall back to a deterministic composite so legacy responses
              // still dedupe reliably.
              const msgId = String(
                rec.msg_id
                  ?? `${link.pbxTenantId || link.tenantId}|${ext.extNumber}|${origtime}|${callerDigits}`,
              );
              // pbxMsgNum is the bare message name ("msg0000") used by the
              // /api/v2/voicemail/:mailbox/:folder/:messageName playback endpoint.
              // Derive from `filename` (msg0000.txt) or `recfile` (.../msg0000.wav).
              const filename = String(rec.filename ?? "");
              const recfile = String(rec.recfile ?? "");
              const fromFilename = filename.replace(/\.[^.]+$/, "");
              const fromRecfile = recfile ? (recfile.split("/").pop() ?? "").replace(/\.[^.]+$/, "") : "";
              const pbxMsgNum = String(
                rec.msg_num ?? rec.msgnum ?? rec.id ?? fromFilename ?? fromRecfile ?? "",
              );

              totalUpserts++;
              await (db as any).voicemail.upsert({
                where: { pbxMessageId: msgId },
                create: {
                  pbxMessageId: msgId,
                  tenantId: link.tenantId,
                  extension: ext.extNumber,
                  pbxExtensionId: pbxExtId,
                  callerNumber,
                  callerName,
                  durationSec: parseInt(String(rec.duration ?? "0"), 10) || 0,
                  folder,
                  pbxFolder: rawFolder,
                  pbxMsgNum,
                  pbxRecfile: recfile || null,
                  listened,
                  receivedAt: new Date(parseInt(origtime, 10) * 1000),
                },
                update: {
                  folder,
                  pbxFolder: rawFolder,
                  pbxMsgNum,
                  // Only overwrite recfile when PBX actually returned one — avoids
                  // nulling out a good value if a future response trims the field.
                  ...(recfile ? { pbxRecfile: recfile } : {}),
                  // Re-apply caller fields every cycle so any CNAM-extraction fix
                  // (e.g. unquoted clid support) backfills existing rows automatically.
                  callerNumber,
                  callerName,
                  listened,
                },
              });
            }
          } catch (extErr: any) {
            totalErrors++;
            console.warn(`voicemail sync ext ${ext.extNumber} (tenant ${link.tenantId}): ${extErr?.message}`);
          }
        }
      } catch (tenantErr: any) {
        totalErrors++;
        console.error(`voicemail sync tenant ${link.tenantId}: ${tenantErr?.message}`);
      }
    }

    console.log(
      `[voicemail-sync] links=${links.length} extsChecked=${totalExts} records=${totalRecords} upserts=${totalUpserts} errors=${totalErrors}`,
    );
  } finally {
    _voicemailSyncRunning = false;
  }
}

// â”€â”€â”€ IVR Routing â€” Option A: schedule-based auto-publish â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Runs every 5 minutes.  For every tenant with an active IvrScheduleConfig,
// computes the intended routing mode (business/afterhours/holiday/override) and,
// if the mode has changed since the last publish (or >1 h has passed), writes
// the new state to Asterisk AstDB via the telephony service HTTP endpoint.
// NO PBX API calls; NO SSH; NO file mutations.

function ivrToIvrSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Fixed set of digit slots written on every publish. Must match the list in
// apps/api/src/server.ts — if they drift, an API publish and a worker publish
// would write different key sets and snapshot/rollback would lose fidelity.
const IVR_OPTION_DIGITS_WORKER = [
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "star", "hash",
] as const;

function ivrModeToType(mode: string): string | null {
  switch (mode) {
    case "business":   return "business_hours";
    case "afterhours": return "after_hours";
    case "holiday":    return "holiday";
    case "override":   return "manual_override";
    default:           return null;
  }
}

function ivrComputeMode(
  config: { timezone: string; businessHoursRules: any; holidayDates: any },
  override: { isActive: boolean; expiresAt: Date | null } | null,
  now: Date = new Date(),
): "business" | "afterhours" | "holiday" | "override" {
  if (override?.isActive && (!override.expiresAt || override.expiresAt > now)) return "override";
  const tz = config.timezone || "UTC";
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const holidays: string[] = Array.isArray(config.holidayDates) ? config.holidayDates : [];
  if (holidays.includes(localDate)) return "holiday";
  const rules: Array<{ day: number; open: string; close: string }> = Array.isArray(config.businessHoursRules) ? config.businessHoursRules : [];
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const DOW_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = DOW_MAP[parts.find((p) => p.type === "weekday")?.value ?? ""] ?? now.getDay();
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const minStr  = parts.find((p) => p.type === "minute")?.value ?? "0";
  const minuteOfDay = parseInt(hourStr, 10) * 60 + parseInt(minStr, 10);
  const parseHHMM = (s: string) => { const [h, m] = s.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  const rule = rules.find((r) => r.day === dow);
  if (rule && minuteOfDay >= parseHHMM(rule.open) && minuteOfDay < parseHHMM(rule.close)) return "business";
  return "afterhours";
}

let _ivrScheduleRunning = false;
async function runIvrScheduleCycle(): Promise<void> {
  if (_ivrScheduleRunning) return;
  _ivrScheduleRunning = true;
  try {
    const schedules: any[] = await (db as any).ivrScheduleConfig.findMany({
      where: { isActive: true },
      include: { tenant: { select: { name: true } } },
    });
    if (schedules.length === 0) return;

    const base = (process.env.TELEPHONY_INTERNAL_URL ?? "http://telephony:3003").replace(/\/$/, "");
    const secret = process.env.CDR_INGEST_SECRET?.trim() ?? "";
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    for (const sched of schedules) {
      try {
        const tenantId: string = sched.tenantId;
        const slug = ivrToIvrSlug(sched.tenant?.name ?? tenantId);
        const fam = `connect/t_${slug}`;

        const [override, profiles, lastPublish] = await Promise.all([
          (db as any).ivrOverrideState.findUnique({ where: { tenantId } }),
          (db as any).ivrRouteProfile.findMany({ where: { tenantId, isActive: true } }),
          (db as any).ivrPublishRecord.findFirst({ where: { tenantId, status: "success" }, orderBy: { publishedAt: "desc" } }),
        ]);

        const mode = ivrComputeMode(sched, override, now);
        const lastMode = lastPublish?.mode ?? null;
        const lastAt: Date | null = lastPublish?.publishedAt ?? null;
        const stale = !lastAt || lastAt < oneHourAgo;
        if (mode === lastMode && !stale) continue;

        // Look up the profile serving this mode (same fallback as the API:
        // manual_override falls back to emergency). Its options + prompt refs
        // drive the Phase 2 IVR keys.
        const wantedType = ivrModeToType(mode);
        const byType = new Map((profiles as any[]).map((p: any) => [p.type, p]));
        const active: any = wantedType
          ? (byType.get(wantedType) ?? (mode === "override" ? byType.get("emergency") : null))
          : null;
        const activeOptions: any[] = active
          ? await (db as any).ivrOptionRoute.findMany({ where: { profileId: active.id } })
          : [];
        const optByDigit = new Map<string, any>();
        for (const o of activeOptions) {
          if (o.enabled) optByDigit.set(o.optionDigit, o);
        }

        const keys: Array<{ family: string; key: string; value: string }> = [
          // Legacy single-destination keys (still read by [connect-tenant-router]).
          { family: fam, key: "mode",             value: mode },
          { family: fam, key: "dest_business",    value: byType.get("business_hours")?.pbxDestination  ?? "" },
          { family: fam, key: "dest_afterhours",  value: byType.get("after_hours")?.pbxDestination     ?? "" },
          { family: fam, key: "dest_holiday",     value: byType.get("holiday")?.pbxDestination         ?? "" },
          { family: fam, key: "dest_override",    value: byType.get("manual_override")?.pbxDestination ?? byType.get("emergency")?.pbxDestination ?? "" },
          { family: fam, key: "override_expires", value: override?.expiresAt ? String(Math.floor(new Date(override.expiresAt).getTime() / 1000)) : "0" },
          // Phase 2 prompt + timing keys (read by [connect-tenant-ivr]).
          { family: fam, key: "active_prompt",         value: active?.pbxPromptRef        ?? "" },
          { family: fam, key: "active_prompt_invalid", value: active?.pbxInvalidPromptRef ?? "" },
          { family: fam, key: "active_prompt_timeout", value: active?.pbxTimeoutPromptRef ?? "" },
          { family: fam, key: "timeout_seconds",       value: String(active?.timeoutSeconds ?? 7) },
          { family: fam, key: "max_retries",           value: String(active?.maxRetries    ?? 3) },
        ];
        // Always write every digit slot — empty value clears a stale option
        // when the new active profile has fewer digits mapped than the old.
        for (const digit of IVR_OPTION_DIGITS_WORKER) {
          const o = optByDigit.get(digit);
          keys.push({ family: fam, key: `opt_${digit}/dest`, value: o?.destinationRef  ?? "" });
          keys.push({ family: fam, key: `opt_${digit}/type`, value: o?.destinationType ?? "" });
        }

        // Snapshot pre-publish AstDB state so an operator-initiated rollback
        // of this automated publish can restore the true prior values. If the
        // snapshot call fails, we still publish and record an empty array —
        // rollback of that record will fail cleanly with no_snapshot_available.
        let previousKeys: Array<{ family: string; key: string; value: string }> = [];
        try {
          const snapResp = await fetch(`${base}/telephony/internal/astdb-read-family`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(secret ? { "x-cdr-secret": secret } : {}) },
            body: JSON.stringify({ tenantSlug: slug, family: fam, keys: keys.map((k) => k.key) }),
            signal: AbortSignal.timeout(5_000),
          });
          if (snapResp.ok) {
            const snapData = await snapResp.json().catch(() => null) as { ok?: boolean; snapshot?: Array<{ family: string; key: string; value: string }> } | null;
            if (snapData?.ok && Array.isArray(snapData.snapshot)) previousKeys = snapData.snapshot;
          }
        } catch {
          previousKeys = [];
        }

        const record: any = await (db as any).ivrPublishRecord.create({
          data: { tenantId, publishedBy: "system", mode, keysWritten: keys, previousKeys, status: "pending", isRollback: false },
        });

        try {
          const resp = await fetch(`${base}/telephony/internal/ivr-publish`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(secret ? { "x-cdr-secret": secret } : {}) },
            body: JSON.stringify({ tenantSlug: slug, keys }),
            signal: AbortSignal.timeout(8_000),
          });
          if (!resp.ok) throw new Error(`ivr-publish HTTP ${resp.status}`);
          await (db as any).ivrPublishRecord.update({ where: { id: record.id }, data: { status: "success" } });
          console.log(`ivr schedule: published mode=${mode} for tenant ${tenantId} (slug=${slug})`);
        } catch (pubErr: any) {
          await (db as any).ivrPublishRecord.update({ where: { id: record.id }, data: { status: "failed", error: pubErr?.message } });
          console.error(`ivr schedule: publish failed for tenant ${tenantId}: ${pubErr?.message}`);
        }
      } catch (tenantErr: any) {
        console.error(`ivr schedule: error for schedule ${sched.id}: ${tenantErr?.message}`);
      }
    }
  } finally {
    _ivrScheduleRunning = false;
  }
}


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

setInterval(() => {
  runDunningCycle().catch((err) => console.error("dunning cycle failed", err?.message || err));
}, 60 * 60 * 1000);

runDunningCycle().catch((err) => console.error("initial dunning cycle failed", err?.message || err));

setInterval(() => {
  runPbxJobCycle().catch((err) => console.error("pbx job cycle failed", err?.message || err));
}, 60 * 1000);

setInterval(() => {
  runPbxCdrSyncCycle().catch((err) => console.error("pbx cdr sync failed", err?.message || err));
}, 2 * 60 * 1000);

setInterval(() => {
  runCallInviteExpiryCycle().catch((err) => console.error("call invite expiry failed", err?.message || err));
}, 5 * 1000);

setInterval(() => {
  runPbxActiveCallPollCycle().catch((err) => console.error("pbx active call poll failed", err?.message || err));
}, 5 * 1000);

setInterval(() => {
  runVoiceDiagAlertCycle().catch((err) => console.error("voice diag alert cycle failed", err?.message || err));
}, 5 * 60 * 1000);

setInterval(() => {
  runTurnValidationMaintenanceCycle().catch((err) => console.error("turn validation maintenance failed", err?.message || err));
}, 5 * 60 * 1000);

setInterval(() => {
  runMediaReliabilityMaintenanceCycle().catch((err) => console.error("media reliability maintenance failed", err?.message || err));
}, 5 * 60 * 1000);

runCallInviteExpiryCycle().catch((err) => console.error("initial call invite expiry failed", err?.message || err));
runVoiceDiagAlertCycle().catch((err) => console.error("initial voice diag alert cycle failed", err?.message || err));
runTurnValidationMaintenanceCycle().catch((err) => console.error("initial turn validation maintenance failed", err?.message || err));
runMediaReliabilityMaintenanceCycle().catch((err) => console.error("initial media reliability maintenance failed", err?.message || err));
runPbxActiveCallPollCycle().catch((err) => console.error("initial pbx active call poll failed", err?.message || err));

// Voicemail polling is a *fallback* for missed AMI MessageWaiting events.
// Per product spec the fallback should run every 30–60s. The AMI event path
// (telephony → /internal/voicemail-notify) is the primary near-realtime path.
// _voicemailSyncRunning guards against overlap if a cycle runs long.
setInterval(() => {
  runVoicemailSyncCycle().catch((err) => console.error("voicemail sync failed", err?.message || err));
}, 60 * 1000);

runPbxJobCycle().catch((err) => console.error("initial pbx job cycle failed", err?.message || err));
runPbxCdrSyncCycle().catch((err) => console.error("initial pbx cdr sync failed", err?.message || err));
runVoicemailSyncCycle().catch((err) => console.error("initial voicemail sync failed", err?.message || err));


setInterval(() => {
  runIvrScheduleCycle().catch((err) => console.error("ivr schedule cycle failed", err?.message || err));
}, 5 * 60 * 1000);

runIvrScheduleCycle().catch((err) => console.error("initial ivr schedule cycle failed", err?.message || err));

// â”€â”€â”€ Hold Profile Scheduling â€” Option A: reconciliation/transition cycle â”€â”€â”€â”€â”€â”€
// ROLE: This worker is a RECONCILIATION AND TRANSITION DETECTOR only.
//   â€¢ Immediate publish is handled by API endpoints (override activate/deactivate, explicit publish).
//   â€¢ This worker detects schedule-boundary transitions that happen at known times (e.g.
//     09:00 business hours start) and publishes if the computed mode differs from last published.
//   â€¢ Also repairs drift (e.g. telephony was unreachable during an API publish attempt).
//
// FREQUENCY: Runs every 60 seconds. Max delay for a schedule transition = 60 seconds.
//
// SKIP OPTIMIZATION: Each tenant's MohLastPublishedState row caches (mohClass, holdMode).
//   The worker skips tenants where the computed class/mode matches the cached last publish.
//   This avoids redundant AstDB writes on every cycle when nothing has changed.

type WorkerHoldProfile = {
  id: string;
  vitalPbxMohClassName: string;
  holdAnnouncementEnabled: boolean;
  holdAnnouncementRef: string | null;
  holdAnnouncementIntervalSec: number;
  introAnnouncementRef: string | null;
};

function workerComputeHoldProfile(
  config: { timezone: string; defaultProfileId: string | null; afterHoursProfileId: string | null; holidayProfileId: string | null },
  rules: Array<{ ruleType: string; weekday: number | null; startTime: string | null; endTime: string | null; startAt: Date | null; endAt: Date | null; priority: number; isActive: boolean; profileId: string }>,
  override: { isActive: boolean; expiresAt: Date | null; profileId: string | null } | null,
  profileMap: Map<string, WorkerHoldProfile>,
  now: Date = new Date(),
): { profile: WorkerHoldProfile | null; mode: string } {
  // 1. Manual override
  if (override?.isActive && override.profileId && (!override.expiresAt || new Date(override.expiresAt) > now)) {
    const p = profileMap.get(override.profileId);
    if (p) return { profile: p, mode: "override" };
  }
  const tz = config.timezone || "UTC";
  const active = rules.filter((r) => r.isActive);
  // 2. One-time
  const oneTime = active.filter((r) => r.ruleType === "one_time" && r.startAt && r.endAt && new Date(r.startAt) <= now && new Date(r.endAt) > now).sort((a, b) => b.priority - a.priority);
  if (oneTime.length > 0) { const p = profileMap.get(oneTime[0].profileId); if (p) return { profile: p, mode: "one_time" }; }
  // 3. Holiday
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const holiday = active.filter((r) => r.ruleType === "holiday" && r.startTime === localDate).sort((a, b) => b.priority - a.priority);
  if (holiday.length > 0) { const p = profileMap.get(holiday[0].profileId); if (p) return { profile: p, mode: "holiday" }; }
  // 4. Weekly
  const dtParts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = DOW[dtParts.find((p) => p.type === "weekday")?.value ?? ""] ?? now.getDay();
  const hh = parseInt(dtParts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const mm = parseInt(dtParts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const mofDay = hh * 60 + mm;
  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  const weekly = active.filter((r) => r.ruleType === "weekly" && r.weekday === dow && r.startTime && r.endTime && mofDay >= toMin(r.startTime) && mofDay < toMin(r.endTime)).sort((a, b) => b.priority - a.priority);
  if (weekly.length > 0) { const p = profileMap.get(weekly[0].profileId); if (p) return { profile: p, mode: "weekly" }; }
  // 5. After-hours fallback
  if (config.afterHoursProfileId) { const p = profileMap.get(config.afterHoursProfileId); if (p) return { profile: p, mode: "afterhours" }; }
  // 6. Default
  if (config.defaultProfileId) { const p = profileMap.get(config.defaultProfileId); if (p) return { profile: p, mode: "default" }; }
  return { profile: null, mode: "none" };
}

let _mohReconcileRunning = false;
async function runMohScheduleCycle(): Promise<void> {
  if (_mohReconcileRunning) return;
  _mohReconcileRunning = true;
  try {
    const schedules: any[] = await (db as any).mohScheduleConfig.findMany({
      where: { isActive: true },
      include: { tenant: { select: { name: true } } },
    });
    if (schedules.length === 0) return;

    const base = (process.env.TELEPHONY_INTERNAL_URL ?? "http://telephony:3003").replace(/\/$/, "");
    const secret = process.env.CDR_INGEST_SECRET?.trim() ?? "";
    const now = new Date();

    for (const sched of schedules) {
      try {
        const tenantId: string = sched.tenantId;
        const slug = (sched.tenant?.name ?? tenantId).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
        const fam = `connect/t_${slug}`;

        const [rules, override, profilesRaw, lastState] = await Promise.all([
          (db as any).mohScheduleRule.findMany({ where: { scheduleId: sched.id, isActive: true } }),
          (db as any).mohOverrideState.findUnique({ where: { tenantId } }),
          (db as any).mohProfile.findMany({ where: { tenantId, isActive: true } }),
          (db as any).mohLastPublishedState.findUnique({ where: { tenantId } }),
        ]);

        const profileMap = new Map<string, WorkerHoldProfile>(
          (profilesRaw as any[]).map((p: any) => [p.id, {
            id: p.id, vitalPbxMohClassName: p.vitalPbxMohClassName,
            holdAnnouncementEnabled: Boolean(p.holdAnnouncementEnabled),
            holdAnnouncementRef: p.holdAnnouncementRef ?? null,
            holdAnnouncementIntervalSec: p.holdAnnouncementIntervalSec ?? 30,
            introAnnouncementRef: p.introAnnouncementRef ?? null,
          }]),
        );

        const { profile, mode } = workerComputeHoldProfile(sched, rules, override, profileMap, now);
        if (!profile) continue;

        // Skip if last published state matches â€” no drift, no transition
        const lastClass = lastState?.mohClass ?? null;
        const lastMode  = lastState?.holdMode ?? null;
        if (profile.vitalPbxMohClassName === lastClass && mode === lastMode) continue;

        const keys = [
          { family: fam, key: "active_moh_class",           value: profile.vitalPbxMohClassName },
          { family: fam, key: "hold_mode",                  value: mode },
          { family: fam, key: "hold_announcement_enabled",  value: profile.holdAnnouncementEnabled ? "1" : "0" },
          { family: fam, key: "hold_announcement_ref",      value: profile.holdAnnouncementRef ?? "" },
          { family: fam, key: "hold_announcement_interval", value: String(profile.holdAnnouncementIntervalSec ?? 30) },
          { family: fam, key: "intro_announcement_ref",     value: profile.introAnnouncementRef ?? "" },
        ];

        const record: any = await (db as any).mohPublishRecord.create({
          data: { tenantId, publishedBy: "system", source: "reconciliation", previousMohClass: lastClass, newMohClass: profile.vitalPbxMohClassName, keysWritten: keys, previousKeysSnapshot: [], status: "pending", isRollback: false },
        });

        try {
          const resp = await fetch(`${base}/telephony/internal/ivr-publish`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(secret ? { "x-cdr-secret": secret } : {}) },
            body: JSON.stringify({ tenantSlug: slug, keys }),
            signal: AbortSignal.timeout(8_000),
          });
          if (!resp.ok) throw new Error(`moh reconcile HTTP ${resp.status}`);
          await (db as any).mohPublishRecord.update({ where: { id: record.id }, data: { status: "success" } });
          await (db as any).mohLastPublishedState.upsert({
            where: { tenantId },
            create: { tenantId, mohClass: profile.vitalPbxMohClassName, holdMode: mode },
            update: { mohClass: profile.vitalPbxMohClassName, holdMode: mode, publishedAt: new Date() },
          });
          console.log(`moh reconcile: published class=${profile.vitalPbxMohClassName} mode=${mode} for tenant ${tenantId}`);
        } catch (pubErr: any) {
          await (db as any).mohPublishRecord.update({ where: { id: record.id }, data: { status: "failed", error: pubErr?.message } });
          console.error(`moh reconcile: publish failed for tenant ${tenantId}: ${pubErr?.message}`);
        }
      } catch (tenantErr: any) {
        console.error(`moh reconcile: error for schedule ${sched.id}: ${tenantErr?.message}`);
      }
    }
  } finally {
    _mohReconcileRunning = false;
  }
}

// 1-minute reconciliation cycle â€” catches schedule transitions + repairs drift
setInterval(() => {
  runMohScheduleCycle().catch((err) => console.error("moh reconcile cycle failed", err?.message || err));
}, 60 * 1000);

runMohScheduleCycle().catch((err) => console.error("initial moh reconcile cycle failed", err?.message || err));

let _billingAutomationRunning = false;

function billingMonthBounds(anchor = new Date()): { periodStart: Date; periodEnd: Date } {
  return {
    periodStart: new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1, 0, 0, 0, 0)),
    periodEnd: new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0, 23, 59, 59, 999)),
  };
}

async function nextBillingInvoiceNumber(tenantId: string): Promise<string> {
  const now = new Date();
  const prefix = `CC-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const count = await (db as any).billingInvoice.count({ where: { tenantId, invoiceNumber: { startsWith: prefix } } });
  return `${prefix}-${String(count + 1).padStart(5, "0")}`;
}

async function getWorkerSolaAdapterForTenant(tenantId: string): Promise<SolaCardknoxAdapter> {
  const row = await (db as any).billingSolaConfig.findUnique({ where: { tenantId } });
  if (row?.isEnabled) {
    const secrets = decryptJson<{ apiKey: string; apiSecret?: string | null; webhookSecret?: string | null }>(row.credentialsEncrypted);
    const paths = (row.pathOverrides && typeof row.pathOverrides === "object" ? row.pathOverrides : {}) as any;
    return new SolaCardknoxAdapter({
      baseUrl: row.apiBaseUrl,
      apiKey: secrets.apiKey,
      apiSecret: secrets.apiSecret || undefined,
      webhookSecret: secrets.webhookSecret || undefined,
      mode: row.mode === "PROD" ? "prod" : "sandbox",
      simulate: !!row.simulate,
      authMode: row.authMode === "AUTHORIZATION_HEADER" ? "authorization_header" : "xkey_body",
      authHeaderName: row.authHeaderName || undefined,
      transactionPath: paths.transactionPath || "/gatewayjson",
    });
  }
  return getSolaAdapter();
}

async function runMonthlyBillingAutomation(): Promise<void> {
  if (_billingAutomationRunning) return;
  _billingAutomationRunning = true;
  try {
    const today = new Date().getUTCDate();
    const { periodStart, periodEnd } = billingMonthBounds();
    const settings = await (db as any).tenantBillingSettings.findMany({
      where: { autoBillingEnabled: true, billingDayOfMonth: today },
      include: { tenant: true, defaultPaymentMethod: true, taxProfile: true },
    });
    if (settings.length === 0) return;

    const run = await (db as any).billingRun.create({ data: { periodStart, periodEnd, status: "RUNNING", dryRun: false } });
    const results: any[] = [];
    for (const setting of settings) {
      try {
        const existing = await (db as any).billingInvoice.findFirst({ where: { tenantId: setting.tenantId, periodStart, periodEnd, status: { not: "VOID" } } });
        const invoice = existing || await createWorkerBillingInvoice(setting, periodStart, periodEnd);
        let transaction = null;
        if (setting.defaultPaymentMethod) {
          transaction = await chargeWorkerInvoice(invoice, setting.defaultPaymentMethod, run.id);
        } else {
          await (db as any).billingEventLog.create({ data: { tenantId: setting.tenantId, invoiceId: invoice.id, runId: run.id, type: "payment_method.missing", message: "Auto billing skipped because no default payment method is set." } });
        }
        results.push({ tenantId: setting.tenantId, invoiceId: invoice.id, transactionId: transaction?.id || null });
      } catch (err: any) {
        results.push({ tenantId: setting.tenantId, error: err?.message || "billing_failed" });
        await (db as any).billingEventLog.create({ data: { tenantId: setting.tenantId, runId: run.id, type: "billing_run.tenant_failed", message: err?.message || "billing_failed" } }).catch(() => null);
      }
    }
    await (db as any).billingRun.update({ where: { id: run.id }, data: { status: "COMPLETED", finishedAt: new Date(), totals: { results } } });
  } catch (err: any) {
    console.error("monthly billing automation failed", err?.message || err);
  } finally {
    _billingAutomationRunning = false;
  }
}

async function createWorkerBillingInvoice(setting: any, periodStart: Date, periodEnd: Date): Promise<any> {
  const [extensions, phoneNumbers] = await Promise.all([
    (db as any).extension.findMany({ where: { tenantId: setting.tenantId, status: "ACTIVE", billable: true } }),
    (db as any).phoneNumber.findMany({ where: { tenantId: setting.tenantId, status: "ACTIVE" } }),
  ]);
  const billableExtensions = extensions.filter((ext: any) => /^\d{3}$/.test(String(ext.extNumber || "")) && !/\b(pbx user|invite lifecycle|system|provision|smoke|test)\b/i.test(String(ext.displayName || "")));
  const extensionAmount = billableExtensions.length * Number(setting.extensionPriceCents || 3000);
  const additionalNumbers = Math.max(0, phoneNumbers.length - (setting.firstPhoneNumberFree === false ? 0 : 1));
  const numberAmount = additionalNumbers * Number(setting.additionalPhoneNumberPriceCents || 1000);
  const smsAmount = setting.smsBillingEnabled ? Number(setting.smsPriceCents || 1000) : 0;
  const subtotal = extensionAmount + numberAmount + smsAmount;
  const salesTax = setting.taxEnabled && setting.taxProfile ? Math.round(subtotal * Number(setting.taxProfile.salesTaxRate || 0)) : 0;
  const e911 = setting.taxEnabled && setting.taxProfile ? billableExtensions.length * Number(setting.taxProfile.e911FeePerExtension || 0) : 0;
  const regulatory = setting.taxEnabled && setting.taxProfile?.regulatoryFeeEnabled !== false ? Math.round(subtotal * Number(setting.taxProfile?.regulatoryFeePercent || 0)) : 0;
  const tax = salesTax + e911 + regulatory;
  const dueDate = new Date();
  dueDate.setUTCDate(dueDate.getUTCDate() + Number(setting.paymentTermsDays || 15));
  const lineItems = [
    extensionAmount > 0 ? { tenantId: setting.tenantId, type: "EXTENSION", description: "Billable extensions", quantity: billableExtensions.length, unitPriceCents: Number(setting.extensionPriceCents || 3000), amountCents: extensionAmount, taxable: true } : null,
    numberAmount > 0 ? { tenantId: setting.tenantId, type: "PHONE_NUMBER", description: "Additional phone numbers", quantity: additionalNumbers, unitPriceCents: Number(setting.additionalPhoneNumberPriceCents || 1000), amountCents: numberAmount, taxable: true } : null,
    smsAmount > 0 ? { tenantId: setting.tenantId, type: "SMS_PACKAGE", description: "SMS package", quantity: 1, unitPriceCents: smsAmount, amountCents: smsAmount, taxable: true } : null,
    salesTax > 0 ? { tenantId: setting.tenantId, type: "SALES_TAX", description: "Sales tax", quantity: 1, unitPriceCents: salesTax, amountCents: salesTax, taxable: false } : null,
    e911 > 0 ? { tenantId: setting.tenantId, type: "E911_FEE", description: "E911 fee", quantity: billableExtensions.length, unitPriceCents: Number(setting.taxProfile.e911FeePerExtension || 0), amountCents: e911, taxable: false } : null,
    regulatory > 0 ? { tenantId: setting.tenantId, type: "REGULATORY_FEE", description: "Regulatory recovery fee", quantity: 1, unitPriceCents: regulatory, amountCents: regulatory, taxable: false } : null,
  ].filter(Boolean);
  return (db as any).billingInvoice.create({
    data: {
      tenantId: setting.tenantId,
      invoiceNumber: await nextBillingInvoiceNumber(setting.tenantId),
      status: "OPEN",
      periodStart,
      periodEnd,
      dueDate,
      subtotalCents: subtotal,
      taxCents: tax,
      totalCents: subtotal + tax,
      balanceDueCents: subtotal + tax,
      lineItems: { create: lineItems },
    },
    include: { lineItems: true },
  });
}

async function chargeWorkerInvoice(invoice: any, method: any, runId: string): Promise<any> {
  const token = decryptJson<string>(method.tokenEncrypted);
  const adapter = await getWorkerSolaAdapterForTenant(invoice.tenantId);
  const response = await adapter.chargeToken({ token, amountCents: invoice.balanceDueCents || invoice.totalCents, invoice: invoice.invoiceNumber, idempotencyKey: `worker:${invoice.id}:${Date.now()}` });
  const transaction = await (db as any).paymentTransaction.create({
    data: {
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      paymentMethodId: method.id,
      amountCents: invoice.balanceDueCents || invoice.totalCents,
      status: response.approved ? "APPROVED" : response.status === "DECLINED" ? "DECLINED" : "ERROR",
      processorTransactionId: response.xRefNum,
      responseCode: response.xResult,
      responseMessage: response.xError || response.xStatus,
      rawResponseSafeJson: response.safePayload,
      idempotencyKey: `worker:${invoice.id}:${response.xRefNum || Date.now()}`,
    },
  });
  await (db as any).billingInvoice.update({ where: { id: invoice.id }, data: response.approved ? { status: "PAID", amountPaidCents: invoice.totalCents, balanceDueCents: 0, paidAt: new Date(), paymentMethodId: method.id } : { status: "FAILED", failedAt: new Date(), paymentMethodId: method.id } });
  await (db as any).billingEventLog.create({ data: { tenantId: invoice.tenantId, invoiceId: invoice.id, runId, type: response.approved ? "payment.approved" : "payment.failed", metadata: { transactionId: transaction.id } } });
  if (!response.approved) {
    await (db as any).alert.create({ data: { tenantId: invoice.tenantId, severity: "HIGH", category: "BILLING", message: `Payment failed for invoice ${invoice.invoiceNumber}`, metadata: { invoiceId: invoice.id, transactionId: transaction.id } } }).catch(() => null);
  }
  return transaction;
}

setInterval(() => {
  runMonthlyBillingAutomation().catch((err) => console.error("monthly billing cycle failed", err?.message || err));
}, 60 * 60 * 1000);

runMonthlyBillingAutomation().catch((err) => console.error("initial monthly billing cycle failed", err?.message || err));
