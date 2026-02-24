import Fastify from "fastify";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { db } from "@connect/db";
import { FakeNumberProvider } from "@connect/integrations";
import { assessSmsRisk, normalizeSmsWithStop, tenDlcSubmissionSchema } from "./validation";

const app = Fastify({ logger: true });
const numberProvider = new FakeNumberProvider();

app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
app.register(jwt, { secret: process.env.JWT_SECRET || "change-me" });

const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const smsQueue = new Queue("sms-send", { connection: redis });

type JwtUser = { sub: string; tenantId: string; email: string; role: string };

type CampaignDecision = {
  status: "QUEUED" | "NEEDS_APPROVAL";
  requiresApproval: boolean;
  holdReason: string | null;
  riskScore: number;
  normalizedMessage: string;
};

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

async function enqueueCampaignMessages(campaignId: string, tenantId: string) {
  const messages = await db.smsMessage.findMany({ where: { campaignId } });
  for (const msg of messages) {
    await db.smsMessage.update({ where: { id: msg.id }, data: { status: "QUEUED", error: null } });
    await smsQueue.add("send", { messageId: msg.id, tenantId }, { removeOnComplete: true, attempts: 3 });
  }
}

async function dailyUsageCount(tenantId: string): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return db.smsMessage.count({
    where: {
      campaign: { tenantId },
      status: { in: ["QUEUED", "SENDING", "SENT"] },
      createdAt: { gte: start }
    }
  });
}

async function decideCampaignPolicy(params: {
  tenant: any;
  tenantId: string;
  message: string;
  recipientsCount: number;
}): Promise<CampaignDecision | { reject: string }> {
  const { tenant, tenantId, message, recipientsCount } = params;

  const normalized = normalizeSmsWithStop(message);
  if (!normalized.ok) {
    await audit(tenantId, "SMS_ENFORCE_STOP_APPEND_TOO_LONG", "Tenant", tenantId);
    return {
      status: "NEEDS_APPROVAL",
      requiresApproval: true,
      holdReason: "STOP instruction required but message would exceed 160 characters. Manual review required.",
      riskScore: 45,
      normalizedMessage: message
    };
  }

  if (normalized.appendedStop) {
    await audit(tenantId, "SMS_STOP_INSTRUCTION_APPENDED", "Tenant", tenantId);
  }

  const usage = await dailyUsageCount(tenantId);
  if (usage + recipientsCount > tenant.dailySmsCap) {
    await audit(tenantId, "SMS_DAILY_CAP_REJECTED", "Tenant", tenantId);
    return { reject: `Daily SMS cap exceeded: cap=${tenant.dailySmsCap}, current=${usage}, requested=${recipientsCount}` };
  }

  const risk = assessSmsRisk(normalized.message);
  if (risk.riskScore >= 70) {
    await audit(tenantId, "SMS_RISK_REQUIRES_APPROVAL", "Tenant", tenantId);
    return {
      status: "NEEDS_APPROVAL",
      requiresApproval: true,
      holdReason: `Risk score ${risk.riskScore}: ${risk.reasons.join(", ")}`,
      riskScore: risk.riskScore,
      normalizedMessage: normalized.message
    };
  }

  if (!tenant.isApproved) {
    await audit(tenantId, "SMS_TENANT_NOT_APPROVED", "Tenant", tenantId);
    return {
      status: "NEEDS_APPROVAL",
      requiresApproval: true,
      holdReason: "Tenant is not approved for outbound messaging.",
      riskScore: risk.riskScore,
      normalizedMessage: normalized.message
    };
  }

  const sentCampaignCount = await db.smsCampaign.count({ where: { tenantId, status: "SENT" } });
  if (tenant.firstCampaignRequiresApproval && sentCampaignCount === 0) {
    await audit(tenantId, "SMS_FIRST_CAMPAIGN_APPROVAL_REQUIRED", "Tenant", tenantId);
    return {
      status: "NEEDS_APPROVAL",
      requiresApproval: true,
      holdReason: "First campaign requires admin approval.",
      riskScore: risk.riskScore,
      normalizedMessage: normalized.message
    };
  }

  return {
    status: "QUEUED",
    requiresApproval: false,
    holdReason: null,
    riskScore: risk.riskScore,
    normalizedMessage: normalized.message
  };
}

app.get("/health", async () => ({ ok: true }));

const signupSchema = z.object({
  tenantName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8)
});

app.post("/auth/signup", async (req, reply) => {
  const input = signupSchema.parse(req.body);
  const tenant = await db.tenant.create({
    data: {
      name: input.tenantName,
      isApproved: false,
      dailySmsCap: 100,
      perSecondRate: 1.0,
      firstCampaignRequiresApproval: true
    }
  });

  const passwordHash = await bcrypt.hash(input.password, 10);
  const normalizedEmail = input.email.toLowerCase();
  const role = normalizedEmail.startsWith('support') && normalizedEmail.endsWith('@connectcomunications.com') ? 'ADMIN' : 'USER';
  const user = await db.user.create({
    data: { tenantId: tenant.id, email: input.email, passwordHash, role }
  });

  await audit(tenant.id, "TENANT_SIGNUP_CREATED", "Tenant", tenant.id);

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
  return db.tenDlcSubmission.findMany({ where: query.status ? { status: query.status } : undefined, orderBy: { createdAt: "desc" } });
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
  const input = z.object({ status: z.enum(["NEEDS_INFO", "APPROVED", "REJECTED"]), note: z.string().min(2) }).parse(req.body);
  const updated = await db.tenDlcSubmission.update({ where: { id }, data: { status: input.status, internalNotes: input.note, reviewedAt: new Date() } });
  await audit(updated.tenantId, `TEN_DLC_STATUS_${input.status}`, "TenDlcSubmission", id);
  return updated;
});

