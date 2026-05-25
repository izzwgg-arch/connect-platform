import { Worker, Job } from "bullmq";
import IORedis from "ioredis";
import { WHATSAPP_INBOUND_QUEUE } from "@connect/shared/src/queues";
import type { WaInboundMessageEvent } from "@connect/shared/src/whatsappTypes";
import { projectInboundToConnectChat } from "./whatsappProject";

export function registerWhatsAppInboundWorker(): void {
  const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
  const worker = new Worker(
    WHATSAPP_INBOUND_QUEUE,
    async (job: Job) => {
      const ev = job.data as WaInboundMessageEvent;
      const safe = {
        tenantId: ev?.tenantId,
        provider: ev?.provider,
        type: ev?.type,
        hasExternalId: !!ev?.externalMessageId,
      };
      console.info(JSON.stringify({ event: "WA_INBOUND_JOB", summary: safe }));
      const enabled = String(process.env.WHATSAPP_PROJECT_TO_CONNECT_CHAT_ENABLED || "false").toLowerCase() === "true";
      if (!enabled) return { ok: true };
      await projectInboundToConnectChat(ev);
      return { ok: true, projected: true };
    },
    { connection: redis as any },
  );
  worker.on("error", (err) => {
    console.warn("whatsapp inbound worker error", err?.message || err);
  });
}
