/**
 * ElevenLabs unit tests.
 *
 * History note: this file originally imported vitest, which apps/api does not
 * install — so `pnpm test` failed the file at import time and NONE of these
 * assertions had ever actually run. It now uses node:test like every other
 * test in this app. If you add tests here, run `pnpm test` and watch them
 * fail at least once — a test that has never failed has never proven anything.
 *
 * Provider-facing behaviour (caching, retry, format fallback) is tested by
 * swapping global fetch — no network, no key, no spent characters.
 */
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  pcmToWav,
  pcmDurationSeconds,
  isTtsModelId,
  IVR_VOICE_TUNING,
  TTS_MODELS,
  MAX_TTS_CHARS,
  classify,
  checkElevenLabsKey,
  listElevenLabsVoices,
  synthesiseSpeech,
  clearElevenLabsReadCaches,
  ElevenLabsError,
} from "./elevenLabs";

// ── WAV header ───────────────────────────────────────────────────────────────

test("pcmToWav writes a RIFF/WAVE header Asterisk can read", () => {
  const wav = pcmToWav(Buffer.alloc(1600), 8000); // 0.1s at 8 kHz
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  assert.equal(wav.subarray(12, 16).toString(), "fmt ");
  assert.equal(wav.subarray(36, 40).toString(), "data");
});

test("pcmToWav declares mono 16-bit at the rate it was given", () => {
  const wav = pcmToWav(Buffer.alloc(800), 8000);
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 8000);
  assert.equal(wav.readUInt16LE(34), 16);
});

test("pcmToWav gets byte rate and block align right, or players stretch the audio", () => {
  const wav = pcmToWav(Buffer.alloc(800), 8000);
  assert.equal(wav.readUInt32LE(28), 16000); // 8000 * 1 * 2
  assert.equal(wav.readUInt16LE(32), 2);
});

test("pcmToWav sizes both length fields against the real payload", () => {
  const pcm = Buffer.alloc(2222);
  const wav = pcmToWav(pcm, 16000);
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.length, 44 + pcm.length);
});

test("pcmToWav keeps the samples byte-for-byte", () => {
  const pcm = Buffer.from([1, 2, 3, 4, 250, 251, 252, 253]);
  const wav = pcmToWav(pcm, 8000);
  assert.ok(wav.subarray(44).equals(pcm));
});

test("pcmToWav handles a 16 kHz fallback response", () => {
  const wav = pcmToWav(Buffer.alloc(3200), 16000);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 32000);
});

// ── duration ─────────────────────────────────────────────────────────────────

test("pcmDurationSeconds reads one second of 8 kHz audio as one second", () => {
  assert.equal(pcmDurationSeconds(Buffer.alloc(16000), 8000), 1);
});

test("pcmDurationSeconds reads one second of 16 kHz audio as one second", () => {
  assert.equal(pcmDurationSeconds(Buffer.alloc(32000), 16000), 1);
});

test("pcmDurationSeconds rounds to a tenth", () => {
  assert.equal(pcmDurationSeconds(Buffer.alloc(16000 * 12.34), 8000), 12.3);
});

test("pcmDurationSeconds never divides by zero", () => {
  assert.equal(pcmDurationSeconds(Buffer.alloc(1000), 0), 0);
});

// ── model ids ────────────────────────────────────────────────────────────────

test("isTtsModelId accepts every model we offer", () => {
  for (const m of TTS_MODELS) assert.ok(isTtsModelId(m.id));
});

test("isTtsModelId rejects anything else, so a bad body can't reach the provider", () => {
  assert.equal(isTtsModelId("eleven_made_up"), false);
  assert.equal(isTtsModelId(""), false);
  assert.equal(isTtsModelId(null), false);
  assert.equal(isTtsModelId(undefined), false);
  assert.equal(isTtsModelId({ id: "eleven_flash_v2_5" }), false);
});

test("the fast model is first in the list and is the default", () => {
  assert.equal(TTS_MODELS[0].id, "eleven_flash_v2_5");
});

// ── the IVR preset ───────────────────────────────────────────────────────────

test("the IVR preset is steady rather than expressive — a menu is read, not performed", () => {
  assert.ok(IVR_VOICE_TUNING.stability >= 0.7);
  assert.equal(IVR_VOICE_TUNING.style, 0);
});

