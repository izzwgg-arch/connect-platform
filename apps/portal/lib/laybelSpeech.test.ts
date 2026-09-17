import { test } from "node:test";
import assert from "node:assert/strict";
import { readLaybelAnswer, laybelErrorMessage, SpeechSentences, type SpeechOptions } from "./laybelSpeech";
import { LaybelTurns } from "./laybelTurns";

test("sentence chunks retain text, decimals and abbreviations", () => {
  const output: string[] = [];
  const sentences = new SpeechSentences(text => output.push(text));
  sentences.push("Dr. Smith paid 3.14 dollars. ");
  assert.deepEqual(output, ["Dr. Smith paid 3.14 dollars. "]);
  sentences.push("Next"); sentences.push(" sentence!");
  assert.equal(output.length, 1);
  sentences.finish();
  assert.equal(output.join(""), "Dr. Smith paid 3.14 dollars. Next sentence!");
});

test("NDJSON handles split UTF8, early speech, completion, and no duplicate request", async () => {
  const answer = { conversationId: "c1", reply: "ייִדיש" };
  const bytes = new TextEncoder().encode([JSON.stringify({ type: "speech", text: "Four." }), JSON.stringify({ type: "speech_end" }), JSON.stringify({ type: "complete", result: answer })].join("\n"));
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const spoken: string[] = []; let done = 0;
  assert.deepEqual(await readLaybelAnswer(new Response(body, { headers: { "content-type": "application/x-ndjson" } }), text => spoken.push(text), () => { done++; }), answer);
  assert.deepEqual(spoken, ["Four."]); assert.equal(done, 1);
});

test("JSON backend compatibility and truncated/error streams fail honestly", async () => {
  const answer = { conversationId: "c", reply: "old backend" };
  assert.deepEqual(await readLaybelAnswer(Response.json(answer), () => assert.fail()), answer);
  for (const body of ['{"type":"heartbeat"}\n', '{"type":"error"}\n']) {
    await assert.rejects(readLaybelAnswer(new Response(body, { headers: { "content-type": "application/x-ndjson" } }), () => {}));
  }
});

test("safe translation failures describe the failed stage, not a fake microphone problem", async () => {
  const code = "yiddishlabs_reply_translation_unavailable";
  await assert.rejects(readLaybelAnswer(new Response(JSON.stringify({ type: "error", code }) + "\n", { headers: { "content-type": "application/x-ndjson" } }), () => {}), new RegExp(code));
  assert.match(laybelErrorMessage(new Error(code)), /English answer was generated/);
  assert.doesNotMatch(laybelErrorMessage(new Error("private upstream details")), /private/);
  assert.equal(typeof laybelErrorMessage(new Error("toString")), "string");
});

test("first sentence speaks before final chat; whole answer is never duplicated", async () => {
  const output: string[] = []; let finished = 0;
  let release!: (value: { reply: string }) => void;
  let hooks!: SpeechOptions;
  const queue = new LaybelTurns(async (_text, speech) => { hooks = speech!; return new Promise(resolve => { release = resolve; }); }, async () => assert.fail("duplicate full answer"), () => assert.fail(), () => assert.fail(), () => ({ write: async text => { output.push(text); }, finish: async () => { finished++; }, cancel: () => {} }));
  const pending = queue.submit("one", "question"); await Promise.resolve();
  hooks.onDelta("Four. More"); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(output, ["Four. "]);
  hooks.onDelta(" detail."); hooks.onDone(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, 1, "do not hold the speech stream open during Yiddish translation");
  release({ reply: "translated chat" }); await pending;
  assert.equal(output.join(""), "Four. More detail."); assert.equal(finished, 1);
});

test("barge-in cancels the stream and suppresses all late chunks", async () => {
  const output: string[] = []; let cancelled = 0;
  let release!: (value: { reply: string }) => void; let hooks!: SpeechOptions;
  const queue = new LaybelTurns(async (_text, speech) => { hooks = speech!; return new Promise(resolve => { release = resolve; }); }, async () => assert.fail(), () => assert.fail(), () => assert.fail(), () => ({ write: async text => { output.push(text); }, finish: async () => assert.fail(), cancel: () => { cancelled++; } }));
  const pending = queue.submit("one", "question"); await Promise.resolve();
  hooks.onDelta("First. "); await new Promise(resolve => setImmediate(resolve));
  queue.interrupt(); hooks.onDelta("Late. "); hooks.onDone(); release({ reply: "First. Late." }); await pending;
  assert.deepEqual(output, ["First. "]); assert.equal(cancelled, 1);
});

test("stream failure cancels playback and never retries the assistant", async () => {
  let calls = 0; let failures = 0; let cancel = 0;
  const queue = new LaybelTurns(async (_text, hooks) => { calls++; hooks!.onDelta("Partial. "); await new Promise(resolve => setImmediate(resolve)); throw new Error("network"); }, async () => assert.fail(), () => { failures++; }, () => assert.fail(), () => ({ write: async () => {}, finish: async () => {}, cancel: () => { cancel++; } }));
  await queue.submit("one", "question"); await queue.submit("one", "question");
  assert.equal(calls, 1); assert.equal(failures, 1); assert.equal(cancel, 1);
});
