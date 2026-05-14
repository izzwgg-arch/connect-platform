import assert from "node:assert";
import test from "node:test";
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { shouldSkipJwtVerification } from "./jwtPublicRouteBypass";
import {
  clearRegisteredShutdownTimers,
  isReadyToServeTraffic,
  markListeningComplete,
  markNotAcceptingTraffic,
} from "./processLifecycle";

test("shouldSkipJwtVerification: readiness + health paths skip JWT", () => {
  assert.equal(shouldSkipJwtVerification("/ready"), true);
  assert.equal(shouldSkipJwtVerification("/api/ready"), true);
  assert.equal(shouldSkipJwtVerification("/health"), true);
});

test("shouldSkipJwtVerification: arbitrary protected API path does not skip", () => {
  assert.equal(shouldSkipJwtVerification("/me"), false);
  assert.equal(shouldSkipJwtVerification("/tenants/foo"), false);
});

test("minimal app: GET /ready and /api/ready and /health without Authorization are not 401", async () => {
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret-key-for-jwt-bypass-tests-only!!" });
  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (shouldSkipJwtVerification(path)) return;
    try {
      await req.jwtVerify();
    } catch {
      return reply.status(401).send({ error: "unauthorized" });
    }
  });
  app.get("/health", async () => ({ ok: true }));
  app.get("/ready", async () => ({ ok: true, ready: true }));
  app.get("/api/ready", async () => ({ ok: true, ready: true }));
  app.get("/me", async () => ({ secret: "no" }));

  for (const url of ["/ready", "/api/ready", "/health"]) {
    const res = await app.inject({ method: "GET", url, headers: {} });
    assert.notEqual(res.statusCode, 401, `${url} must not return JWT 401`);
    assert.ok(res.statusCode === 200 || res.statusCode === 503, `${url} status ${res.statusCode}`);
  }
  await app.close();
});

test("minimal app: protected route returns 401 without Authorization", async () => {
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret-key-for-jwt-bypass-tests-only!!" });
  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (shouldSkipJwtVerification(path)) return;
    try {
      await req.jwtVerify();
    } catch {
      return reply.status(401).send({ error: "unauthorized" });
    }
  });
  app.get("/me", async () => ({ ok: true }));

  const res = await app.inject({ method: "GET", url: "/me", headers: {} });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("mirrored readiness: GET /ready returns 503 when draining (not 401)", async () => {
  clearRegisteredShutdownTimers();
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret-key-for-jwt-bypass-tests-only!!" });
  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (shouldSkipJwtVerification(path)) return;
    try {
      await req.jwtVerify();
    } catch {
      return reply.status(401).send({ error: "unauthorized" });
    }
  });
  app.get("/ready", async (_req, reply) => {
    if (!isReadyToServeTraffic()) {
      return reply.code(503).send({ ok: false, ready: false, reason: "draining" });
    }
    return { ok: true, ready: true };
  });

  markListeningComplete();
  assert.equal(isReadyToServeTraffic(), true);

  const ok = await app.inject({ method: "GET", url: "/ready" });
  assert.equal(ok.statusCode, 200);

  markNotAcceptingTraffic();
  const drain = await app.inject({ method: "GET", url: "/ready" });
  assert.equal(drain.statusCode, 503);
  assert.notEqual(drain.statusCode, 401, "drain must not be expressed as 401");

  markListeningComplete();
  await app.close();
});
