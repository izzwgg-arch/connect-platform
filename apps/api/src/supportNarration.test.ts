/**
 * Reading a support answer out loud.
 *
 * ⛔ Every character that reaches ElevenLabs is BILLED, so these are cost tests
 * as much as correctness tests: what gets stripped, where the cap falls, and
 * that replaying a message is free.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SPEAK_MAX_CHARS,
  SUPPORT_NARRATION_VOICE_ID,
  clearNarrationCache,
  narratableText,
  narrationCacheGet,
  narrationCacheSet,
  takeSpeakSlot,
} from "./supportNarration";

test("a fenced code block is not read out — it is expensive and useless as audio", () => {
  const { text } = narratableText("Here is the fix:\n```ts\nconst x = 1;\nconst y = 2;\n```\nThat's all.");
  assert.match(text, /code block/);
  assert.doesNotMatch(text, /const x/);
  assert.match(text, /That's all/);
});

test("an UNTERMINATED code fence is still dropped", () => {
  // A streaming answer cut mid-block would otherwise be read character by
  // character, at full price.
  const { text } = narratableText("Try this:\n```bash\ndocker ps -a\nwc -l file.ts");
  assert.doesNotMatch(text, /docker ps/);
  assert.match(text, /code block/);
});

test("markdown is spoken as words, not as punctuation", () => {
  const { text } = narratableText("## Findings\n- **one** thing\n- `apps/api` is fine\n1. done\nSee [the handoff](https://x.test/a).");
  for (const junk of ["##", "**", "`", "- ", "](http"]) {
    assert.ok(!text.includes(junk), `should not speak ${junk}: ${text}`);
  }
  assert.match(text, /Findings/);
  assert.match(text, /one thing/);
  assert.match(text, /apps\/api is fine/);
  assert.match(text, /the handoff/);
  assert.doesNotMatch(text, /x\.test/);
});

test("empty or punctuation-only input yields nothing to say, rather than a paid call", () => {
  for (const raw of ["", "   ", "\n\n", "```\n```"]) {
    const { text } = narratableText(raw);
    assert.ok(text.replace(/[^a-z0-9]/gi, "").length === 0, `expected nothing spoken for ${JSON.stringify(raw)}`);
  }
});

test("a long answer is cut on a sentence boundary and flagged as shortened", () => {
  const sentence = "The watchdog reported that the outbox was healthy at the time of the check. ";
  const raw = sentence.repeat(200); // comfortably over the cap
  const { text, truncated } = narratableText(raw);
  assert.equal(truncated, true);
  assert.ok(text.length <= SPEAK_MAX_CHARS, `cut to ${text.length}`);
  // Ends on a full stop, not mid-word.
  assert.match(text, /\.$/);
  assert.doesNotMatch(text, /\bth$|\bwatchdo$/);
});

test("text under the cap is never marked truncated", () => {
  const { text, truncated } = narratableText("Short answer.");
  assert.equal(truncated, false);
  assert.equal(text, "Short answer.");
});

test("the voice is the Kristen id read off the live account, not a guess", () => {
  // ⛔ If this ever needs changing, change it to an id you have LISTED from the
  // account — a wrong voice id fails at the provider with an unhelpful 400.
  assert.equal(SUPPORT_NARRATION_VOICE_ID, "CvD6hF1BJzAFN428j1cO");
});

test("replaying the same answer is free — the cache returns the same bytes", () => {
  clearNarrationCache();
  const mp3 = Buffer.from([0xff, 0xfb, 0x00, 0x01]);
  narrationCacheSet("k1", mp3);
  assert.equal(narrationCacheGet("k1"), mp3);
  assert.equal(narrationCacheGet("nope"), null);
});

test("the cache is bounded, so a long session cannot grow it without limit", () => {
  clearNarrationCache();
  for (let i = 0; i < 200; i += 1) narrationCacheSet(`k${i}`, Buffer.from([i & 0xff]));
  // The oldest are gone; the newest survive.
  assert.equal(narrationCacheGet("k0"), null);
  assert.ok(narrationCacheGet("k199") !== null);
});

test("the concurrency gate hands out a bounded number of slots and takes them back", () => {
  const a = takeSpeakSlot();
  const b = takeSpeakSlot();
  assert.ok(a && b, "two slots should be available");
  assert.equal(takeSpeakSlot(), null, "a third must be refused rather than queued");
  a!();
  const c = takeSpeakSlot();
  assert.ok(c, "releasing frees a slot");
  // Releasing twice must not leak a slot back into the pool.
  a!();
  b!();
  c!();
  assert.ok(takeSpeakSlot(), "pool restored");
});

test("the route never retries a synthesis POST", () => {
  // ⛔ SOURCE guard: a retry bills the same words twice. The defect would be in
  // the CALLER, so a unit test of the synthesiser cannot see it.
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const src = readFileSync(require.resolve("./supportConsole.ts"), "utf8").replace(/\r\n/g, "\n");
  const route = src.slice(src.indexOf('app.post("/admin/support/speak"'));
  const body = route.slice(0, route.indexOf("\n  });"));
  const calls = body.match(/synthesiseNarration\(/g) ?? [];
  assert.equal(calls.length, 1, "exactly one synthesis call in the speak route");
  assert.doesNotMatch(body.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), /for\s*\(|while\s*\(|retry/i);
});

test("the speak route stores nothing and never touches the PBX", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const src = readFileSync(require.resolve("./supportConsole.ts"), "utf8").replace(/\r\n/g, "\n");
  const route = src.slice(src.indexOf('app.post("/admin/support/speak"'));
  const body = route.slice(0, route.indexOf("\n  });")).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  for (const forbidden of ["writeFile", "tenantPbxPrompt", "uploadPrompt", "publishIvr", "generatedPromptStore"]) {
    assert.ok(!body.includes(forbidden), `speak must not reference ${forbidden}`);
  }
});
