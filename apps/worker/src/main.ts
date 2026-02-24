import { randomUUID } from "crypto";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { FakeSmsProvider, SmsProvider, TwilioCredentials, TwilioSmsProvider } from "@connect/integrations";

const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const smsQueue = new Queue("sms-send", { connection: redis });

const providerCache = new Map<string, { provider: SmsProvider; expiresAt: number }>();
const providerCacheTtlMs = 60_000;
const smsProviderTestMode = (process.env.SMS_PROVIDER_TEST_MODE || "true").toLowerCase() !== "false";

const tokenBuckets = new Map<string, { tokens: number; lastRefillMs: number }>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getTenantSmsProvider(tenantId: string): Promise<SmsProvider> {
  const cached = providerCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.provider;
  }

  const twilioCred = await db.providerCredential.findUnique({ where: { tenantId_provider: { tenantId, provider: "TWILIO" } } });

  if (!twilioCred || !twilioCred.isEnabled) {
    const fake = new FakeSmsProvider();
    providerCache.set(tenantId, { provider: fake, expiresAt: Date.now() + providerCacheTtlMs });
    return fake;
  }

  try {
    const decrypted = decryptJson<TwilioCredentials>(twilioCred.credentialsEncrypted);
    if (!decrypted.accountSid || !decrypted.authToken || (!decrypted.messagingServiceSid && !decrypted.fromNumber)) {
      throw new Error("incomplete_credentials");
    }
    const twilio = new TwilioSmsProvider(decrypted, smsProviderTestMode);
    providerCache.set(tenantId, { provider: twilio, expiresAt: Date.now() + providerCacheTtlMs });
    return twilio;
  } catch {
    await db.auditLog.create({
      data: {
        tenantId,
        action: "SMS_PROVIDER_FALLBACK_FAKE",
        entityType: "ProviderCredential",
        entityId: twilioCred.id,
        provider: "TWILIO"
      }
    });
    const fake = new FakeSmsProvider();
    providerCache.set(tenantId, { provider: fake, expiresAt: Date.now() + providerCacheTtlMs });
    return fake;
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
    if (msg.status === "FAILED" || (msg.providerStatus || "").toLowerCase() === "undelivered") {
      failed += 1;
    }
  }

  if (total === 0) return false;
  return failed > 30 && failed / total > 0.4;
}

async function suspendTenant(tenantId: string, reason: string, actorEntityId: string) {
  await db.tenant.update({
    where: { id: tenantId },
    data: {
      smsSuspended: true,
      smsSuspendedReason: reason,
      smsSuspendedAt: new Date()
    }
  });
  await db.auditLog.create({
    data: {
      tenantId,
      action: "SMS_TENANT_SUSPENDED",
      entityType: "Tenant",
      entityId: actorEntityId
    }
  });
}

async function finalizeCampaignStatus(campaignId: string) {
  const remaining = await db.smsMessage.count({ where: { campaignId, status: { in: ["QUEUED", "SENDING"] } } });
  if (remaining > 0) return;
  const failedCount = await db.smsMessage.count({ where: { campaignId, status: "FAILED" } });
  const nextStatus = failedCount > 0 ? "FAILED" : "SENT";
  await db.smsCampaign.update({ where: { id: campaignId }, data: { status: nextStatus } });
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
            lastProviderUpdateAt: now,
            sentAt: now,
            error: null
          }
        });
        await db.auditLog.create({ data: { tenantId: tenant.id, action: "SMS_MESSAGE_SIMULATED", entityType: "SmsMessage", entityId: msg.id } });
      } else {
        const provider = await getTenantSmsProvider(tenant.id);
        const sent = await provider.sendMessage({ tenantId: tenant.id, to: msg.toNumber, from: msg.fromNumber, body: msg.body, idempotencyKey: msg.id });
        await db.smsMessage.update({
          where: { id: msg.id },
          data: {
            status: "SENT",
            providerMessageId: sent.providerMessageId || null,
            providerStatus: "sent",
            lastProviderUpdateAt: new Date(),
            sentAt: new Date(),
            error: null
          }
        });
        await db.auditLog.create({ data: { tenantId: tenant.id, action: "SMS_MESSAGE_SENT", entityType: "SmsMessage", entityId: msg.id } });
      }
    } catch (err: any) {
      const attempts = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
      const thisAttempt = (job.attemptsMade || 0) + 1;
      const finalAttempt = thisAttempt >= attempts;

      if (finalAttempt) {
        await db.smsMessage.update({
          where: { id: msg.id },
          data: {
            status: "FAILED",
            error: err?.message || "unknown worker error",
            providerStatus: "failed",
            lastProviderUpdateAt: new Date(),
            deliveryUpdatedAt: new Date()
          }
        });
        await db.auditLog.create({ data: { tenantId: tenant.id, action: "SMS_MESSAGE_FAILED_FINAL", entityType: "SmsMessage", entityId: msg.id } });
      } else {
        await db.smsMessage.update({ where: { id: msg.id }, data: { status: "QUEUED", error: `retrying: ${err?.message || "unknown"}` } });
        await db.auditLog.create({ data: { tenantId: tenant.id, action: "SMS_MESSAGE_RETRY_SCHEDULED", entityType: "SmsMessage", entityId: msg.id } });
      }
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
