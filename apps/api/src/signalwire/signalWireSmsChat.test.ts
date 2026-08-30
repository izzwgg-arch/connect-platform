/**
 * SignalWire SMS ↔ chat wiring guards.
 *
 * The defects these pin are all CALLER-side — the shape every inbound-SMS bug
 * in this repo has taken (two publish paths, two invite paths, two ingest
 * paths). A unit test of any one function passes straight through them, so
 * these read the SOURCE of the three call sites:
 *
 *  1. There is exactly ONE inbound ingest implementation, and the VoIP.ms
 *     webhook DELEGATES to it (never a second copy that drifts).
 *  2. The SignalWire webhook routes into that same ingest, only AFTER its
 *     signature gate, with a fully prefixed provider message id.
 *  3. The ingest dedupes on the provider message id (carrier webhooks RETRY on
 *     non-2xx, and a redelivered message must never become a second bubble).
 *
 * Sources are CRLF-normalised on read (this tree checks out CRLF on Windows)
 * and comments are stripped before any NEGATIVE match — the doc comments quote
 * the very patterns the guards forbid.
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

function readSrc(rel: string): string {
  return readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
}

function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");
}

const chatRoutes = readSrc("../connectChatRoutes.ts");
const swRoutes = readSrc("./signalWireRoutes.ts");

test("chat routes define ONE shared ingest and register it", () => {
  assert.strictEqual(chatRoutes.split("async function ingestInboundSmsToChat").length - 1, 1);
  assert.ok(chatRoutes.includes("registerInboundSmsIngest(ingestInboundSmsToChat);"));
});

test("the VoIP.ms webhook DELEGATES to the shared ingest instead of carrying its own copy", () => {
  const start = chatRoutes.indexOf("async function handleVoipMsInbound");
  assert.ok(start > 0, "handleVoipMsInbound exists");
  const end = chatRoutes.indexOf('app.post("/webhooks/voipms/sms"', start);
  assert.ok(end > start, "registration follows the handler");
  const body = stripComments(chatRoutes.slice(start, end));
  assert.ok(body.includes("await ingestInboundSmsToChat({"), "delegates to the shared ingest");
  assert.ok(body.includes("providerMessageId ? `voipms:${providerMessageId}` : null"), "prefixes the provider id");
  // The tell of a re-forked copy: the handler itself creating threads/messages.
  assert.ok(!body.includes("connectChatThread.create"), "no inline thread creation in the webhook handler");
  assert.ok(!body.includes("connectChatMessage.create"), "no inline message creation in the webhook handler");
});

test("the shared ingest dedupes on the provider message id", () => {
  const start = chatRoutes.indexOf("async function ingestInboundSmsToChat");
  const end = chatRoutes.indexOf("registerInboundSmsIngest(ingestInboundSmsToChat);", start);
  const body = chatRoutes.slice(start, end);
  assert.ok(body.includes('smsProviderMessageId: providerMessageId, direction: "INBOUND"'), "dedupe query present");
  assert.ok(body.includes('return "duplicate";'), "redelivery is acknowledged, never re-ingested");
});

test("the SignalWire inbound webhook routes into the shared ingest AFTER its signature gate", () => {
  const start = swRoutes.indexOf("const inboundHandler = async");
  assert.ok(start > 0, "inboundHandler exists");
  const end = swRoutes.indexOf("app.post(SIGNALWIRE_INBOUND_SMS_PATH", start);
  const body = swRoutes.slice(start, end);
  const gateAt = body.indexOf('webhookGate(req, reply, "inbound_sms")');
  const ingestAt = body.indexOf("getInboundSmsIngest()");
  assert.ok(gateAt > -1 && ingestAt > gateAt, "ingest only runs after the gate verified the signature");
  assert.ok(body.includes("`signalwire:${p.MessageSid}`"), "provider id is fully prefixed");
  // Ingest failure must never fail the webhook (a 5xx makes SignalWire
  // redeliver) — the try/catch around the ingest CALL is load-bearing.
  const callAt = body.indexOf("await ingest({");
  const tryAt = body.indexOf("try {");
  assert.ok(callAt > -1 && tryAt > -1 && tryAt < callAt, "the ingest call is wrapped so a throw cannot 5xx the webhook");
});

test("the status webhook writes only FINAL delivery states onto the message", () => {
  const start = swRoutes.indexOf("app.post(SIGNALWIRE_SMS_STATUS_PATH");
  const end = swRoutes.indexOf("registry status callback", start);
  const body = swRoutes.slice(start, end > start ? end : undefined);
  assert.ok(body.includes('msgStatus === "delivered" || msgStatus === "undelivered" || msgStatus === "failed"'));
  assert.ok(body.includes("`signalwire:${statusSid}`"), "status matched on the prefixed id");
  assert.ok(stripComments(body).includes('direction: "OUTBOUND"'), "only outbound messages are stamped");
});

test("the ingest registry hands back what was registered", async () => {
  const { registerInboundSmsIngest, getInboundSmsIngest } = require("../smsInboundIngest");
  const before = getInboundSmsIngest();
  try {
    const fn = async () => "routed" as const;
    registerInboundSmsIngest(fn);
    assert.strictEqual(getInboundSmsIngest(), fn);
  } finally {
    if (before) registerInboundSmsIngest(before);
  }
});
