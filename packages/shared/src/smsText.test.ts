import test from "node:test";
import assert from "node:assert/strict";
import {
  GSM_SINGLE_SEGMENT,
  UCS2_SINGLE_SEGMENT,
  VOIPMS_SMS_MAX_LENGTH,
  analyzeSmsText,
  formatSmsCounterLabel,
  normalizeSmsComposeText,
  validateOutboundSmsText,
} from "./smsText";

test("plain text under 160 GSM septets is valid single segment", () => {
  const body = "Hello, thanks for calling Connect Communications today.";
  const result = validateOutboundSmsText(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.analysis.encoding, "GSM-7");
  assert.equal(result.analysis.segments, 1);
  assert.ok(result.analysis.units < GSM_SINGLE_SEGMENT);
});

test("exactly 160 GSM characters sends as one segment", () => {
  const body = "A".repeat(160);
  const result = validateOutboundSmsText(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.analysis.units, 160);
  assert.equal(result.analysis.segments, 1);
});

test("over-limit blocks with useful error", () => {
  const body = "x".repeat(VOIPMS_SMS_MAX_LENGTH + 1);
  const result = validateOutboundSmsText(body);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "SMS_TOO_LONG");
  assert.match(result.message, /1601 characters/);
  assert.match(result.message, /limit 1600/);
});

test("line breaks count as one GSM septet each", () => {
  const body = "Line one\nLine two\r\nLine three";
  const { text } = normalizeSmsComposeText(body);
  assert.equal(text, "Line one\nLine two\nLine three");
  const analysis = analyzeSmsText(text);
  assert.equal(analysis.encoding, "GSM-7");
  assert.equal(analysis.units, text.length);
});

test("emojis switch to Unicode encoding honestly", () => {
  const body = "Thanks! 👍";
  const analysis = analyzeSmsText(body);
  assert.equal(analysis.encoding, "UCS-2");
  assert.equal(analysis.singleSegmentLimit, UCS2_SINGLE_SEGMENT);
  assert.match(formatSmsCounterLabel(analysis).label, /Unicode/);
});

test("smart quotes force Unicode encoding", () => {
  const body = `"Hello" — see you soon`;
  const analysis = analyzeSmsText(body);
  assert.equal(analysis.encoding, "UCS-2");
});

test("pasted hidden characters do not falsely block normal short text", () => {
  const body = "Hello\u200B\uFEFF there";
  const result = validateOutboundSmsText(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.body, "Hello there");
  assert.equal(result.analysis.strippedInvisible, 2);
  assert.ok(result.analysis.units < GSM_SINGLE_SEGMENT);
});

test("GSM extended characters count as two septets", () => {
  const body = "{}";
  const analysis = analyzeSmsText(body);
  assert.equal(analysis.encoding, "GSM-7");
  assert.equal(analysis.units, 4);
});
