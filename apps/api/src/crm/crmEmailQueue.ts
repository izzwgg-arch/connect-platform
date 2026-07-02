import { Queue } from "bullmq";
import { createRedisConnection, quietMissingRedisInDev } from "../redis";

const redis = createRedisConnection({
  lazyConnect: true,
});

export const crmEmailSendQueue = quietMissingRedisInDev(new Queue("crm-email-send", { connection: redis }));

export type CrmEmailSendJob = {
  tenantId: string;
  userId: string;
  connectionId: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  contactId?: string | null;
  templateId?: string | null;
  attachmentIds?: string[] | null;
  ccEmail?: string | null;
  ccSelf?: boolean;
};

export async function queueCrmEmailSend(job: CrmEmailSendJob) {
  return crmEmailSendQueue.add("send", job, { removeOnComplete: 100, removeOnFail: 100 });
}
