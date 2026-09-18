import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { env, isProd } from "./env.js";
import { db as defaultDb, type Db } from "./db.js";
import { ApiError } from "./lib/errors.js";
import { registerActorResolution } from "./auth/actor.js";
import { registerIdempotency } from "./lib/idempotency.js";
import { registerAuthRoutes, type AuthDeps } from "./auth/routes.js";
import { registerCoreRoutes } from "./core/routes.js";
import { registerDomains } from "./domains.js";

export type AppOptions = {
  db?: Db;
  auth?: AuthDeps;
  logger?: boolean;
};

/**
 * Builds the api without listening — tests `inject()` against it, server.ts
 * listens. Every route module receives (app, db) and nothing else.
 */
export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const e = env();
  const db = opts.db ?? defaultDb();
  const app = Fastify({
    logger: opts.logger ?? (isProd() ? true : { level: "warn" }),
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => Math.random().toString(36).slice(2, 12),
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Web app origin + native apps (no origin) + localhost dev.
      if (!origin || origin === e.COMMUNITY_PUBLIC_URL || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || origin.endsWith(".loopcom.net")) cb(null, true);
      else cb(null, false);
    },
    credentials: true,
    exposedHeaders: ["idempotent-replayed", "x-request-id"],
  });
  await app.register(jwt, { secret: e.COMMUNITY_JWT_SECRET });
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute",
    keyGenerator: (req) => (req as any).actor?.personId || String(req.headers["x-forwarded-for"] || req.ip),
    errorResponseBuilder: () => ({ statusCode: 429, error: "rate_limited", message: "Slow down — try again in a minute." }),
    // Tests hammer one IP; the limiter is a production control, not a test subject.
    allowList: () => process.env.COMMUNITY_RATE_LIMIT_OFF === "1",
  });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 10 } });
  // Clients send `content-type: application/json` on bodiless POSTs (fetch defaults);
  // an empty body means "{}", not an error.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = String(body || "").trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      done(Object.assign(new Error("Body is not valid JSON."), { statusCode: 400 }), undefined);
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("cache-control", "no-store");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details ?? undefined });
    }
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const field = first?.path?.join(".") || "input";
      return reply.status(400).send({ error: "invalid_input", message: `${field}: ${first?.message ?? "invalid"}`, details: err.issues });
    }
    const status = (err as any).statusCode ?? 500;
    if (status === 429) return reply.status(429).send({ error: "rate_limited", message: "Slow down — try again in a minute." });
    if (status === 413) return reply.status(413).send({ error: "too_large", message: "That upload is too large." });
    if (status >= 500) req.log.error({ err, reqId: req.id }, "unhandled");
    return reply.status(status).send({ error: status >= 500 ? "internal" : "request_error", message: status >= 500 ? "Something went wrong on our side. It's been logged." : String((err as any).message || "Bad request"), requestId: req.id });
  });

  app.get("/health", async () => {
    const t0 = Date.now();
    await db.$queryRaw`SELECT 1`;
    return { ok: true, service: "community-api", dbMs: Date.now() - t0, at: new Date().toISOString() };
  });

  registerActorResolution(app, db);
  registerIdempotency(app, db);
  registerAuthRoutes(app, db, opts.auth);
  registerCoreRoutes(app, db);
  await registerDomains(app, db);

  return app;
}