test("the IVR preset speaks slightly slower than natural, for callers on a bad line", () => {
  assert.ok(IVR_VOICE_TUNING.speed < 1);
  assert.ok(IVR_VOICE_TUNING.speed >= 0.9);
});

test("the IVR preset keeps every setting inside the range the provider accepts", () => {
  for (const k of ["stability", "similarityBoost", "style"] as const) {
    assert.ok(IVR_VOICE_TUNING[k] >= 0 && IVR_VOICE_TUNING[k] <= 1);
  }
  assert.ok(IVR_VOICE_TUNING.speed >= 0.7 && IVR_VOICE_TUNING.speed <= 1.2);
});

test("the length cap fits a real greeting and stops an essay", () => {
  assert.ok(MAX_TTS_CHARS > 500);
  assert.ok(MAX_TTS_CHARS <= 5000);
});

// ── classifying provider failures ────────────────────────────────────────────

// The real body ElevenLabs returned on 2026-08-04, verbatim. A valid key,
// /voices answering 200, and synthesis refused — reported by status code alone
// this reads as "bad key" and sends someone to re-paste a key that was never
// wrong.
const PAYMENT_ISSUE = JSON.stringify({
  detail: {
    type: "payment_required",
    code: "payment_issue",
    message: "Your subscription has a failed or incomplete payment. Complete the latest invoice to continue usage.",
    status: "payment_issue",
    request_id: "ce1da67573a307d04360d8addcaaf61b",
  },
});

test("classify names the unpaid invoice rather than blaming the key", () => {
  const msg = classify(PAYMENT_ISSUE);
  assert.ok(msg);
  assert.match(msg!, /unpaid invoice/i);
  assert.match(msg!, /key is fine/i);
  assert.doesNotMatch(msg!, /rejected/i);
});

test("classify tells someone where to go about an unpaid invoice", () => {
  assert.match(classify(PAYMENT_ISSUE)!, /elevenlabs\.io/);
});

test("classify separates running out of characters from not paying", () => {
  const quota = JSON.stringify({ detail: { status: "quota_exceeded", message: "character limit reached" } });
  assert.match(classify(quota)!, /characters for this month/i);
  assert.doesNotMatch(classify(quota)!, /unpaid/i);
});

test("classify still calls a genuinely bad key a bad key", () => {
  const bad = JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } });
  assert.match(classify(bad)!, /rejected/i);
});

// The body ElevenLabs returned on 2026-08-06, verbatim. Note the 400: a key in
// their retired format is refused with a status code that reads like a bad
// request, and `invalid_api_key_prefix` contains `invalid_api_key`, so both the
// code and a careless classifier lose the one detail that matters.
const LEGACY_KEY_PREFIX_BODY = JSON.stringify({
  detail: {
    type: "authentication_error",
    code: "invalid_api_key",
    message: "API key must start with 'sk_'.",
    status: "invalid_api_key_prefix",
  },
});

test("classify tells someone a retired-format key needs replacing, not re-checking", () => {
  const msg = classify(LEGACY_KEY_PREFIX_BODY)!;
  assert.match(msg, /sk_/);
  assert.match(msg, /will not help/i);
  assert.match(msg, /elevenlabs\.io/);
});

test("the retired-key message is distinct from the generic rejected-key one", () => {
  assert.notEqual(classify(LEGACY_KEY_PREFIX_BODY), classify(JSON.stringify({ detail: { status: "invalid_api_key" } })));
});

test("classify points at the voice picker when a voice has been deleted", () => {
  assert.match(classify(JSON.stringify({ detail: { status: "voice_not_found" } }))!, /Pick another one/i);
});

test("classify reads plain-text bodies too, not just JSON", () => {
  assert.match(classify("Your subscription has a failed or incomplete payment.")!, /unpaid invoice/i);
});

test("classify says nothing when it recognises nothing, so the status code still decides", () => {
  assert.equal(classify(""), null);
  assert.equal(classify("some unrelated upstream error"), null);
  assert.equal(classify("<html>502 Bad Gateway</html>"), null);
});

test("classify never throws on a malformed body", () => {
  assert.doesNotThrow(() => classify("{not json"));
  assert.equal(classify("{not json"), null);
});

