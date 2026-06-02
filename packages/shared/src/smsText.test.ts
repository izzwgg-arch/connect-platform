import test from "node:test";
import assert from "node:assert/strict";
import {
  GSM_SINGLE_SEGMENT,
  VOIPMS_SENDSMS_MAX_CHARS,
  VOIPMS_SMS_MAX_TOTAL_CHARS,
  analyzeSmsText,
  formatSmsCounterLabel,
  formatVoipMsSmsTooLongMessage,
  normalizeSmsComposeText,
  normalizeSmsForVoipMs,
  splitVoipMsSendSmsParts,
  validateOutboundSmsText,
  validateVoipMsSendSmsPart,
} from "./smsText";

test("plain visible GSM text under 160 chars passes VoIP.ms validation", () => {
  const body = "Hello, thanks for calling Connect Communications today. We will follow up shortly.";
  assert.ok(body.length < VOIPMS_SENDSMS_MAX_CHARS);
  const result = validateOutboundSmsText(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.analysis.encoding, "GSM-7");
  assert.equal(result.voipMsParts.length, 1);
  assert.equal(result.voipMsParts[0], result.body);
});

test("159 GSM chars passes single VoIP.ms sendSMS payload", () => {
  const body = "A".repeat(159);
  const result = validateVoipMsSendSmsPart(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.analysis.payloadChars, 159);
});

test("exactly 160 GSM chars passes single VoIP.ms sendSMS payload", () => {
  const body = "A".repeat(160);
  const result = validateVoipMsSendSmsPart(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.analysis.units, 160);
  assert.equal(result.voipMsParts.length, 1);
});

test("161 GSM chars splits into two VoIP.ms API payloads but remains sendable", () => {
  const body = "A".repeat(161);
  const parts = splitVoipMsSendSmsParts(body);
  assert.equal(parts.length, 2);
  assert.equal(parts[0]?.length, 160);
  assert.equal(parts[1]?.length, 1);
  const result = validateOutboundSmsText(body);
  assert.equal(result.ok, true);
});

test("140 visible chars with 95 pipe symbols splits due to GSM septets, not blocked", () => {
  const body = "|".repeat(95);
  assert.ok(body.length < 140);
  const analysis = analyzeSmsText(body);
  assert.equal(analysis.encoding, "GSM-7");
  assert.equal(analysis.units, 190);
  assert.equal(analysis.voipMsParts, 2);
  const result = validateOutboundSmsText(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.voipMsParts.length, 2);
  assert.equal(result.voipMsParts[0]?.length, 80);
  assert.equal(result.voipMsParts[1]?.length, 15);
});

test("smart apostrophes normalize to GSM so short text stays one VoIP.ms part", () => {
  const body = "I\u2019ll call you back at 3 o\u2019clock with John\u2019s update.";
  const normalized = normalizeSmsForVoipMs(body);
  assert.ok(normalized.text.includes("'"));
  assert.equal(normalized.normalizedSmartPunct, 3);
  const analysis = analyzeSmsText(body);
  assert.equal(analysis.encoding, "GSM-7");
  assert.equal(analysis.voipMsParts, 1);
  assert.equal(validateOutboundSmsText(body).ok, true);
});

test("hidden characters are stripped and do not falsely block normal short text", () => {
  const body = "Hello\u200B\uFEFF there";
  const result = validateOutboundSmsText(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.body, "Hello there");
  assert.equal(result.analysis.strippedInvisible, 2);
  assert.ok(result.analysis.payloadChars < GSM_SINGLE_SEGMENT);
});

test("over VoIP.ms total cap blocks with precise error", () => {
  const body = "x".repeat(VOIPMS_SMS_MAX_TOTAL_CHARS + 1);
  const result = validateOutboundSmsText(body);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "SMS_TOO_LONG");
  assert.match(result.message, /VoIP.ms/);
  assert.match(formatVoipMsSmsTooLongMessage(result.analysis), /1601 chars/);
});

test("line breaks count as one GSM septet each after normalization", () => {
  const body = "Line one\nLine two\r\nLine three";
  const { text } = normalizeSmsComposeText(body);
  assert.equal(text, "Line one\nLine two\nLine three");
  const analysis = analyzeSmsText(text);
  assert.equal(analysis.encoding, "GSM-7");
  assert.equal(analysis.units, text.length);
});

test("counter shows encoding, bytes, and VoIP.ms part count", () => {
  const body = "A".repeat(161);
  const { label, hint } = formatSmsCounterLabel(analyzeSmsText(body));
  assert.match(label, /161 chars/);
  assert.match(label, /bytes/);
  assert.match(label, /2 VoIP.ms SMS/);
  assert.match(hint || "", /2 separate SMS/);
});

test("Connect Chat does not append STOP or campaign footer during normalization", () => {
  const body = "Your appointment is confirmed for tomorrow at 9am.";
  const { text } = normalizeSmsForVoipMs(body);
  assert.doesNotMatch(text, /STOP/i);
  assert.doesNotMatch(text, /opt out/i);
  assert.equal(text, body);
});

test("161-char payload fails single-part VoIP.ms validation with useful detail", () => {
  const body = "B".repeat(161);
  const result = validateVoipMsSendSmsPart(body);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /161 chars/);
  assert.match(result.message, /160/);
});

test("emojis remain Unicode and show byte/char counts honestly", () => {
  const body = "Thanks! 👍";
  const analysis = analyzeSmsText(body);
  assert.equal(analysis.encoding, "UCS-2");
  assert.ok(analysis.payloadBytesUtf8 > analysis.payloadChars);
  assert.match(formatSmsCounterLabel(analysis).label, /Unicode/);
});
