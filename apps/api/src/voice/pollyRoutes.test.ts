/**
 * Amazon Polly routes — the properties that must hold whatever else changes.
 *
 * Everything runs against a real Fastify instance with a FAKE AWS behind global
 * fetch: no network, no credentials, no spent characters. Credentials resolve
 * through the env fallback, so the resolution path is exercised too.
 *
 * The properties worth a test:
 *
 *  1. PERMISSION. Polly is billed to Connect's own AWS account, so
 *     `can_use_amazon_polly` is the whole point of the feature's shape. A
 *     prompt manager WITHOUT it must not be able to spend a character — and
 *     must be told so quietly (200 allowed:false on status) rather than with a
 *     403 storm on a screen they open constantly.
 *  2. SIGNING. Every AWS call fails identically (403, unhelpful message) when
 *     the signature is wrong, so the canonical form is asserted directly rather
 *     than only through a live call.
 *  3. The concurrency slot can never leak. A slot taken and not returned
 *     permanently shrinks the feature for every tenant until the next deploy.
 *  4. Credentials are validated for SHAPE before they are stored — a trailing
 *     space and a revoked key produce the same AWS error, and only one of them
 *     is worth an afternoon.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { registerPollyRoutes } from "./pollyRoutes";
import { clearPollyReadCaches, signRequest } from "./polly";
import { clearPollyCredentialsCache, validatePollyCredentials } from "./pollyCredentials";

const realFetch = globalThis.fetch;

const VOICES = {
  Voices: [
    { Id: "Joanna", Name: "Joanna", Gender: "Female", LanguageCode: "en-US", LanguageName: "US English", SupportedEngines: ["standard", "neural"] },
    { Id: "Matthew", Name: "Matthew", Gender: "Male", LanguageCode: "en-US", LanguageName: "US English", SupportedEngines: ["standard", "neural"] },
  ],
};

/** Requests the fake AWS saw, so signing and payloads can be inspected. */
let seen: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
let releaseAll: (() => void) | null = null;
let failNext = 0;

function fakeAws() {
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
    seen.push({ url: u, method: init?.method ?? "GET", headers, body: String(init?.body ?? "") });

    if (failNext > 0) {
      failNext -= 1;
      return new Response(JSON.stringify({ message: "The security token included in the request is invalid." }), {
        status: 403,
        headers: { "x-amzn-errortype": "UnrecognizedClientException:" },
      });
    }
    if (u.includes("/v1/voices")) {
      return new Response(JSON.stringify(VOICES), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (releaseAll) {
      // Hold the response open until the test releases it.
      await new Promise<void>((resolve) => {
        const prev = releaseAll;
        releaseAll = () => { prev?.(); resolve(); };
      });
    }
    // 1600 bytes of 16-bit PCM = 0.1s at 8 kHz.
    return new Response(new Uint8Array(1600).buffer as ArrayBuffer, { status: 200 });
  }) as any;
}

let app: ReturnType<typeof Fastify>;
/** Flipped per test to stand in for the caller's role and permission. */
let callerRole = "SUPER_ADMIN";
let pollyPermitted = true;

before(async () => {
  process.env.POLLY_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
  process.env.POLLY_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  process.env.POLLY_REGION = "us-east-1";

  app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  registerPollyRoutes({
    app,
    db: {} as any,
    requirePromptManager: async () => ({ sub: "test-user", role: callerRole, tenantId: "t1" }),
    requireOwner: async (_req: any, reply: any) => {
      if (callerRole !== "SUPER_ADMIN") {
        reply.code(403).send({ error: "forbidden" });
        return undefined;
      }
      return { sub: "test-user", role: callerRole, tenantId: "t1" };
    },
    hasPollyPermission: async () => pollyPermitted,
    resolvePbxRouteHelperConfig: () => null,
    pushPromptToHelper: async () => ({}),
    PromptPushError: class PromptPushError extends Error { httpStatus = 500; },
  });
  await app.ready();
});

after(async () => {
  await app.close();
  globalThis.fetch = realFetch;
  delete process.env.POLLY_ACCESS_KEY_ID;
  delete process.env.POLLY_SECRET_ACCESS_KEY;
  delete process.env.POLLY_REGION;
});

/** Each test gets its own source address — the per-route budget is 12/minute
 *  and these tests fire more than that in total. */
let addrSeq = 0;
let addr = "10.7.0.0";

beforeEach(() => {
  clearPollyReadCaches();
  clearPollyCredentialsCache();
  fakeAws();
  seen = [];
  releaseAll = null;
  failNext = 0;
  callerRole = "SUPER_ADMIN";
  pollyPermitted = true;
  addrSeq += 1;
  addr = `10.7.${Math.floor(addrSeq / 250)}.${addrSeq % 250}`;
});

function preview(ip = addr) {
  return app.inject({
    method: "POST",
    url: "/voice/polly/preview",
    payload: { voiceId: "Joanna", text: "Thanks for calling." },
    remoteAddress: ip,
  });
}

