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
  WirePbxClient
} from "@connect/integrations";

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

  const title = input.payload.type === "INCOMING_CALL"
    ? "Incoming call"
    : input.payload.type === "INVITE_CANCELED"
      ? "Call ended"
      : "Missed call";
  const body = input.payload.type === "INCOMING_CALL"
    ? `Call from ${input.payload.fromNumber}`
    : input.payload.type === "INVITE_CANCELED"
      ? "This call has ended."
      : `Missed call from ${input.payload.fromNumber}`;

  const messages = devices.map((d) => ({
    to: d.expoPushToken,
    sound: "default",
    title,
    body,
    data: input.payload
  }));

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (expoPushAccessToken) headers.authorization = `Bearer ${expoPushAccessToken}`;

  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers,
    body: JSON.stringify(messages)
  });

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
      disposition
    },
    update: { disposition }
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
}, 30 * 1000);

setInterval(() => {
  runPbxActiveCallPollCycle().catch((err) => console.error("pbx active call poll failed", err?.message || err));
}, 5 * 1000);

setInterval(() => {
  runVoiceDiagAlertCycle().catch((err) => console.error("voice diag alert cycle failed", err?.message || err));
}, 5 * 60 * 1000);

setInterval(() => {
  runTurnValidationMaintenanceCycle().catch((err) => console.error("turn validation maintenance failed", err?.message || err));
}, 5 * 60 * 1000);

runCallInviteExpiryCycle().catch((err) => console.error("initial call invite expiry failed", err?.message || err));
runVoiceDiagAlertCycle().catch((err) => console.error("initial voice diag alert cycle failed", err?.message || err));
runTurnValidationMaintenanceCycle().catch((err) => console.error("initial turn validation maintenance failed", err?.message || err));
runPbxActiveCallPollCycle().catch((err) => console.error("initial pbx active call poll failed", err?.message || err));

runPbxJobCycle().catch((err) => console.error("initial pbx job cycle failed", err?.message || err));
runPbxCdrSyncCycle().catch((err) => console.error("initial pbx cdr sync failed", err?.message || err));
