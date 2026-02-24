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

async function enforceThrottle(tenantId: string) {
  const now = Date.now();

  const globalMinIntervalMs = 200;
  const globalWait = Math.max(0, globalMinIntervalMs - (now - lastGlobalSend));
  if (globalWait > 0) await sleep(globalWait);

  const tenantMinIntervalMs = 1000;
  const tenantLast = tenantLastSend.get(tenantId) || 0;
  const tenantWait = Math.max(0, tenantMinIntervalMs - (Date.now() - tenantLast));
  if (tenantWait > 0) await sleep(tenantWait);

  const mark = Date.now();
  tenantLastSend.set(tenantId, mark);
  lastGlobalSend = mark;
}

async function enforceDailyCap(tenantId: string) {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
  const cap = tenant?.smsDailyCap ?? 100;

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const sentToday = await db.smsMessage.count({
    where: {
      campaign: { tenantId },
      status: { in: ["SENT", "DELIVERED"] },
      sentAt: { gte: start }
    }
  });

  if (sentToday >= cap) {
    throw new Error(`Daily cap reached for tenant ${tenantId}: ${cap}`);
  }
}

const worker = new Worker(
  "sms-send",
  async (job) => {
    const payload = job.data as { messageId: string; tenantId: string };
    const msg = await db.smsMessage.findUnique({ where: { id: payload.messageId }, include: { campaign: true } });
    if (!msg) return;

    await db.smsMessage.update({ where: { id: msg.id }, data: { status: "SENDING" } });

    try {
      await enforceDailyCap(payload.tenantId);
      await enforceThrottle(payload.tenantId);

      const sent = await smsProvider.sendMessage({
        tenantId: payload.tenantId,
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
          tenantId: payload.tenantId,
          action: "SMS_MESSAGE_SENT",
          entityType: "SmsMessage",
          entityId: msg.id
        }
      });

      await db.smsCampaign.updateMany({ where: { id: msg.campaignId }, data: { status: "SENDING" } });
    } catch (err: any) {
      await db.smsMessage.update({
        where: { id: msg.id },
        data: {
          status: "FAILED",
          error: err?.message || "unknown worker error"
        }
      });
      await db.auditLog.create({
        data: {
          tenantId: payload.tenantId,
          action: "SMS_MESSAGE_FAILED",
          entityType: "SmsMessage",
          entityId: msg.id
        }
      });
      throw err;
    }

    const remaining = await db.smsMessage.count({ where: { campaignId: msg.campaignId, status: { in: ["QUEUED", "SENDING"] } } });
    if (remaining === 0) {
      await db.smsCampaign.update({ where: { id: msg.campaignId }, data: { status: "SENT" } });
    }
  },
  { connection: redis, concurrency: 5 }
);

worker.on("completed", (job) => console.log(`sms job completed: ${job.id}`));
worker.on("failed", (job, err) => console.error(`sms job failed: ${job?.id} -> ${err.message}`));

console.log("SMS worker started");
