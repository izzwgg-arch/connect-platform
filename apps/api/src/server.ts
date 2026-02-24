import Fastify from "fastify";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { db } from "@connect/db";
import { FakeNumberProvider } from "@connect/integrations";
import { tenDlcSubmissionSchema, validateCampaignMessage } from "./validation";

const app = Fastify({ logger: true });
const numberProvider = new FakeNumberProvider();

app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
app.register(jwt, { secret: process.env.JWT_SECRET || "change-me" });

const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const smsQueue = new Queue("sms-send", { connection: redis });

type JwtUser = { sub: string; tenantId: string; email: string; role: string };

function encodeEin(rawEin: string): string {
  return Buffer.from(rawEin, "utf8").toString("base64");
}

async function audit(tenantId: string, action: string, entityType: string, entityId: string) {
  await db.auditLog.create({ data: { tenantId, action, entityType, entityId } });
}

function getUser(req: any): JwtUser {
  return req.user as JwtUser;
}

async function requireAdmin(req: any, reply: any): Promise<JwtUser | null> {
  const user = getUser(req);
  if (user.role !== "ADMIN") {
    reply.status(403).send({ error: "forbidden" });
    return null;
  }
  return user;
}

app.get("/health", async () => ({ ok: true }));

const signupSchema = z.object({
  tenantName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8)
});

app.post("/auth/signup", async (req, reply) => {
  const input = signupSchema.parse(req.body);
  const tenant = await db.tenant.create({ data: { name: input.tenantName } });
  const passwordHash = await bcrypt.hash(input.password, 10);
  const role = input.email.toLowerCase() === "support@connectcomunications.com" ? "ADMIN" : "OWNER";
  const user = await db.user.create({
    data: { tenantId: tenant.id, email: input.email, passwordHash, role }
  });
  const token = await reply.jwtSign({ sub: user.id, tenantId: tenant.id, email: user.email, role: user.role });
  return { token, user: { id: user.id, email: user.email, role: user.role }, tenant: { id: tenant.id, name: tenant.name } };
});

app.post("/auth/login", async (req, reply) => {
  const input = z.object({ email: z.string().email(), password: z.string().min(8) }).parse(req.body);
  const user = await db.user.findUnique({ where: { email: input.email } });
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
    return reply.status(401).send({ error: "invalid_credentials" });
  }
  const token = await reply.jwtSign({ sub: user.id, tenantId: user.tenantId, email: user.email, role: user.role });
  return { token };
});

app.addHook("preHandler", async (req, reply) => {
  if (["/health", "/auth/signup", "/auth/login", "/webhooks/twilio/sms-status"].includes(req.url)) return;
  try {
    await req.jwtVerify();
  } catch {
    return reply.status(401).send({ error: "unauthorized" });
  }
});

app.get("/me", async (req) => {
  const user = getUser(req);
  return { id: user.sub, tenantId: user.tenantId, email: user.email, role: user.role };
});

app.post("/ten-dlc/submit", async (req) => {
  const user = getUser(req);
  const input = tenDlcSubmissionSchema.parse(req.body);

  const created = await db.tenDlcSubmission.create({
    data: {
      tenantId: user.tenantId,
      legalName: input.legalName,
      dba: input.dba || null,
      einEncrypted: encodeEin(input.ein),
      businessType: input.businessType,
      websiteUrl: input.websiteUrl,
      addressStreet: input.businessAddress.street,
      addressCity: input.businessAddress.city,
      addressState: input.businessAddress.state,
      addressPostalCode: input.businessAddress.zip,
      addressCountry: input.businessAddress.country,
      supportEmail: input.supportEmail,
      supportPhone: input.supportPhone,
      useCaseCategory: input.useCaseCategory,
      sampleMessage1: input.messageSamples[0],
      sampleMessage2: input.messageSamples[1],
      sampleMessage3: input.messageSamples[2],
      optInMethod: input.optInMethod,
      optInWorkflow: input.optInWorkflowDescription,
      optInProofUrl: input.optInProofUrl || null,
      messagesPerDay: input.volumeEstimate.messagesPerDay,
      messagesPerMonth: input.volumeEstimate.messagesPerMonth,
      includesEmbeddedLinks: input.includesEmbeddedLinks,
      includesPhoneNumbers: input.includesEmbeddedPhoneNumbers,
      includesAffiliateMktg: input.includesAffiliateMarketing,
      ageGatedContent: input.ageGatedContent,
      termsAccepted: input.termsAccepted,
      signatureName: input.signatureName,
      signatureDate: new Date(input.signatureDate),
      status: "SUBMITTED",
      submittedAt: new Date()
    }
  });

  await audit(user.tenantId, "TEN_DLC_SUBMIT", "TenDlcSubmission", created.id);
  return created;
});

app.get("/ten-dlc/status", async (req) => {
  const user = getUser(req);
  return db.tenDlcSubmission.findFirst({ where: { tenantId: user.tenantId }, orderBy: { createdAt: "desc" } });
});

