import { Worker, Job } from "bullmq";
import IORedis from "ioredis";
import { WHATSAPP_STATUS_QUEUE } from "@connect/shared/src/queues";
import type { WaStatusEvent } from "@connect/shared/src/whatsappTypes";

export function registerWhatsAppStatusWorker(): void {
  const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
  const worker = new Worker(
    WHATSAPP_STATUS_QUEUE,
    async (job: Job) => {
      const ev = job.data as WaStatusEvent;
      const safe = {
        tenantId: ev?.tenantId,
        provider: ev?.provider,
        type: ev?.type,
        hasExternalId: !!ev?.externalMessageId,
        status: ev?.status,
      };
      console.info(JSON.stringify({ event: "WA_STATUS_JOB", summary: safe }));
      return { ok: true };
    },
    { connection: redis as any },
  );
  worker.on("error", (err) => {
    console.warn("whatsapp status worker error", err?.message || err);
  });
}
