import Fastify from "fastify";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@connect/db";
import { FakeNumberProvider } from "@connect/integrations";

const app = Fastify({ logger: true });
const numberProvider = new FakeNumberProvider();

app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
app.register(jwt, { secret: process.env.JWT_SECRET || "change-me" });

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
  const user = await db.user.create({
    data: { tenantId: tenant.id, email: input.email, passwordHash, role: "owner" }
  });
  const token = await reply.jwtSign({ sub: user.id, tenantId: tenant.id, email: user.email });
  return { token, user: { id: user.id, email: user.email }, tenant: { id: tenant.id, name: tenant.name } };
});

app.post("/auth/login", async (req, reply) => {
  const input = z.object({ email: z.string().email(), password: z.string().min(8) }).parse(req.body);
  const user = await db.user.findUnique({ where: { email: input.email } });
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
    return reply.status(401).send({ error: "invalid_credentials" });
  }
  const token = await reply.jwtSign({ sub: user.id, tenantId: user.tenantId, email: user.email });
  return { token };
});

app.addHook("preHandler", async (req, reply) => {
  if (["/health", "/auth/signup", "/auth/login"].includes(req.url)) return;
  try {
    await req.jwtVerify();
  } catch {
    return reply.status(401).send({ error: "unauthorized" });
  }
});

app.get("/me", async (req) => {
  const user = req.user as { sub: string; tenantId: string; email: string };
  return { id: user.sub, tenantId: user.tenantId, email: user.email };
});

app.post("/ten-dlc/submit", async (req) => {
  const user = req.user as { tenantId: string };
  const input = z.object({ legalName: z.string().min(2) }).parse(req.body);
  return db.tenDlcSubmission.create({ data: { tenantId: user.tenantId, legalName: input.legalName, status: "submitted" } });
});

app.get("/ten-dlc/status", async (req) => {
  const user = req.user as { tenantId: string };
  return db.tenDlcSubmission.findFirst({ where: { tenantId: user.tenantId }, orderBy: { createdAt: "desc" } });
});

app.post("/sms/campaigns", async (req) => {
  const user = req.user as { tenantId: string };
  const input = z.object({ name: z.string(), message: z.string(), audience: z.string() }).parse(req.body);
  return db.smsCampaign.create({ data: { tenantId: user.tenantId, name: input.name, message: input.message, audience: input.audience, status: "draft" } });
});

app.get("/sms/campaigns", async (req) => {
  const user = req.user as { tenantId: string };
  return db.smsCampaign.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: "desc" } });
});

app.post("/numbers/search", async (req) => {
  const input = z.object({ areaCode: z.string().optional(), type: z.string().optional() }).parse(req.body);
  return numberProvider.searchNumbers(input);
});

app.post("/numbers/purchase", async (req) => {
  const user = req.user as { tenantId: string };
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