// ── 1. Permission ────────────────────────────────────────────────────────────

test("without can_use_amazon_polly, status says 'not for you' quietly — 200, not 403", async () => {
  pollyPermitted = false;
  const r = await app.inject({ method: "GET", url: "/voice/polly/status" });
  assert.equal(r.statusCode, 200, "the Studio asks on every open; 403s here would drown out real failures");
  const body = r.json() as any;
  assert.equal(body.allowed, false);
  assert.equal(body.configured, false, "a person who may not use Polly learns nothing about our setup");
  assert.equal(seen.length, 0, "and no AWS call is made on their behalf");
});

test("without can_use_amazon_polly, no character can be spent", async () => {
  pollyPermitted = false;
  for (const call of [
    preview(),
    app.inject({ method: "GET", url: "/voice/polly/voices", remoteAddress: addr }),
    app.inject({
      method: "POST",
      url: "/voice/ivr/prompts/generate-polly",
      payload: { displayName: "Main", text: "Hello", voiceId: "Joanna" },
      remoteAddress: addr,
    }),
  ]) {
    const r = await call;
    assert.equal(r.statusCode, 403, "every spending route refuses");
    assert.match((r.json() as any).message, /administrator/i, "and says who can turn it on");
  }
  assert.equal(seen.length, 0, "AWS is never contacted");
});

test("with the permission, status reports the voices and the region", async () => {
  const r = await app.inject({ method: "GET", url: "/voice/polly/status" });
  assert.equal(r.statusCode, 200);
  const body = r.json() as any;
  assert.equal(body.allowed, true);
  assert.equal(body.configured, true);
  assert.equal(body.usable, true);
  assert.equal(body.region, "us-east-1");
  assert.equal(body.voices.length, 2);
  assert.ok(body.engines.some((e: any) => e.id === "neural"), "the quality choices ride along");
});

test("the credentials themselves are never in any response", async () => {
  const r = await app.inject({ method: "GET", url: "/voice/polly/status" });
  assert.ok(!r.body.includes("wJalrXUtnFEMI"), "the secret must never leave the server");
  const c = await app.inject({ method: "GET", url: "/voice/polly/credentials" });
  assert.ok(!c.body.includes("wJalrXUtnFEMI"), "not even on the owner's own settings page");
  assert.match((c.json() as any).secretHint, /^…/, "only the last four characters");
});

test("the credentials page is owner-only", async () => {
  callerRole = "TENANT_ADMIN";
  const r = await app.inject({ method: "GET", url: "/voice/polly/credentials" });
  assert.equal(r.statusCode, 403);
  const w = await app.inject({ method: "PUT", url: "/voice/polly/credentials", payload: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "x".repeat(40) } });
  assert.equal(w.statusCode, 403);
});

// ── 2. Signing ───────────────────────────────────────────────────────────────

test("every AWS call is signed, and the scope names the right region and service", async () => {
  const r = await preview();
  assert.equal(r.statusCode, 200);
  const req = seen.find((s) => s.url.includes("/v1/speech"));
  assert.ok(req, "synthesis reached the provider");
  const auth = req!.headers.authorization;
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/polly\/aws4_request/);
  assert.match(auth, /SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
  assert.ok(req!.headers["x-amz-date"], "and carries the timestamp the signature covers");
});

test("signed headers are lower-case and sorted — AWS rejects any other order", () => {
  const headers = signRequest({
    credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "secret", region: "eu-west-2" },
    method: "POST",
    path: "/v1/speech",
    query: "",
    body: JSON.stringify({ Text: "hi" }),
    host: "polly.eu-west-2.amazonaws.com",
    now: new Date("2026-08-06T12:00:00.000Z"),
  });
  const signed = /SignedHeaders=([^,]+),/.exec(headers.Authorization)![1].split(";");
  assert.deepEqual(signed, [...signed].sort(), "sorted");
  assert.deepEqual(signed, signed.map((h) => h.toLowerCase()), "lower-case");
  assert.ok(signed.includes("host") && signed.includes("x-amz-date"), "the two AWS always requires");
});

test("the same request signed twice at the same instant produces the same signature", () => {
  const args = {
    credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "secret", region: "us-east-1" },
    method: "GET" as const,
    path: "/v1/voices",
    query: "",
    body: "",
    host: "polly.us-east-1.amazonaws.com",
    now: new Date("2026-08-06T12:00:00.000Z"),
  };
  assert.equal(signRequest(args).Authorization, signRequest(args).Authorization);
  // …and a different secret produces a different one, so the secret is really
  // in the chain rather than decorative.
  const other = signRequest({ ...args, credentials: { ...args.credentials, secretAccessKey: "other" } });
  assert.notEqual(signRequest(args).Authorization, other.Authorization);
});

// ── 3. The concurrency slot ──────────────────────────────────────────────────