// ── provider calls: cache, retry, fallback (mocked fetch, no network) ────────

const realFetch = globalThis.fetch;
let calls: { url: string; init: any }[] = [];

/** Queue of responses; each fetch shifts one. A function entry may throw. */
let responses: (() => Response)[] = [];

function queue(...r: (() => Response)[]) {
  responses.push(...r);
}
function jsonRes(body: unknown, status = 200) {
  return () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function bytesRes(bytes: Uint8Array, status = 200) {
  return () => new Response(bytes.buffer as ArrayBuffer, { status });
}

beforeEach(() => {
  calls = [];
  responses = [];
  clearElevenLabsReadCaches();
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return next();
  }) as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const GOOD_SUB = { tier: "creator", character_count: 100, character_limit: 200000, status: "active", has_open_invoices: false };

test("checkElevenLabsKey answers from cache on the second ask", async () => {
  queue(jsonRes(GOOD_SUB));
  const first = await checkElevenLabsKey("k1");
  assert.equal(first.ok, true);
  assert.equal(first.usable, true);
  const second = await checkElevenLabsKey("k1"); // no response queued — cache or bust
  assert.equal(second.usable, true);
  assert.equal(calls.length, 1);
});

test("a different key never reads another key's cache", async () => {
  queue(jsonRes(GOOD_SUB), jsonRes({ ...GOOD_SUB, status: "past_due" }));
  const a = await checkElevenLabsKey("key-a");
  const b = await checkElevenLabsKey("key-b");
  assert.equal(a.usable, true);
  assert.equal(b.usable, false);
  assert.equal(calls.length, 2);
});

test("an unpaid invoice is reported as not usable, with instructions", async () => {
  queue(jsonRes({ ...GOOD_SUB, has_open_invoices: true }));
  const r = await checkElevenLabsKey("k2");
  assert.equal(r.ok, true);
  assert.equal(r.usable, false);
  assert.match(r.userMessage!, /unpaid invoice/i);
});

test("a used-up character allowance is reported as not usable", async () => {
  queue(jsonRes({ ...GOOD_SUB, character_count: 200000 }));
  const r = await checkElevenLabsKey("k3");
  assert.equal(r.usable, false);
  assert.match(r.userMessage!, /characters for this month/i);
});

test("a failed check is NOT cached — the next ask goes to the provider again", async () => {
  queue(jsonRes({ detail: { status: "invalid_api_key" } }, 401), jsonRes({ detail: { status: "invalid_api_key" } }, 401));
  const r1 = await checkElevenLabsKey("k4");
  assert.equal(r1.ok, false);
  await checkElevenLabsKey("k4");
  // 401 is not transient, so no retry — two asks, two live calls.
  assert.equal(calls.length, 2);
});

test("reads retry once on a provider 5xx and then succeed", async () => {
  queue(jsonRes({}, 503), jsonRes(GOOD_SUB));
  const r = await checkElevenLabsKey("k5");
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
});

test("reads retry once on a rate limit (429)", async () => {
  queue(jsonRes({}, 429), jsonRes({ voices: [{ voice_id: "v1", name: "A" }] }));
  const v = await listElevenLabsVoices("k6");
  assert.equal(v.length, 1);
  assert.equal(calls.length, 2);
});

test("reads do NOT retry twice — one retry, then the honest error", async () => {
  queue(jsonRes({}, 503), jsonRes({}, 503));
  await assert.rejects(() => checkElevenLabsKey("k7").then((r) => (r.ok ? Promise.resolve() : Promise.reject(new Error(r.userMessage)))));
  assert.equal(calls.length, 2);
});

test("listElevenLabsVoices caches, normalises, and drops rows without an id", async () => {
  queue(
    jsonRes({
      voices: [
        { voice_id: "v1", name: "Rachel", labels: { accent: "american" }, preview_url: "https://cdn/x.mp3", category: "premade" },
        { name: "ghost-without-id" },
        { voice_id: "v2" },
      ],
    }),
  );
  const v = await listElevenLabsVoices("k8");
  assert.equal(v.length, 2);
  assert.equal(v[0].name, "Rachel");
  assert.equal(v[1].name, "Unnamed");
  const again = await listElevenLabsVoices("k8");
  assert.equal(again.length, 2);
  assert.equal(calls.length, 1);
});

test("synthesiseSpeech asks for 8 kHz first and returns it when granted", async () => {
  queue(bytesRes(new Uint8Array(1600)));
  const out = await synthesiseSpeech("k9", { voiceId: "v1", text: "Hello there" });
  assert.equal(out.sampleRate, 8000);
  assert.equal(out.pcm.length, 1600);
  assert.match(calls[0].url, /output_format=pcm_8000/);
});

test("synthesiseSpeech falls back to 16 kHz when the plan refuses 8 kHz", async () => {
  queue(jsonRes({ detail: { status: "invalid_output_format" } }, 400), bytesRes(new Uint8Array(3200)));
  const out = await synthesiseSpeech("k10", { voiceId: "v1", text: "Hello there" });
  assert.equal(out.sampleRate, 16000);
  assert.match(calls[1].url, /output_format=pcm_16000/);
});

test("synthesiseSpeech does NOT retry at 16 kHz when the KEY is what was refused", async () => {
  // A rejected key answers 400, the same code an unsupported output format
  // uses. Retrying asks a dead key the same question twice and buries the
  // useful first message under the second failure.
  queue(jsonRes({ detail: { status: "invalid_api_key_prefix", message: "API key must start with 'sk_'." } }, 400));
  await assert.rejects(
    () => synthesiseSpeech("legacy-key", { voiceId: "v1", text: "Hello" }),
    (e: any) => e instanceof ElevenLabsError && /sk_/.test(e.userMessage),
  );
  assert.equal(calls.length, 1);
});

test("synthesiseSpeech still falls back at 16 kHz when it really is the format", async () => {
  queue(jsonRes({ detail: { status: "invalid_output_format" } }, 400), bytesRes(new Uint8Array(3200)));
  const out = await synthesiseSpeech("k10b", { voiceId: "v1", text: "Hello there" });
  assert.equal(out.sampleRate, 16000);
  assert.equal(calls.length, 2);
});

test("synthesiseSpeech does NOT fall back on a quota failure — that retry would just fail and confuse", async () => {
  queue(jsonRes({ detail: { status: "quota_exceeded" } }, 401));
  await assert.rejects(
    () => synthesiseSpeech("k11", { voiceId: "v1", text: "Hello" }),
    (e: any) => e instanceof ElevenLabsError && /characters for this month/i.test(e.userMessage),
  );
  assert.equal(calls.length, 1);
});

test("synthesiseSpeech refuses empty and over-long text before spending anything", async () => {
  await assert.rejects(() => synthesiseSpeech("k12", { voiceId: "v1", text: "   " }));
  await assert.rejects(() => synthesiseSpeech("k12", { voiceId: "v1", text: "x".repeat(MAX_TTS_CHARS + 1) }));
  await assert.rejects(() => synthesiseSpeech("k12", { voiceId: "", text: "hello" }));
  assert.equal(calls.length, 0);
});

test("synthesiseSpeech treats zero returned bytes as a failure, not a silent empty greeting", async () => {
  queue(bytesRes(new Uint8Array(0)));
  await assert.rejects(
    () => synthesiseSpeech("k13", { voiceId: "v1", text: "Hello" }),
    (e: any) => e instanceof ElevenLabsError && /no audio/i.test(e.userMessage),
  );
});

test("synthesiseSpeech clamps out-of-range tuning instead of forwarding it", async () => {
  queue(bytesRes(new Uint8Array(16)));
  await synthesiseSpeech("k14", {
    voiceId: "v1",
    text: "Hello",
    tuning: { stability: 9, similarityBoost: -3, style: 2, speed: 99, useSpeakerBoost: true },
  });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.voice_settings.stability, 1);
  assert.equal(sent.voice_settings.similarity_boost, 0);
  assert.equal(sent.voice_settings.style, 1);
  assert.equal(sent.voice_settings.speed, 1.2);
});

test("the API key rides the xi-api-key header and never the URL", async () => {
  queue(jsonRes(GOOD_SUB));
  await checkElevenLabsKey("super-secret-key");
  assert.equal(calls[0].init.headers["xi-api-key"], "super-secret-key");
  assert.doesNotMatch(calls[0].url, /super-secret-key/);
});
