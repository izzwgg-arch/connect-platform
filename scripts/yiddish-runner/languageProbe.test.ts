/**
 * languageProbe — pure decision tests. No network, no db, no ffmpeg.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { probeDecision } from "./languageProbe";

test("Hebrew-script text is always Yiddish, never Hebrew", () => {
  const d = probeDecision("אַ גוטן טאָג");
  assert.equal(d.yiddish, true);
  assert.match(d.reason, /Hebrew-script/);
});

test("mixed Hebrew + Latin script is kept as yi-en", () => {
  const d = probeDecision("אַ גוטן טאָג, thank you very much");
  assert.equal(d.yiddish, true);
  assert.match(d.reason, /mixed/i);
});

test("Latin-only (English) text is not Yiddish", () => {
  const d = probeDecision("hello, how can I help you today");
  assert.equal(d.yiddish, false);
  assert.match(d.reason, /not Yiddish/);
});

test("no detected text is not Yiddish (nothing to keep paying for)", () => {
  const d = probeDecision("");
  assert.equal(d.yiddish, false);
  assert.match(d.reason, /no speech/);
  const d2 = probeDecision(undefined);
  assert.equal(d2.yiddish, false);
});

test("a hint of 'he' is coerced to Yiddish, never trusted as Hebrew", () => {
  const d = probeDecision("some text", "he");
  assert.equal(d.yiddish, true);
});

test("a hint of 'yi' or 'yi-en' short-circuits to Yiddish without reading the text", () => {
  const d1 = probeDecision("irrelevant latin text", "yi");
  assert.equal(d1.yiddish, true);
  const d2 = probeDecision("irrelevant latin text", "yi-en");
  assert.equal(d2.yiddish, true);
});

test("a hint of 'en' short-circuits to not-Yiddish", () => {
  const d = probeDecision("אַ גוטן טאָג", "en");
  assert.equal(d.yiddish, false, "an explicit non-Yiddish hint is trusted over the text");
});

test("'auto' or empty hint falls through to the text-based decision", () => {
  const d = probeDecision("אַ גוטן טאָג", "auto");
  assert.equal(d.yiddish, true);
});