test("a 10-wide burst: at most 4 reach AWS, the rest get an honest 'busy'", async () => {
  releaseAll = () => {}; // arm the hold
  const inFlight = Array.from({ length: 10 }, () => preview());
  await new Promise((r) => setTimeout(r, 50));
  const held = seen.filter((s) => s.url.includes("/v1/speech")).length;
  releaseAll(); releaseAll = null;
  const results = await Promise.all(inFlight);

  const ok = results.filter((r) => r.statusCode === 200);
  const busy = results.filter((r) => r.statusCode === 429);
  assert.ok(held <= 4, `AWS saw ${held} concurrent calls; the gate allows 4`);
  assert.equal(ok.length + busy.length, 10, "every caller got an answer");
  for (const r of busy) {
    const body = r.json() as any;
    assert.ok(body.error === "busy" || body.message, "a refused caller is told to try again");
  }
});

test("AWS failures release their slot — 8 rejections in a row never jam the gate", async () => {
  failNext = 8;
  for (let i = 0; i < 8; i++) {
    const r = await preview();
    assert.equal(r.statusCode, 400, "rejected credentials read as a 400 with advice, not a 500");
  }
  const r = await preview();
  assert.equal(r.statusCode, 200, "the gate is fully open again");
  assert.equal(r.headers["content-type"], "audio/wav");
});

test("a customer is never told whose credentials are broken", async () => {
  callerRole = "TENANT_ADMIN";
  failNext = 1;
  const r = await preview();
  assert.equal(r.statusCode, 400);
  const message = (r.json() as any).message as string;
  assert.doesNotMatch(message, /amazon|aws|polly|iam|credential/i, "no supplier, no account, no billing");
});

test("Connect staff ARE told the real reason — that is the point of hiding it", async () => {
  failNext = 1;
  const r = await preview();
  const message = (r.json() as any).message as string;
  assert.match(message, /Amazon/i);
});

// ── 4. Credential shape ──────────────────────────────────────────────────────

test("credentials are shape-checked before they are ever stored", () => {
  const good = validatePollyCredentials({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "eu-west-2",
  });
  assert.equal(good.ok, true);

  for (const [label, input] of [
    ["a lower-case key id", { accessKeyId: "akiaiosfodnn7example", secretAccessKey: "x".repeat(40) }],
    ["a truncated secret", { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "short" }],
    ["the key pasted into both boxes", { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "AKIAIOSFODNN7EXAMPLE" }],
    ["a region that isn't one", { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "x".repeat(40), region: "london" }],
  ] as const) {
    const res = validatePollyCredentials(input as any);
    assert.equal(res.ok, false, `${label} is refused`);
    assert.ok((res as any).message.length > 20, `${label} is refused with an explanation, not a code`);
  }
});

test("a blank region defaults rather than failing", () => {
  const res = validatePollyCredentials({ accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "x".repeat(40) });
  assert.equal(res.ok, true);
  assert.equal((res as any).value.region, "us-east-1");
});

test("credentials are trimmed — a trailing newline from a paste is not a broken key", () => {
  const res = validatePollyCredentials({
    accessKeyId: " AKIAIOSFODNN7EXAMPLE\n",
    secretAccessKey: "  wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY \n",
    region: " us-west-2 ",
  });
  assert.equal(res.ok, true);
  assert.equal((res as any).value.accessKeyId, "AKIAIOSFODNN7EXAMPLE");
  assert.equal((res as any).value.region, "us-west-2");
});

// ── 5. Synthesis payload ─────────────────────────────────────────────────────

test("phone-native 8 kHz PCM is asked for, so nothing is resampled on the way to Asterisk", async () => {
  await preview();
  const body = JSON.parse(seen.find((s) => s.url.includes("/v1/speech"))!.body);
  assert.equal(body.OutputFormat, "pcm");
  assert.equal(body.SampleRate, "8000");
  assert.equal(body.Engine, "neural", "the natural-sounding engine is the default, not the robotic one");
});

test("a speed change becomes SSML, and the text inside it is escaped", async () => {
  await app.inject({
    method: "POST",
    url: "/voice/polly/preview",
    payload: { voiceId: "Joanna", text: "Sales & support", speed: 0.9 },
    remoteAddress: addr,
  });
  const body = JSON.parse(seen.find((s) => s.url.includes("/v1/speech"))!.body);
  assert.equal(body.TextType, "ssml");
  assert.match(body.Text, /<prosody rate="90%">/);
  assert.match(body.Text, /Sales &amp; support/, "an ampersand must not break the markup or be read aloud");
});

test("at normal speed it stays plain text — no SSML to go wrong", async () => {
  await app.inject({
    method: "POST",
    url: "/voice/polly/preview",
    payload: { voiceId: "Joanna", text: "Thanks for calling.", speed: 1 },
    remoteAddress: addr,
  });
  const body = JSON.parse(seen.find((s) => s.url.includes("/v1/speech"))!.body);
  assert.equal(body.TextType, "text");
  assert.equal(body.Text, "Thanks for calling.");
});

test("a preview is never cacheable and never offered as a download", async () => {
  const r = await preview();
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["content-disposition"], "inline");
});
