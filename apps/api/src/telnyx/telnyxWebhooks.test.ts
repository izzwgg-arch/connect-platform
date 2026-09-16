/**
 * The Telnyx messaging webhook door (unified messaging Phase 1, 2026-09-16).
 *
 * Drives the REAL registered handler through a fake fastify app with real
 * Ed25519 signatures — no network, no database beyond fakes. Pins:
 *  - fail-closed auth (no key / unsigned / bad signature → 401, and the JWT
 *    bypass entry exists so the handler is ever reached);
 *  - message.received lands in the ONE shared ingest with the fully prefixed
 *    `telnyx:<id>` provider message id and the media urls;
 *  - message.finalized writes FINAL states only (delivered / the failed
 *    family), keyed on the same prefixed id, and message.sent writes NOTHING;
 *  - an ingest failure is swallowed into a 200 (a 5xx would make Telnyx
 *    redeliver; dedupe is the safety, not the status code).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { registerTelnyxWebhookRoutes, TELNYX_INBOUND_SMS_PATH } from "./telnyxWebhooks";
import { clearTelnyxCredentialsCache } from "./telnyxCredentials";
import { registerInboundSmsIngest, type InboundSmsIngestInput } from "../smsInboundIngest";
import { shouldSkipJwtVerification } from "../jwtPublicRouteBypass";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPublicB64 = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");

function signBody(rawBody: string, ts = Math.floor(Date.now() / 1000)): { signature: string; timestamp: string } {
  const message = Buffer.from(`${ts}|${rawBody}`, "utf8");
  return { signature: cryptoSign(null, message, privateKey).toString("base64"), timestamp: String(ts) };
}

type Handler = (req: any, reply: any) => Promise<any>;

function buildDoor(dbOverrides: Record<string, any> = {}): { handler: Handler; db: any; audits: any[]; updates: any[] } {
  const audits: any[] = [];
  const updates: any[] = [];
  const db: any = {
    agentSecret: { findUnique: async () => null },
    agentAuditLog: { create: async (row: any) => { audits.push(row.data); return row.data; } },
    connectChatMessage: { updateMany: async (q: any) => { updates.push(q); return { count: 1 }; } },
    ...dbOverrides,
  };
  let handler: Handler | null = null;
  const app = {
    post: (path: string, _opts: any, h: Handler) => {
      if (path === TELNYX_INBOUND_SMS_PATH) handler = h;
    },
  };
  registerTelnyxWebhookRoutes({ app, db });
  assert.ok(handler, "the webhook route registered");
  return { handler: handler!, db, audits, updates };
}

function fakeReply() {
  return {
    statusCode: 200,
    body: null as any,
    code(n: number) { this.statusCode = n; return this; },
    send(x: any) { this.body = x; return this; },
  };
}

function reqFor(rawBody: string, headers: Record<string, string>) {
  return { headers, rawBody, log: { warn: () => {} } };
}

beforeEach(() => {
  clearTelnyxCredentialsCache();
  delete process.env.TELNYX_API_KEY;
  delete process.env.TELNYX_PUBLIC_KEY;
  registerInboundSmsIngest(null as any);
});

function armEnvCreds() {
  process.env.TELNYX_API_KEY = "KEYtest_1234567890abcdefghij";
  process.env.TELNYX_PUBLIC_KEY = rawPublicB64;
  clearTelnyxCredentialsCache();
}

const RECEIVED_BODY = JSON.stringify({
  data: {
    event_type: "message.received",
    payload: {
      id: "aaaa1111-2222-3333-4444-555566667777",
      from: { phone_number: "+13479780090" },
      to: [{ phone_number: "+12053513327" }],
      text: "hi from telnyx",
      media: [{ url: "https://media.telnyx.com/a.jpg", content_type: "image/jpeg" }],
      direction: "inbound",
    },
  },
});

test("the JWT hook bypasses the webhook path (else the handler is unreachable)", () => {
  assert.strictEqual(shouldSkipJwtVerification("/webhooks/telnyx/sms"), true);
  assert.strictEqual(shouldSkipJwtVerification("/api/webhooks/telnyx/sms"), true);
});

test("no stored public key = 401, fail closed", async () => {
  const { handler } = buildDoor();
  const reply = fakeReply();
  await handler(reqFor(RECEIVED_BODY, {}), reply);
  assert.strictEqual(reply.statusCode, 401);
});

test("a missing signature header = 401", async () => {
  armEnvCreds();
  const { handler } = buildDoor();
  const reply = fakeReply();
  await handler(reqFor(RECEIVED_BODY, { "telnyx-timestamp": String(Math.floor(Date.now() / 1000)) }), reply);
  assert.strictEqual(reply.statusCode, 401);
});

test("a forged signature = 401", async () => {
  armEnvCreds();
  const { handler } = buildDoor();
  const { timestamp } = signBody(RECEIVED_BODY);
  const reply = fakeReply();
  await handler(reqFor(RECEIVED_BODY, {
    "telnyx-signature-ed25519": Buffer.from("not a signature at all, wrong every way").toString("base64"),
    "telnyx-timestamp": timestamp,
  }), reply);
  assert.strictEqual(reply.statusCode, 401);
});

test("a verified message.received reaches the ONE ingest, fully prefixed", async () => {
  armEnvCreds();
  const seen: InboundSmsIngestInput[] = [];
  registerInboundSmsIngest(async (input) => { seen.push(input); return "routed"; });
  const { handler } = buildDoor();
  const { signature, timestamp } = signBody(RECEIVED_BODY);
  const reply = fakeReply();
  await handler(reqFor(RECEIVED_BODY, { "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp }), reply);
  assert.strictEqual(reply.statusCode, 200);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0]!.rawFrom, "+13479780090");
  assert.strictEqual(seen[0]!.rawTo, "+12053513327");
  assert.strictEqual(seen[0]!.message, "hi from telnyx");
  assert.strictEqual(seen[0]!.providerMessageId, "telnyx:aaaa1111-2222-3333-4444-555566667777");
  assert.deepStrictEqual(seen[0]!.mmsUrls, ["https://media.telnyx.com/a.jpg"]);
});

test("an ingest failure still answers 200 — dedupe is the safety, not the status", async () => {
  armEnvCreds();
  registerInboundSmsIngest(async () => { throw new Error("db down"); });
  const { handler } = buildDoor();
  const { signature, timestamp } = signBody(RECEIVED_BODY);
  const reply = fakeReply();
  await handler(reqFor(RECEIVED_BODY, { "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp }), reply);
  assert.strictEqual(reply.statusCode, 200);
});

function finalizedBody(status: string, errors?: any[]): string {
  return JSON.stringify({
    data: {
      event_type: "message.finalized",
      payload: {
        id: "bbbb1111-2222-3333-4444-555566667777",
        to: [{ phone_number: "+13479780090", status }],
        ...(errors ? { errors } : {}),
      },
    },
  });
}

test("message.finalized delivered promotes the message by its prefixed id", async () => {
  armEnvCreds();
  const { handler, updates } = buildDoor();
  const body = finalizedBody("delivered");
  const { signature, timestamp } = signBody(body);
  const reply = fakeReply();
  await handler(reqFor(body, { "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp }), reply);
  assert.strictEqual(reply.statusCode, 200);
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].where.smsProviderMessageId, "telnyx:bbbb1111-2222-3333-4444-555566667777");
  assert.strictEqual(updates[0].where.direction, "OUTBOUND");
  assert.strictEqual(updates[0].data.deliveryStatus, "delivered");
});

test("message.finalized failure stamps failed with the Telnyx error code", async () => {
  armEnvCreds();
  const { handler, updates } = buildDoor();
  const body = finalizedBody("delivery_failed", [{ code: "40008" }]);
  const { signature, timestamp } = signBody(body);
  const reply = fakeReply();
  await handler(reqFor(body, { "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp }), reply);
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].data.deliveryStatus, "failed");
  assert.strictEqual(updates[0].data.deliveryError, "TELNYX_40008");
});

test("message.sent writes NOTHING — a late 'sent' can never downgrade a 'delivered'", async () => {
  armEnvCreds();
  const { handler, updates } = buildDoor();
  const body = JSON.stringify({
    data: { event_type: "message.sent", payload: { id: "cccc1111-2222-3333-4444-555566667777", to: [{ status: "sent" }] } },
  });
  const { signature, timestamp } = signBody(body);
  const reply = fakeReply();
  await handler(reqFor(body, { "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp }), reply);
  assert.strictEqual(reply.statusCode, 200);
  assert.strictEqual(updates.length, 0);
});

test("a non-final status (delivery_unconfirmed) writes nothing", async () => {
  armEnvCreds();
  const { handler, updates } = buildDoor();
  const body = finalizedBody("delivery_unconfirmed");
  const { signature, timestamp } = signBody(body);
  const reply = fakeReply();
  await handler(reqFor(body, { "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp }), reply);
  assert.strictEqual(updates.length, 0);
});
