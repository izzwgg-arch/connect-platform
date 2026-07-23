// Delivery SMS routes (Phase 7). INTERNAL/TEST endpoints only — secret-gated, not wired to the
// live VoIP.ms/Twilio inbound webhook. Production activation (real send + inbound webhook hook)
// is a separate, explicitly-approved step. This lets the SMS flows be exercised end-to-end in a
// test environment without sending real customer messages.

import { verifyOrderSourceSecret } from "./guard";
import { notifyOrder, handleInboundSms } from "./smsService";
import type { NotificationTrigger } from "./smsTemplates";

const TRIGGERS: NotificationTrigger[] = ["out_for_delivery", "approaching", "delayed", "delivered", "failed", "rescheduled"];

export async function registerDeliverySmsRoutes(app: any): Promise<void> {
  // Simulate an outbound notification (records in TEST mode; no real send unless DELIVERY_SMS_LIVE=1).
  app.post("/internal/delivery/sms/notify", async (req: any, reply: any) => {
    if (!verifyOrderSourceSecret(req)) return reply.status(401).send({ error: "unauthorized" });
    const tenantId = String(req.headers?.["x-tenant-id"] || req.body?.tenantId || "");
    const orderId = String(req.body?.orderId || "");
    const trigger = String(req.body?.trigger || "") as NotificationTrigger;
    if (!tenantId || !orderId || !TRIGGERS.includes(trigger)) return reply.status(400).send({ error: "bad_request" });
    return reply.send(await notifyOrder(tenantId, orderId, trigger, String(req.body?.storeName || "Delivery")));
  });

  // Simulate an inbound customer SMS and return the reply the system would send.
  app.post("/internal/delivery/sms/inbound", async (req: any, reply: any) => {
    if (!verifyOrderSourceSecret(req)) return reply.status(401).send({ error: "unauthorized" });
    const tenantId = String(req.headers?.["x-tenant-id"] || req.body?.tenantId || "");
    const from = String(req.body?.from || "");
    const body = String(req.body?.body || "");
    if (!tenantId || !from) return reply.status(400).send({ error: "bad_request" });
    return reply.send(await handleInboundSms(tenantId, from, body, String(req.body?.storeName || "Delivery")));
  });
}
