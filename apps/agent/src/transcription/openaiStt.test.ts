import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openaiTranscribe } from "./openaiStt";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("posts multipart to OpenAI and returns parsed text", async () => {
  let captured: any = null;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ text: "גוט מארגן" }) } as any;
  }) as any;
  const r = await openaiTranscribe("sk-test", Buffer.from([1, 2, 3, 4]), "mic.webm");
  assert.equal(r.text, "גוט מארגן");
  assert.match(String(captured.url), /api\.openai\.com\/v1\/audio\/transcriptions/);
  assert.equal(captured.init.headers.Authorization, "Bearer sk-test");
  assert.ok(captured.init.body instanceof FormData);
});

test("throws (so caller falls back to YL) on non-OK response", async () => {
  globalThis.fetch = (async () => ({ ok: false, status: 429, text: async () => "rate limited" }) as any) as any;
  await assert.rejects(() => openaiTranscribe("sk-test", Buffer.from([1, 2, 3, 4]), "mic.webm"), /openai_stt_failed:429/);
});

test("no api key → throws not_configured", async () => {
  await assert.rejects(() => openaiTranscribe("", Buffer.from([1, 2, 3, 4])), /openai_not_configured/);
});
