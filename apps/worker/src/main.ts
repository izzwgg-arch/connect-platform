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
  VoipMsSmsProvider
} from "@connect/integrations";

const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const smsQueue = new Queue("sms-send", { connection: redis });

const providerCache = new Map<string, { provider: SmsProvider; expiresAt: number }>();
const providerCacheTtlMs = 60_000;
const smsProviderTestMode = (process.env.SMS_PROVIDER_TEST_MODE || "true").toLowerCase() !== "false";
const tokenBuckets = new Map<string, { tokens: number; lastRefillMs: number }>();

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
