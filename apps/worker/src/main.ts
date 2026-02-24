import { Worker } from "bullmq";
import IORedis from "ioredis";
import { db } from "@connect/db";
import { getSmsProvider } from "@connect/integrations";

const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const smsProvider = getSmsProvider();

const tenantLastSend = new Map<string, number>();
let lastGlobalSend = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enforceThrottle(tenantId: string, perSecondRate: number) {
  const now = Date.now();

  const globalMinIntervalMs = 200;
  const globalWait = Math.max(0, globalMinIntervalMs - (now - lastGlobalSend));
  if (globalWait > 0) await sleep(globalWait);

  const safeRate = perSecondRate > 0 ? perSecondRate : 1.0;
  const tenantMinIntervalMs = Math.max(1, Math.floor(1000 / safeRate));
  const tenantLast = tenantLastSend.get(tenantId) || 0;
  const tenantWait = Math.max(0, tenantMinIntervalMs - (Date.now() - tenantLast));
  if (tenantWait > 0) await sleep(tenantWait);

  const mark = Date.now();
  tenantLastSend.set(tenantId, mark);
  lastGlobalSend = mark;
}

async function enforceDailyCap(tenantId: string, dailySmsCap: number) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const sentOrQueuedToday = await db.smsMessage.count({
    where: {
      campaign: { tenantId },
      status: { in: ["QUEUED", "SENDING", "SENT", "DELIVERED"] },
      createdAt: { gte: start }
    }
  });

  if (sentOrQueuedToday > dailySmsCap) {
    throw new Error(`Daily cap exceeded for tenant ${tenantId}: cap=${dailySmsCap}, current=${sentOrQueuedToday}`);
  }
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
    const msg = await db.smsMessage.findUnique({
      where: { id: payload.messageId },
      include: { campaign: { include: { tenant: true } } }
    });
    if (!msg) return;

    const campaign = msg.campaign;
    const tenant = campaign.tenant;

    if (!tenant.isApproved) {
      await db.smsCampaign.update({
        where: { id: campaign.id },
        data: { status: "PAUSED", holdReason: "Tenant unapproved during processing." }
      });
      await db.smsMessage.update({
        where: { id: msg.id },
        data: { status: "FAILED", error: "Tenant unapproved during processing." }
      });
      await db.auditLog.create({
        data: {
          tenantId: tenant.id,
          action: "SMS_CAMPAIGN_PAUSED_TENANT_UNAPPROVED",
          entityType: "SmsCampaign",
          entityId: campaign.id
        }
      });
      return;
    }

    await db.smsMessage.update({ where: { id: msg.id }, data: { status: "SENDING", error: null } });
    await db.smsCampaign.updateMany({ where: { id: campaign.id, status: { notIn: ["PAUSED", "FAILED"] } }, data: { status: "SENDING" } });

    try {
      await enforceDailyCap(tenant.id, tenant.dailySmsCap);
      await enforceThrottle(tenant.id, tenant.perSecondRate);

      const sent = await smsProvider.sendMessage({
        tenantId: tenant.id,
        to: msg.toNumber,
        from: msg.fromNumber,
        body: msg.body,
        idempotencyKey: msg.id
      });

      await db.smsMessage.update({
        where: { id: msg.id },
        data: {
          status: "SENT",
          providerMessageId: sent.providerMessageId || null,
          sentAt: new Date(),
          error: null
        }
      });

      await db.auditLog.create({
        data: {
          tenantId: tenant.id,
          action: "SMS_MESSAGE_SENT",
          entityType: "SmsMessage",
          entityId: msg.id
        }
      });
    } catch (err: any) {
      const attempts = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
      const thisAttempt = (job.attemptsMade || 0) + 1;
      const finalAttempt = thisAttempt >= attempts;

      if (finalAttempt) {
        await db.smsMessage.update({
          where: { id: msg.id },
          data: { status: "FAILED", error: err?.message || "unknown worker error" }
        });
        await db.auditLog.create({
          data: {
            tenantId: tenant.id,
            action: "SMS_MESSAGE_FAILED_FINAL",
            entityType: "SmsMessage",
            entityId: msg.id
          }
        });
      } else {
        await db.smsMessage.update({
          where: { id: msg.id },
          data: { status: "QUEUED", error: `retrying: ${err?.message || "unknown"}` }
        });
        await db.auditLog.create({
          data: {
            tenantId: tenant.id,
            action: "SMS_MESSAGE_RETRY_SCHEDULED",
            entityType: "SmsMessage",
            entityId: msg.id
          }
        });
      }

      await finalizeCampaignStatus(campaign.id);
      throw err;
    }

    await finalizeCampaignStatus(campaign.id);
  },
  { connection: redis, concurrency: 5 }
);

worker.on("completed", (job) => console.log(`sms job completed: ${job.id}`));
worker.on("failed", (job, err) => console.error(`sms job failed: ${job?.id} -> ${err.message}`));

console.log("SMS worker started");
