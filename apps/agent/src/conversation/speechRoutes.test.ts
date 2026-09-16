import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { registerChatRoutes } from "./routes";

const answer = { conversationId: "c1", reply: "Four.", language: "en", degraded: false };
function auth() {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "user-verified", tenantId: "tenant-verified", role: "USER", exp: Date.now() / 1000 + 60 })).toString("base64url");
  const sig = createHmac("sha256", process.env.JWT_SECRET!).update(`${header}.${payload}`).digest("base64url");
  return { authorization: `Bearer ${header}.${payload}.${sig}` };
}

test("stream route keeps JWT identity and rejects unauthenticated or non-voice requests", async t => {
  const old = process.env.JWT_SECRET; process.env.JWT_SECRET = "local-stream-test-only";
  t.after(() => { if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old; });
  const app = Fastify(); t.after(() => app.close()); let calls = 0;
  registerChatRoutes(app, { handleMessage: async (ctx: any) => {
    calls++; assert.equal(ctx.tenantId, "tenant-verified"); assert.equal(ctx.clientUserId, "user-verified"); assert.equal(ctx.role, "customer");
    ctx.onSpeechDelta?.("Four."); ctx.onSpeechDone?.(); return answer;
  } } as any);
  const payload = { text: "q", channel: "voice", streamSpeech: true, identity: { tenantId: "attacker", role: "owner" } };
  assert.equal((await app.inject({ method: "POST", url: "/agent/chat/message", payload })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/agent/chat/message", headers: auth(), payload: { ...payload, channel: "chat" } })).statusCode, 400);
  const res = await app.inject({ method: "POST", url: "/agent/chat/message", headers: auth(), payload });
  assert.equal(res.statusCode, 200); assert.equal(res.headers["x-accel-buffering"], "no");
  assert.deepEqual(res.body.trim().split("\n").map(x => JSON.parse(x).type), ["speech", "speech_end", "complete"]);
  assert.equal(calls, 1);
  const normal = await app.inject({ method: "POST", url: "/agent/chat/message", headers: auth(), payload: { text: "q" } });
  assert.deepEqual(normal.json(), answer);
});

test("real HTTP reader receives speech before the engine finishes", async t => {
  const old = process.env.JWT_SECRET; process.env.JWT_SECRET = "local-stream-test-only";
  t.after(() => { if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old; });
  const app = Fastify(); t.after(() => app.close());
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  registerChatRoutes(app, { handleMessage: async (ctx: any) => { ctx.onSpeechDelta("Four. "); await waiting; ctx.onSpeechDone(); return answer; } } as any);
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  const response = await fetch(`${url}/agent/chat/message`, { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ text: "q", channel: "voice", streamSpeech: true }), signal: AbortSignal.timeout(5000) });
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /"type":"speech"/);
  release();
  let rest = "";
  while (true) { const value = await reader.read(); if (value.done) break; rest += new TextDecoder().decode(value.value); }
  assert.match(rest, /"type":"complete"/);
});

test("errors after speech are explicit, sanitized, and not retried", async t => {
  const old = process.env.JWT_SECRET; process.env.JWT_SECRET = "local-stream-test-only";
  t.after(() => { if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old; });
  const app = Fastify(); t.after(() => app.close()); let calls = 0;
  registerChatRoutes(app, { handleMessage: async (ctx: any) => { calls++; ctx.onSpeechDelta("Partial. "); throw new Error("private upstream error"); } } as any);
  const res = await app.inject({ method: "POST", url: "/agent/chat/message", headers: auth(), payload: { text: "q", channel: "voice", streamSpeech: true } });
  assert.match(res.body, /"type":"error"/); assert.doesNotMatch(res.body, /private upstream/); assert.equal(calls, 1);
});
