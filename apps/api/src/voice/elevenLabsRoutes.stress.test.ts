/**
 * Stress tests for the ElevenLabs routes — the guards that keep one bad client
 * (or one enthusiastic tester) from draining the shared character allowance or
 * piling up minute-long provider calls.
 *
 * Everything runs against a real Fastify instance with a FAKE provider behind
 * global fetch: no network, no key, no spent characters. The key resolves via
 * the env fallback so the whole key-resolution path is exercised too.
 *
 * The one property that must survive any refactor: the concurrency counter can
 * NEVER leak. A slot that is taken and not returned — on success, on provider
 * failure, on a thrown handler — permanently shrinks the feature for every
 * tenant until the next deploy. That is tested here by injecting failures and
 * then proving the gate is fully open again.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { registerElevenLabsRoutes } from "./elevenLabsRoutes";
import { clearElevenLabsReadCaches } from "./elevenLabs";

const realFetch = globalThis.fetch;

/** The fake provider: resolves when told to, so tests control concurrency. */
let releaseAll: (() => void) | null = null;
let failNext = 0;
let providerCalls = 0;

function fakeProvider() {
  globalThis.fetch = (async (_url: any) => {
    providerCalls += 1;
    if (failNext > 0) {
      failNext -= 1;
      return new Response(JSON.stringify({ detail: { status: "invalid_api_key" } }), { status: 401 });
    }
    if (releaseAll) {
      // Hold the response open until the test releases it.
      await new Promise<void>((resolve) => {
        const prev = releaseAll;
        releaseAll = () => { prev?.(); resolve(); };
      });
    }
    return new Response(new Uint8Array(1600).buffer as ArrayBuffer, { status: 200 });
  }) as any;
}

let app: ReturnType<typeof Fastify>;

before(async () => {
  process.env.ELEVENLABS_API_KEY = "stress-test-key-0000000000";
  app = Fastify({ logger: false });
  // The real server registers this globally; the per-route budget rides on it.
  await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  registerElevenLabsRoutes({
    app,
    db: {} as any,
    requirePromptManager: async () => ({ sub: "stress-user", role: "SUPER_ADMIN", tenantId: "t1" }),
    // This suite stresses the text-to-speech path only; the voice changer has
    // its own budget and its own tests. Permitted here so the module registers.
    hasVoiceChangerPermission: async () => true,
    resolvePbxRouteHelperConfig: () => null,
    pushPromptToHelper: async () => ({}),
    PromptPushError: class PromptPushError extends Error { httpStatus = 500; },
  });
  await app.ready();
});

after(async () => {
  await app.close();
  globalThis.fetch = realFetch;
  delete process.env.ELEVENLABS_API_KEY;
});

beforeEach(() => {
  clearElevenLabsReadCaches();
  fakeProvider();
  releaseAll = null;
  failNext = 0;
  providerCalls = 0;
});

/** Each test gets its own source address — the per-address rate budget is
 *  12/minute, and these tests fire far more than 12 requests in total. The
 *  budget itself gets its own dedicated test below. */
let addrSeq = 0;
let addr = "10.9.0.0";
beforeEach(() => { addrSeq += 1; addr = `10.9.${Math.floor(addrSeq / 250)}.${addrSeq % 250}`; });

function preview(ip = addr) {
  return app.inject({
    method: "POST",
    url: "/voice/elevenlabs/preview",
    payload: { voiceId: "v1", text: "Stress test greeting." },
    remoteAddress: ip,
  });
}

test("a 10-wide concurrent burst: at most 4 reach the provider, the rest get an honest 'busy'", async () => {
  releaseAll = () => {}; // arm the hold
  const inFlight = Array.from({ length: 10 }, () => preview());
  // Let every request reach the gate before opening the provider.
  await new Promise((r) => setTimeout(r, 50));
  const held = providerCalls;
  releaseAll(); releaseAll = null;
  const results = await Promise.all(inFlight);

  const ok = results.filter((r) => r.statusCode === 200);
  const busy = results.filter((r) => r.statusCode === 429);
  assert.ok(held <= 4, `provider saw ${held} concurrent calls; the gate allows 4`);
  assert.equal(ok.length + busy.length, 10);
  assert.ok(ok.length >= 1 && ok.length <= 4, `expected 1-4 successes, got ${ok.length}`);
  for (const r of busy) {
    const body = r.json() as any;
    assert.ok(
      body.error === "busy" || body.message,
      "a refused caller always gets a message saying to try again",
    );
  }
});

test("after the burst the gate is fully open again — no leaked slots", async () => {
  const r = await preview();
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-type"], "audio/wav");
});

test("provider failures release their slot — 8 failing calls in a row never jam the gate", async () => {
  failNext = 8;
  for (let i = 0; i < 8; i++) {
    const r = await preview();
    assert.equal(r.statusCode, 400, "a rejected key reads as a 400 with advice, not a 500");
  }
  // The gate must be fully open now.
  const r = await preview();
  assert.equal(r.statusCode, 200);
});

test("a 60-request pounding ends with the counter at zero and every request answered", async () => {
  const waves = 6;
  for (let w = 0; w < waves; w++) {
    // Each wave from its own address, like real offices — the per-address
    // budget is exercised by its own test below.
    const waveIp = `10.7.7.${w + 1}`;
    const results = await Promise.all(Array.from({ length: 10 }, () => preview(waveIp)));
    for (const r of results) {
      assert.ok([200, 429].includes(r.statusCode), `unexpected status ${r.statusCode}`);
    }
  }
  const final = await preview("10.7.7.99");
  assert.equal(final.statusCode, 200, "after 60 rapid requests the feature still works");
});

test("one address hammering the button runs out of budget at 13 in a minute", async () => {
  const ip = "10.8.8.8";
  const results = [] as number[];
  for (let i = 0; i < 13; i++) results.push((await preview(ip)).statusCode);
  assert.ok(results.slice(0, 12).every((s) => s === 200), "the first 12 within a minute all pass");
  assert.equal(results[12], 429, "the 13th is refused — the shared character allowance is protected");
});

test("the preview WAV is a real 8 kHz file with correct declared sizes", async () => {
  const r = await preview();
  assert.equal(r.statusCode, 200);
  const body = r.rawPayload;
  assert.equal(body.subarray(0, 4).toString(), "RIFF");
  assert.equal(body.readUInt32LE(24), 8000);
  assert.equal(body.readUInt32LE(40), body.length - 44);
  assert.equal(Number(r.headers["content-length"]), body.length);
  assert.equal(r.headers["cache-control"], "no-store");
});

test("garbage bodies are refused before anything reaches the provider", async () => {
  for (const payload of [
    {},
    { voiceId: "", text: "hi" },
    { voiceId: "v1", text: "" },
    { voiceId: "v1", text: "hi", tuning: { speed: 5 } },
    { voiceId: "v1", text: "hi", tuning: { stability: -1 } },
  ]) {
    const r = await app.inject({ method: "POST", url: "/voice/elevenlabs/preview", payload });
    assert.equal(r.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
  }
  assert.equal(providerCalls, 0);
});

test("text longer than a greeting is refused without spending characters", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/voice/elevenlabs/preview",
    payload: { voiceId: "v1", text: "x".repeat(3000) },
  });
  assert.equal(r.statusCode, 400);
  assert.equal(providerCalls, 0);
});
