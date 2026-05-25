import IORedis from "ioredis";
import { Queue } from "bullmq";
import { WHATSAPP_INBOUND_QUEUE, WHATSAPP_STATUS_QUEUE } from "@connect/shared/src/queues";

let redis: IORedis | null = null;
function getRedis(): IORedis {
  if (redis) return redis;
  redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
  return redis;
}

let inboundQueue: Queue | null = null;
let statusQueue: Queue | null = null;

export function getWhatsAppInboundQueue(): Queue {
  if (inboundQueue) return inboundQueue;
  inboundQueue = new Queue(WHATSAPP_INBOUND_QUEUE, { connection: getRedis() as any });
  return inboundQueue;
}

export function getWhatsAppStatusQueue(): Queue {
  if (statusQueue) return statusQueue;
  statusQueue = new Queue(WHATSAPP_STATUS_QUEUE, { connection: getRedis() as any });
  return statusQueue;
}
