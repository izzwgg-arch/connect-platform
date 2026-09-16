import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { anamSessionRequest, registerLaybelRoutes, type LaybelConfig } from "./laybel/laybelRoutes";

const configured: LaybelConfig = {
  apiKey: "server-only-secret-key-do-not-return",
  avatarId: "11111111-1111-4111-8111-111111111111",
  voiceId: "22222222-2222-4222-8222-222222222222",
  enabled: false, maxSessionSeconds: 180,
};
async function fixture(t: any, options: { role?: string | null; config?: LaybelConfig | null; upstream?: () => Promise<Response> } = {}) {
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  let stored = options.config === undefined ? { ...configured } : options.config;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  app.addHook("onRequest", async req => {
    const role = options.role === undefined ? "SUPER_ADMIN" : options.role;
    if (role) (req as any).user = { sub: "user-1", tenantId: "tenant-1", role };
  });
  registerLaybelRoutes(app, {
    db: {}, loadConfig: async () => stored,
    saveConfig: async value => { stored = value; },
    requireOwner: async (req, reply) => {
      if (req.user?.role !== "SUPER_ADMIN") { reply.code(403).send({ error: "forbidden" }); return null; }
      return req.user;
    },
    fetch: (async (url, init) => {
      requests.push({ url: String(url), init });
      return options.upstream ? options.upstream() : new Response(JSON.stringify({ sessionToken: "short-lived-session" }), { status: 200 });
    }) as typeof fetch,
  });
  t.after(() => app.close());
  return { app, requests, stored: () => stored };
}

test("Laybel renders Loopcom replies with no provider LLM or inherited persona", () => {
  const request = anamSessionRequest(configured);
  assert.equal(request.personaConfig.llmId, "CUSTOMER_CLIENT_V1");
  assert.equal(request.personaConfig.avatarId, configured.avatarId);
  assert.equal(request.personaConfig.maxSessionLengthSeconds, 180);
  assert.equal(request.personaConfig.systemPrompt, "");
  assert.equal("personaId" in request, false);
});
test("unauthenticated status and sessions are rejected before contacting Anam", async t => {
  const { app, requests } = await fixture(t, { role: null });
  assert.equal((await app.inject({ url: "/support/laybel/status" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/support/laybel/session", payload: {} })).statusCode, 401);
  assert.equal(requests.length, 0);
});
test("disabled customer rollout is closed but the owner can preview", async t => {
  const customer = await fixture(t, { role: "TENANT_ADMIN" });
  assert.equal((await customer.app.inject({ method: "POST", url: "/support/laybel/session", payload: {} })).statusCode, 503);
  assert.equal(customer.requests.length, 0);
  const owner = await fixture(t);
  const result = await owner.app.inject({ method: "POST", url: "/support/laybel/session", payload: {} });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json(), { sessionToken: "short-lived-session", maxSessionSeconds: 180 });
  assert.equal(owner.requests[0].url, "https://api.anam.ai/v1/auth/session-token");
  assert.ok(!result.body.includes(configured.apiKey));
});
test("enabled customer call has only server-selected persona settings", async t => {
  const { app, requests } = await fixture(t, { role: "END_USER", config: { ...configured, enabled: true } });
  assert.equal((await app.inject({ method: "POST", url: "/support/laybel/session", payload: { tenantId: "other", personaId: "bad" } })).statusCode, 400);
  assert.equal(requests.length, 0);
  assert.equal((await app.inject({ method: "POST", url: "/support/laybel/session", payload: {} })).statusCode, 200);
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), anamSessionRequest({ ...configured, enabled: true }));
});
test("status never returns the API key and settings are owner-only", async t => {
  for (const role of ["END_USER", "TENANT_ADMIN", "SUPER_ADMIN"]) {
    const { app } = await fixture(t, { role });
    const result = await app.inject({ url: "/support/laybel/status" });
    assert.ok(!result.body.includes(configured.apiKey));
    if (role !== "SUPER_ADMIN") {
      assert.equal("avatarId" in result.json(), false);
      assert.equal((await app.inject({ method: "POST", url: "/support/laybel/settings", payload: configured })).statusCode, 403);
    }
  }
});
test("partial settings preserve write-only key and reject invalid caps/unknown fields", async t => {
  const { app, stored } = await fixture(t);
  assert.equal((await app.inject({ method: "POST", url: "/support/laybel/settings", payload: { maxSessionSeconds: 240 } })).statusCode, 200);
  assert.equal(stored()?.apiKey, configured.apiKey);
  assert.equal(stored()?.maxSessionSeconds, 240);
  for (const payload of [{ maxSessionSeconds: 9999 }, { enabled: true, tenantId: "other" }]) {
    assert.equal((await app.inject({ method: "POST", url: "/support/laybel/settings", payload })).statusCode, 400);
  }
});
test("missing configuration and provider errors fail closed without leaking upstream bodies", async t => {
  const absent = await fixture(t, { config: null });
  assert.equal((await absent.app.inject({ method: "POST", url: "/support/laybel/session", payload: {} })).statusCode, 503);
  for (const upstream of [async () => new Response(configured.apiKey, { status: 500 }), async () => { throw new Error(configured.apiKey); }, async () => new Response("{}")]) {
    const { app } = await fixture(t, { upstream });
    const result = await app.inject({ method: "POST", url: "/support/laybel/session", payload: {} });
    assert.equal(result.statusCode, 502);
    assert.ok(!result.body.includes(configured.apiKey));
    assert.equal(result.headers["cache-control"], "no-store");
  }
});
test("session token requests are rate limited", async t => {
  const { app, requests } = await fixture(t);
  for (let n = 0; n < 3; n++) assert.equal((await app.inject({ method: "POST", url: "/support/laybel/session", payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/support/laybel/session", payload: {} })).statusCode, 429);
  assert.equal(requests.length, 3);
});
