import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { registerVoiceTranscribe } from "./voiceTranscribe";

function auth() {
  const h = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ sub: "u1", tenantId: "t1", role: "USER", exp: Date.now() / 1000 + 60 })).toString("base64url");
  return { authorization: `Bearer ${h}.${p}.${createHmac("sha256", process.env.JWT_SECRET!).update(`${h}.${p}`).digest("base64url")}` };
}
function wav() {
  const b = Buffer.alloc(6444);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(b.length - 44, 40);
  return b.toString("base64");
}

test("live STT authenticates, validates audio and uses only Yiddish Labs with provider evidence", async t => {
  const old = process.env.JWT_SECRET; process.env.JWT_SECRET = "voice-route-test";
  t.after(() => { if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old; });
  const app = Fastify(); t.after(() => app.close()); let called = 0;
  registerVoiceTranscribe(app, { keys: { yiddishLabsApiKey: "test-only" }, glossaryContext: async () => "dialect", client: () => ({
    submitSync: async (input, signal) => { called++; assert.equal(input.language, "auto"); assert.equal(input.context, "dialect"); assert.equal(input.rapid, true); assert.equal(signal?.aborted, false); return { id: "yl1", status: "completed", text: "⟦skip⟧שלום", language: "yi" }; },
    get: async () => assert.fail("no unnecessary polling"),
  }) });
  const inject = (headers = {}, audioBase64 = wav()) => app.inject({ method: "POST", url: "/agent/chat/voice-transcribe", headers, payload: { audioBase64 } });
  assert.equal((await inject()).statusCode, 403);
  assert.equal((await inject(auth(), "not wav")).statusCode, 400);
  assert.equal(called, 0);
  const result = await inject(auth()); assert.equal(result.statusCode, 200);
  assert.equal(result.json().engine, "yiddishlabs"); assert.equal(result.json().text, "שלום"); assert.equal(result.json().language, "yi"); assert.equal(called, 1);
});

test("missing key or provider failure is explicit, sanitized and never falls back", async t => {
  const old = process.env.JWT_SECRET; process.env.JWT_SECRET = "voice-route-test";
  t.after(() => { if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old; });
  for (const configured of [false, true]) {
    const app = Fastify(); t.after(() => app.close());
    registerVoiceTranscribe(app, { keys: { yiddishLabsApiKey: configured ? "test-only" : null }, glossaryContext: async () => "", client: () => ({ submitSync: async () => { throw new Error("private key upstream detail"); }, get: async () => assert.fail() }) });
    const result = await app.inject({ method: "POST", url: "/agent/chat/voice-transcribe", headers: auth(), payload: { audioBase64: wav() } });
    assert.equal(result.statusCode, configured ? 502 : 503); assert.doesNotMatch(result.body, /private key|test-only/); assert.equal(result.json().ok, false);
  }
});

test("only one active transcription per verified caller; the slot is released after completion", { timeout: 5000 }, async t => {
  const old = process.env.JWT_SECRET; process.env.JWT_SECRET = "voice-route-test";
  t.after(() => { if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old; });
  const app = Fastify(); t.after(() => app.close());
  let release!: (r: any) => void; let started!: () => void; let restarted!: () => void; let count = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const reentered = new Promise<void>(resolve => { restarted = resolve; });
  registerVoiceTranscribe(app, { keys: { yiddishLabsApiKey: "test-only" }, glossaryContext: async () => "", client: () => ({ submitSync: async () => { count++; if (count === 1) started(); else restarted(); return new Promise(resolve => { release = resolve; }); }, get: async () => assert.fail() }) });
  const request = () => app.inject({ method: "POST", url: "/agent/chat/voice-transcribe", headers: auth(), payload: { audioBase64: wav() } });
  const first = request().then(v => v); await entered;
  assert.equal((await request()).statusCode, 429);
  release({ id: "yl", status: "completed", text: "Four", language: "en" }); assert.equal((await first).statusCode, 200);
  const third = request().then(v => v);
  await reentered;
  release({ id: "yl2", status: "completed", text: "Yes", language: "en" }); assert.equal((await third).statusCode, 200);
});
