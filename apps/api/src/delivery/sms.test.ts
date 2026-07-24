import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSmsCommand } from "./smsCommands";
import { buildOutboundSms, buildStatusReply, buildHelpReply, buildOptOutReply, approxSegments, type SmsContext } from "./smsTemplates";
import { decideSend, notificationIdempotencyKey } from "./notificationDedup";

// ── command parsing ──────────────────────────────────────────────────────────
test("STOP/START recognized first and exactly", () => {
  assert.equal(parseSmsCommand("STOP").intent, "stop");
  assert.equal(parseSmsCommand("stop").intent, "stop");
  assert.equal(parseSmsCommand("unsubscribe").intent, "stop");
  assert.equal(parseSmsCommand("START").intent, "start");
  assert.equal(parseSmsCommand("yes").intent, "start");
});

test("keyword commands", () => {
  assert.equal(parseSmsCommand("STATUS").intent, "status");
  assert.equal(parseSmsCommand("track").intent, "track");
  assert.equal(parseSmsCommand("ETA").intent, "eta");
  assert.equal(parseSmsCommand("help").intent, "help");
});

test("tolerant natural phrasing → status", () => {
  assert.equal(parseSmsCommand("where is my order??").intent, "status");
  assert.equal(parseSmsCommand("where's my delivery").intent, "status");
  assert.equal(parseSmsCommand("how long until my order arrives").intent, "eta");
});

test("order number extraction", () => {
  assert.deepEqual(parseSmsCommand("ORDER 8842"), { intent: "order", orderNumber: "8842" });
  assert.deepEqual(parseSmsCommand("order #8842"), { intent: "order", orderNumber: "8842" });
  assert.deepEqual(parseSmsCommand("8842"), { intent: "order", orderNumber: "8842" });
  assert.equal(parseSmsCommand("hi there").intent, "unknown");
});

// ── templates ────────────────────────────────────────────────────────────────
const ctx: SmsContext = { storeName: "FreshMart", orderRef: "#8842", etaText: "3:10–3:25 PM", trackUrl: "frsh.mt/9fQ2", statusLabel: "on the way" };

test("outbound templates include link + opt-out, never an address", () => {
  const oft = buildOutboundSms("out_for_delivery", ctx);
  assert.match(oft, /out for delivery/);
  assert.match(oft, /Track: frsh\.mt\/9fQ2/);
  assert.match(oft, /Reply STOP/);
  assert.doesNotMatch(oft, /Elm St|Unit|address/i);
});

test("delivered/failed/delayed render correctly", () => {
  assert.match(buildOutboundSms("delivered", ctx), /has been delivered/);
  assert.match(buildOutboundSms("failed", ctx), /couldn't complete/);
  assert.match(buildOutboundSms("delayed", ctx), /running a little late/);
});

test("inbound replies are concise (<= 2 segments) and safe", () => {
  for (const body of [buildStatusReply(ctx), buildHelpReply("FreshMart"), buildOptOutReply("FreshMart"), buildOutboundSms("out_for_delivery", ctx)]) {
    assert.ok(approxSegments(body) <= 2, `too long (${body.length}): ${body}`);
  }
});

// ── dedup + opt-out gate ──────────────────────────────────────────────────────
test("dedup: same trigger sends once", () => {
  const key = notificationIdempotencyKey("o1", "delivered");
  const first = decideSend("o1", "delivered", { sentKeys: new Set(), optedOut: false });
  assert.equal(first.send, true);
  const second = decideSend("o1", "delivered", { sentKeys: new Set([key]), optedOut: false });
  assert.equal(second.send, false);
  assert.equal(second.reason, "duplicate");
});

test("opt-out blocks all delivery texts", () => {
  const d = decideSend("o1", "out_for_delivery", { sentKeys: new Set(), optedOut: true });
  assert.equal(d.send, false);
  assert.equal(d.reason, "opted_out");
});

test("different triggers for same order are distinct keys", () => {
  assert.notEqual(notificationIdempotencyKey("o1", "out_for_delivery"), notificationIdempotencyKey("o1", "delivered"));
});
