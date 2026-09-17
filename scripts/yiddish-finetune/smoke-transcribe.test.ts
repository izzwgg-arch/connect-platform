/**
 * smoke-transcribe.ts — payload shape + parsing tests. Injected fetch/sleep
 * only; no network, no real audio.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildRequestBody, parseResponse, smokeTranscribe } from "./smoke-transcribe";

test("buildRequestBody matches the real Everett client's payload shape", () => {
  const body = JSON.parse(buildRequestBody("ivrit-ai/yi-whisper-large-v3-turbo-ct2", "QUJD", "yi"));
  assert.equal(body.input.engine, "faster-whisper");
  assert.equal(body.input.model, "ivrit-ai/yi-whisper-large-v3-turbo-ct2");
  assert.equal(body.input.transcribe_args.blob, "QUJD");
  assert.equal(body.input.transcribe_args.language, "yi");
  assert.equal(body.input.streaming, false);
});

test("parseResponse joins segment text and reports language + timing", () => {
  const result = parseResponse({
    status: "COMPLETED",
    executionTime: 1234,
    output: [{ result: [[{ type: "segments", data: [{ text: "hello " }, { text: "world" }] }, { language: "yi" }]] }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "hello world");
  assert.equal(result.language, "yi");
  assert.equal(result.executionMs, 1234);
});

test("parseResponse reports a failed job as not-ok with the status", () => {
  const result = parseResponse({ status: "FAILED", error: "oom" });
  assert.equal(result.ok, false);
  assert.match(result.error!, /FAILED/);
});

test("smokeTranscribe refuses an oversized clip before making any request", async () => {
  let called = false;
  const fetchFn = (async () => {
    called = true;
    throw new Error("should not be called");
  }) as any;
  const big = Buffer.alloc(8 * 1024 * 1024, 1);
  const result = await smokeTranscribe("ep-1", "key", "model", big, { fetchFn });
  assert.equal(result.ok, false);
  assert.match(result.error!, /runsync blob limit/);
  assert.equal(called, false);
});

test("smokeTranscribe polls /status until COMPLETED", async () => {
  let calls = 0;
  const fetchFn = (async (url: string) => {
    calls += 1;
    if (url.endsWith("/runsync")) {
      return { ok: true, json: async () => ({ id: "job-1", status: "IN_QUEUE" }) } as any;
    }
    if (url.includes("/status/")) {
      // First poll still running, second poll completed.
      const status = calls < 3 ? "IN_PROGRESS" : "COMPLETED";
      return {
        ok: true,
        json: async () => ({
          id: "job-1",
          status,
          output: status === "COMPLETED" ? [{ result: [[{ type: "segments", data: [{ text: "hi" }] }]] }] : undefined,
        }),
      } as any;
    }
    throw new Error(`unexpected url ${url}`);
  }) as any;
  const sleeps: number[] = [];
  const result = await smokeTranscribe("ep-1", "key", "model", Buffer.from("abc"), {
    fetchFn,
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "hi");
  assert.ok(sleeps.length >= 2, "should have polled at least twice before completion");
});
