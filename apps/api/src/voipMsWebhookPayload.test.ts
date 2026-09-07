/**
 * The VoIP.ms webhook envelope parser, driven on the TWO REAL bodies VoIP.ms
 * POSTed to production on 2026-09-07 (one SMS, one MMS), plus the wiring guard
 * on the handler. Before this the tokened webhook answered 200 and ingested
 * NOTHING — the literal `{TO}` from the query string reached `canonicalSmsPhone`
 * and the message was logged `invalid_to`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseVoipMsWebhookEnvelope } from "./voipMsWebhookPayload";

// Exactly what mergeVoipMsPayload handed the handler: the literal query
// placeholders merged UNDER the JSON body (token masked).
const REAL_SMS = {
  id: "{ID}",
  to: "{TO}",
  data: {
    id: 110997718,
    payload: {
      id: 110997718,
      to: [{ status: "webhook_delivered", phone_number: "8455577768" }],
      from: { phone_number: "8457231213" },
      text: "Connect webhook test 14:20:19",
      type: "SMS",
      media: [],
      received_at: "2026-09-07T14:20:46.000000+00:00",
      record_type: "message",
    },
    event_type: "message.received",
    record_type: "event",
  },
  date: "{TIMESTAMP}",
  from: "{FROM}",
  media: "{MEDIA}",
  token: "<masked>",
  message: "{MESSAGE}",
};

const REAL_MMS = {
  data: {
    id: 10239205,
    payload: {
      id: 10239205,
      to: [{ status: "webhook_delivered", phone_number: "8455577768" }],
      from: { phone_number: "8457231213" },
      text: "Connect webhook MMS test",
      type: "MMS",
      media: [{ url: "https://voip.ms/media/MTc4ODc5MDk2MzZhOWVjOGIzMmQ3MTc2YTllYzhiMzJkNzU3fDF8cG5nfE1NUw==/media.png" }],
      received_at: "2026-09-07T14:22:44.000000+00:00",
      record_type: "message",
    },
    event_type: "message.received",
    record_type: "event",
  },
};

test("the real SMS envelope parses to the sender, our DID, the text and the poll-compatible id", () => {
  const r = parseVoipMsWebhookEnvelope(REAL_SMS);
  assert.equal(r.kind, "message");
  if (r.kind !== "message") return;
  assert.equal(r.message.from, "8457231213");
  assert.equal(r.message.to, "8455577768");
  assert.equal(r.message.text, "Connect webhook test 14:20:19");
  assert.equal(r.message.id, "110997718"); // the poll stores voipms:110997718 — same number
  assert.deepEqual(r.message.mediaUrls, []);
  assert.equal(r.message.type, "SMS");
});

test("the real MMS envelope yields the media url in the same voip.ms/media shape the poll mirrors", () => {
  const r = parseVoipMsWebhookEnvelope(REAL_MMS);
  assert.equal(r.kind, "message");
  if (r.kind !== "message") return;
  assert.deepEqual(r.message.mediaUrls, [
    "https://voip.ms/media/MTc4ODc5MDk2MzZhOWVjOGIzMmQ3MTc2YTllYzhiMzJkNzU3fDF8cG5nfE1NUw==/media.png",
  ]);
  assert.equal(r.message.type, "MMS");
});

test("the literal query placeholders never win over the envelope", () => {
  const r = parseVoipMsWebhookEnvelope(REAL_SMS);
  assert.equal(r.kind, "message");
  if (r.kind !== "message") return;
  assert.notEqual(r.message.to, "{TO}");
  assert.notEqual(r.message.from, "{FROM}");
});

test("a legacy flat payload (no envelope) is reported so the caller keeps its old field mapping", () => {
  assert.deepEqual(parseVoipMsWebhookEnvelope({ from: "8457231213", to: "8455577768", message: "hi", id: "5" }), { kind: "not_envelope" });
  assert.deepEqual(parseVoipMsWebhookEnvelope(null), { kind: "not_envelope" });
  assert.deepEqual(parseVoipMsWebhookEnvelope({ data: "junk" }), { kind: "not_envelope" });
});

test("an envelope for any other event is ignored, never ingested", () => {
  const r = parseVoipMsWebhookEnvelope({
    data: { id: 1, payload: { id: 1, to: [{ phone_number: "8455577768" }], from: { phone_number: "1" }, text: "x" }, event_type: "message.delivered", record_type: "event" },
  });
  assert.deepEqual(r, { kind: "ignored", eventType: "message.delivered" });
  const incomplete = parseVoipMsWebhookEnvelope({ data: { id: 1, payload: { id: 1, to: [], from: {}, text: "x" }, event_type: "message.received" } });
  assert.equal(incomplete.kind, "ignored");
});

test("a short-code or alphanumeric sender survives as-is (the ingest canonicalises it)", () => {
  const r = parseVoipMsWebhookEnvelope({
    data: { id: 9, payload: { id: 9, to: [{ phone_number: "8455577768" }], from: { phone_number: "29283" }, text: "Your WhatsApp code: 1", type: "SMS", media: [] }, event_type: "message.received" },
  });
  assert.equal(r.kind, "message");
  if (r.kind === "message") assert.equal(r.message.from, "29283");
});

// ── Wiring guard: the handler must consult the envelope BEFORE the flat fields ──
test("guard: handleVoipMsInbound reads the envelope first and skips non-message events", () => {
  const src = readFileSync(path.join(__dirname, "connectChatRoutes.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("async function handleVoipMsInbound(");
  const end = src.indexOf('app.post("/webhooks/voipms/sms"', start);
  assert.ok(start > 0 && end > start);
  const handler = src.slice(start, end);
  const envelopeAt = handler.indexOf("parseVoipMsWebhookEnvelope(");
  const flatAt = handler.indexOf("payload.from ?? payload.src");
  assert.ok(envelopeAt > 0, "the handler must call parseVoipMsWebhookEnvelope");
  assert.ok(flatAt > envelopeAt, "the flat from/to/message mapping must be the FALLBACK, after the envelope");
  assert.ok(/kind === "ignored"[\s\S]*?return reply\.type\("text\/plain"\)\.send\("ok"\)/.test(handler), "an ignored event must be acknowledged with 200 and not ingested");
  assert.ok(handler.indexOf("kind === \"ignored\"") < handler.indexOf("await ingestInboundSmsToChat("), "the ignore branch must come before ingest");
});
