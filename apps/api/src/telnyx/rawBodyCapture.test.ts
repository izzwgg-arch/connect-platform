/**
 * The raw-body defect that took every Telnyx webhook down (2026-09-18).
 *
 * server.ts registers `fastify-raw-body` with `global:false` (deferred, loads at
 * ready()) and then registers routes synchronously. The plugin's `onRoute` hook
 * never sees those routes, so `req.rawBody` is undefined and both Telnyx doors
 * answer 401 `unsigned` to every real delivery. The existing door tests fake
 * `req.rawBody`, so they could not see it. This test boots a REAL Fastify app in
 * server.ts's exact order and sends real requests through it.
 *
 * Replayed against the pre-fix doors this file FAILS (the doors read "unsigned").
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import Fastify from "fastify";
import fastifyRawBody from "fastify-raw-body";
import { registerTelnyxWebhookRoutes, TELNYX_INBOUND_SMS_PATH } from "./telnyxWebhooks";
import { registerMobileWebhookRoutes } from "../loopcomMobile/mobileWebhookRoutes";
import { clearTelnyxCredentialsCache } from "./telnyxCredentials";
import { registerInboundSmsIngest } from "../smsInboundIngest";
import { captureRawBodyPreParsing } from "./rawBodyCapture";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPublicB64 = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");

function sign(rawBody: string) {
  const ts = Math.floor(Date.now() / 1000);
  return { "telnyx-signature-ed25519": cryptoSign(null, Buffer.from(`${ts}|${rawBody}`, "utf8"), privateKey).toString("base64"), "telnyx-timestamp": String(ts) };
}

/** Same order as server.ts: plugin registered (deferred), routes added synchronously after. */
async function bootLikeServer(): Promise<{ app: any; audits: any[]; ingested: any[] }> {
  const audits: any[] = [];
  const ingested: any[] = [];
  const db: any = {
    agentSecret: { findUnique: async () => null },
    agentAuditLog: { create: async (row: any) => { audits.push(row.data); return row.data; } },
    connectChatMessage: { updateMany: async () => ({ count: 1 }) },
    mobileLine: { findFirst: async () => null },
  };
  registerInboundSmsIngest((async (input: any) => { ingested.push(input); return { ok: true }; }) as any);
  const app = Fastify({ logger: false });
  app.register(fastifyRawBody as any, { field: "rawBody", global: false, encoding: false, runFirst: true });
  registerTelnyxWebhookRoutes({ app, db });
  registerMobileWebhookRoutes({ app, db });
  await app.ready();
  return { app, audits, ingested };
}

beforeEach(() => {
  process.env.TELNYX_API_KEY = "KEYtest_1234567890abcdefghij";
  process.env.TELNYX_PUBLIC_KEY = rawPublicB64;
  clearTelnyxCredentialsCache();
});

const RECEIVED = JSON.stringify({
  data: {
    event_type: "message.received",
    id: "evt-raw-1",
    payload: { id: "msg-raw-1", direction: "inbound", from: { phone_number: "+18455577768" }, to: [{ phone_number: "+18457231213" }], text: "hello through a real request", media: [], received_at: new Date().toISOString() },
  },
});

test("a REAL request through the SMS door is verified from its raw bytes (not 'unsigned')", async () => {
  const { app, audits, ingested } = await bootLikeServer();
  const res = await app.inject({ method: "POST", url: TELNYX_INBOUND_SMS_PATH, headers: { "content-type": "application/json", ...sign(RECEIVED) }, payload: RECEIVED });
  assert.equal(res.statusCode, 200, `door answered ${res.statusCode}: ${res.body}`);
  assert.equal(audits.filter((a) => String(a?.event || "").includes("refused")).length, 0, "no refusal audit");
  assert.equal(ingested.length, 1, "the text reached the shared ingest");
  await app.close();
});

test("a tampered body is refused for its SIGNATURE, never as 'unsigned'", async () => {
  const { app } = await bootLikeServer();
  const headers = { "content-type": "application/json", ...sign(RECEIVED) };
  const res = await app.inject({ method: "POST", url: TELNYX_INBOUND_SMS_PATH, headers, payload: RECEIVED.replace("hello", "HELLO") });
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).reason, "signature_mismatch");
  await app.close();
});

test("the Loopcom Mobile door captures the raw body the same way", async () => {
  const { app } = await bootLikeServer();
  const body = JSON.stringify({ data: { event_type: "sim.status", payload: {} } });
  const res = await app.inject({ method: "POST", url: "/webhooks/telnyx/mobile", headers: { "content-type": "application/json", ...sign(body.replace("sim", "SIM")) }, payload: body });
  // A wrong signature must be judged on the bytes — the door read them.
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error, "bad_signature");
  await app.close();
});

test("the capture hook hands Fastify an equivalent stream, so JSON still parses", async () => {
  const app = Fastify({ logger: false });
  app.post("/echo", { preParsing: captureRawBodyPreParsing }, async (req: any) => ({ raw: (req.rawBody as Buffer).toString("utf8"), parsed: req.body }));
  const payload = JSON.stringify({ a: 1, s: "ünïcode ✓" });
  const res = await app.inject({ method: "POST", url: "/echo", headers: { "content-type": "application/json" }, payload });
  assert.equal(res.statusCode, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.raw, payload);
  assert.deepEqual(out.parsed, { a: 1, s: "ünïcode ✓" });
  await app.close();
});