app.get("/admin/ten-dlc/submissions", async (req, reply) => {
  const user = await requireAdmin(req, reply);
  if (!user) return;
  const query = z.object({ status: z.enum(["DRAFT", "SUBMITTED", "NEEDS_INFO", "APPROVED", "REJECTED"]).optional() }).parse(req.query || {});
  return db.tenDlcSubmission.findMany({
    where: query.status ? { status: query.status } : undefined,
    orderBy: { createdAt: "desc" }
  });
});

app.get("/admin/ten-dlc/submissions/:id", async (req, reply) => {
  const user = await requireAdmin(req, reply);
  if (!user) return;
  const { id } = req.params as { id: string };
  return db.tenDlcSubmission.findUnique({ where: { id } });
});

app.post("/admin/ten-dlc/submissions/:id/status", async (req, reply) => {
  const user = await requireAdmin(req, reply);
  if (!user) return;
  const { id } = req.params as { id: string };
  const input = z.object({
    status: z.enum(["NEEDS_INFO", "APPROVED", "REJECTED"]),
    note: z.string().min(2)
  }).parse(req.body);

  const updated = await db.tenDlcSubmission.update({
    where: { id },
    data: { status: input.status, internalNotes: input.note, reviewedAt: new Date() }
  });

  await audit(updated.tenantId, `TEN_DLC_STATUS_${input.status}`, "TenDlcSubmission", id);
  return updated;
});

app.post("/sms/campaigns", async (req, reply) => {
  const user = getUser(req);
  const input = z.object({
    name: z.string().min(2),
    fromNumber: z.string().min(7),
    message: z.string().min(3).max(320),
    audienceType: z.string().default("manual"),
    recipients: z.array(z.string().min(8)).min(1)
  }).parse(req.body);

  const compliance = validateCampaignMessage(input.message);
  if (!compliance.ok) {
    return reply.status(400).send({ error: compliance.reason });
  }

  const campaign = await db.smsCampaign.create({
    data: {
      tenantId: user.tenantId,
      name: input.name,
      message: input.message,
      fromNumber: input.fromNumber,
      audienceType: input.audienceType,
      status: "QUEUED"
    }
  });

  const createdMessages = await Promise.all(
    input.recipients.map((to) =>
      db.smsMessage.create({
        data: {
          campaignId: campaign.id,
          toNumber: to,
          fromNumber: input.fromNumber,
          body: input.message,
          status: "QUEUED"
        }
      })
    )
  );

  for (const msg of createdMessages) {
    await smsQueue.add("send", { messageId: msg.id, tenantId: user.tenantId }, { removeOnComplete: true, attempts: 3 });
  }

  await audit(user.tenantId, "SMS_CAMPAIGN_CREATED", "SmsCampaign", campaign.id);
  return { campaign, queuedMessages: createdMessages.length };
});

app.get("/sms/campaigns", async (req) => {
  const user = getUser(req);
  return db.smsCampaign.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: "desc" } });
});

app.get("/sms/campaigns/:id", async (req) => {
  const user = getUser(req);
  const { id } = req.params as { id: string };
  return db.smsCampaign.findFirst({ where: { id, tenantId: user.tenantId }, include: { messages: true } });
});

app.get("/sms/messages", async (req) => {
  const user = getUser(req);
  const query = z.object({ campaignId: z.string().optional() }).parse(req.query || {});
  return db.smsMessage.findMany({
    where: query.campaignId
      ? { campaignId: query.campaignId, campaign: { tenantId: user.tenantId } }
      : { campaign: { tenantId: user.tenantId } },
    orderBy: { createdAt: "desc" }
  });
});

app.post("/webhooks/twilio/sms-status", async (req) => {
  // Placeholder signature validation structure; wire real signature verification in next pass.
  const body = req.body as Record<string, string>;
  const sid = body.MessageSid;
  const status = body.MessageStatus;
  if (!sid || !status) return { ok: true };

  const mapped = status === "delivered" ? "DELIVERED" : status === "failed" ? "FAILED" : "SENT";
  await db.smsMessage.updateMany({ where: { providerMessageId: sid }, data: { status: mapped as any } });
  return { ok: true };
});

app.post("/numbers/search", async (req) => {
  const input = z.object({ areaCode: z.string().optional(), type: z.string().optional() }).parse(req.body);
  return numberProvider.searchNumbers(input);
});

app.post("/numbers/purchase", async (req) => {
  const user = getUser(req);
  const input = z.object({ e164: z.string() }).parse(req.body);
  const provider = await numberProvider.purchaseNumber({ e164: input.e164, tenantId: user.tenantId });
  const record = await db.phoneNumber.create({ data: { tenantId: user.tenantId, e164: input.e164, status: "purchased" } });
  return { provider, record };
});

const port = Number(process.env.PORT || 3001);
app.listen({ host: "0.0.0.0", port }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});
