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

test("shouldSkipJwtVerification: public multi-invoice pay links skip JWT; admin pay-links route does not", () => {
  assert.equal(shouldSkipJwtVerification("/billing/platform/pay-links/X7K2QF"), true);
  assert.equal(shouldSkipJwtVerification("/billing/platform/pay-links/X7K2QF/public-config"), true);
  assert.equal(shouldSkipJwtVerification("/billing/platform/pay-links/X7K2QF/pay"), true);
  assert.equal(shouldSkipJwtVerification("/api/billing/platform/pay-links/X7K2QF"), true);
  assert.equal(shouldSkipJwtVerification("/admin/billing/pay-links"), false);
});

test("shouldSkipJwtVerification: internal agent MOH doors skip JWT (in-handler secret auth)", () => {
  assert.equal(shouldSkipJwtVerification("/internal/agent/moh/override"), true);
  assert.equal(shouldSkipJwtVerification("/internal/agent/moh/upload-asset"), true);
  assert.equal(shouldSkipJwtVerification("/api/internal/agent/moh/upload-asset"), true);
  assert.equal(shouldSkipJwtVerification("/internal/agent/moh/other"), false);
});

test("shouldSkipJwtVerification: voice-agent internal doors skip JWT (in-handler secret auth)", () => {
  // ⛔ Missing bypass = 401 at the JWT hook before the secret check runs.
  assert.equal(shouldSkipJwtVerification("/internal/voice-agent/session-start"), true);
  assert.equal(shouldSkipJwtVerification("/internal/voice-agent/tool"), true);
  assert.equal(shouldSkipJwtVerification("/internal/voice-agent/session-end"), true);
  assert.equal(shouldSkipJwtVerification("/api/internal/voice-agent/tool"), true);
  // NOT bypassed: admin doors are JWT-gated + SUPER_ADMIN.
  assert.equal(shouldSkipJwtVerification("/admin/voice-agent/tenant_x"), false);
  assert.equal(shouldSkipJwtVerification("/internal/voice-agent/other"), false);
});

// ⛔ Every /internal/agent/* door authenticates with the shared secret INSIDE its
// own handler, so each one must also skip the JWT hook — otherwise it 401s before
// that check runs and the feature is silently dead. account-setup-info shipped
// that way: the agent had the caller, the api had the route, and the bypass list
// did not have the path, so the assistant answered "I couldn't retrieve the
// account setup details" every single time. Add new doors to BOTH places.
test("shouldSkipJwtVerification: every internal agent door skips JWT", () => {
  for (const p of [
    "/internal/agent/moh/override",
    "/internal/agent/moh/upload-asset",
    "/internal/agent/route/action",
    "/internal/agent/ivr/action",
    "/internal/agent/queue/action",
    "/internal/agent/extfeature/action",
    "/internal/agent/account-setup-info",
    "/internal/agent/contacts-info",
  ]) {
    assert.equal(shouldSkipJwtVerification(p), true, `${p} must skip the JWT hook`);
    assert.equal(shouldSkipJwtVerification(`/api${p}`), true, `/api${p} must skip the JWT hook`);
  }
  // A path that merely looks like one must NOT open.
  assert.equal(shouldSkipJwtVerification("/internal/agent/account-setup-info-x"), false);
});

test("shouldSkipJwtVerification: MOH sync + signed download paths skip JWT", () => {
  assert.equal(shouldSkipJwtVerification("/voice/moh/sync-manifest"), true);
  assert.equal(shouldSkipJwtVerification("/voice/moh/download/test%2Fconnect_x%2Fasset.wav"), true);
  assert.equal(shouldSkipJwtVerification("/api/voice/moh/download/test%2Fconnect_x%2Fasset.wav"), true);
  assert.equal(shouldSkipJwtVerification("/voice/moh/assets"), false);
});

test("shouldSkipJwtVerification: public CRM form links skip only exact public prefix", () => {
  assert.equal(shouldSkipJwtVerification("/public/forms/token"), true);
  assert.equal(shouldSkipJwtVerification("/api/public/forms/token/pdf"), true);
  assert.equal(shouldSkipJwtVerification("/crm/public/forms/token"), false);
  assert.equal(shouldSkipJwtVerification("/internal/proxy/public/forms/token"), false);
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