app.get("/admin/tenants", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;

  const tenants = await db.tenant.findMany({ orderBy: { createdAt: "desc" } });
  const rows = await Promise.all(
    tenants.map(async (t) => {
      const userCount = await db.user.count({ where: { tenantId: t.id } });
      const campaignCount = await db.smsCampaign.count({ where: { tenantId: t.id } });
      return {
        id: t.id,
        name: t.name,
        isApproved: t.isApproved,
        dailySmsCap: t.dailySmsCap,
        perSecondRate: t.perSecondRate,
        firstCampaignRequiresApproval: t.firstCampaignRequiresApproval,
        stats: { users: userCount, campaigns: campaignCount }
      };
    })
  );

  return rows;
});

app.patch("/admin/tenants/:id", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({
    isApproved: z.boolean().optional(),
    dailySmsCap: z.number().int().positive().optional(),
    perSecondRate: z.number().positive().optional(),
    firstCampaignRequiresApproval: z.boolean().optional()
  }).parse(req.body);

  const updated = await db.tenant.update({ where: { id }, data: input });
  await audit(updated.id, "TENANT_GUARDRAILS_UPDATED", "Tenant", updated.id);
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

  const tenant = await db.tenant.findUnique({ where: { id: user.tenantId } });
  if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });

  const decision = await decideCampaignPolicy({
    tenant,
    tenantId: user.tenantId,
    message: input.message,
    recipientsCount: input.recipients.length
  });

  if ("reject" in decision) {
    return reply.status(400).send({ error: decision.reject });
  }

  const campaign = await db.smsCampaign.create({
    data: {
      tenantId: user.tenantId,
      name: input.name,
      message: decision.normalizedMessage,
      fromNumber: input.fromNumber,
      audienceType: input.audienceType,
      status: decision.status,
      requiresApproval: decision.requiresApproval,
      holdReason: decision.holdReason,
      riskScore: decision.riskScore
    }
  });

  const createdMessages = await Promise.all(
    input.recipients.map((to) =>
      db.smsMessage.create({
        data: {
          campaignId: campaign.id,
          toNumber: to,
          fromNumber: input.fromNumber,
          body: decision.normalizedMessage,
          status: "QUEUED"
        }
      })
    )
  );

  if (campaign.status === "QUEUED") {
    await enqueueCampaignMessages(campaign.id, user.tenantId);
    await audit(user.tenantId, "SMS_CAMPAIGN_QUEUED", "SmsCampaign", campaign.id);
  } else {
    await audit(user.tenantId, "SMS_CAMPAIGN_HELD_FOR_APPROVAL", "SmsCampaign", campaign.id);
  }

  return {
    campaign,
    queuedMessages: campaign.status === "QUEUED" ? createdMessages.length : 0,
    holdReason: campaign.holdReason
  };
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
    where: query.campaignId ? { campaignId: query.campaignId, campaign: { tenantId: user.tenantId } } : { campaign: { tenantId: user.tenantId } },
    orderBy: { createdAt: "desc" }
  });
});

app.get("/admin/sms/campaigns", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const query = z.object({ status: z.enum(["NEEDS_APPROVAL", "QUEUED", "SENDING", "SENT", "FAILED", "PAUSED", "DRAFT"]).optional() }).parse(req.query || {});
  return db.smsCampaign.findMany({ where: query.status ? { status: query.status } : undefined, orderBy: { createdAt: "desc" } });
});

app.post("/admin/sms/campaigns/:id/approve", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const campaign = await db.smsCampaign.findUnique({ where: { id }, include: { messages: true } });
  if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });

  const updated = await db.smsCampaign.update({
    where: { id },
    data: {
      status: "QUEUED",
      requiresApproval: false,
      approvedAt: new Date(),
      approvedByUserId: admin.sub,
      holdReason: null
    }
  });

  await enqueueCampaignMessages(id, campaign.tenantId);
  await audit(campaign.tenantId, "SMS_CAMPAIGN_APPROVED", "SmsCampaign", id);
  return updated;
});

app.post("/admin/sms/campaigns/:id/reject", async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const input = z.object({ reason: z.string().min(2) }).parse(req.body);
  const campaign = await db.smsCampaign.findUnique({ where: { id } });
  if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });

  const updated = await db.smsCampaign.update({
    where: { id },
    data: {
      status: "FAILED",
      requiresApproval: false,
      approvedByUserId: admin.sub,
      approvedAt: new Date(),
      holdReason: input.reason
    }
  });

  await db.smsMessage.updateMany({ where: { campaignId: id, status: { in: ["QUEUED", "SENDING"] } }, data: { status: "FAILED", error: `Rejected: ${input.reason}` } });
  await audit(campaign.tenantId, "SMS_CAMPAIGN_REJECTED", "SmsCampaign", id);
  return updated;
});

app.post("/webhooks/twilio/sms-status", async (req) => {
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
