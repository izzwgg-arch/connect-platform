/**
 * Voice changer (ElevenLabs speech-to-speech) — engine behaviour and the
 * guards that keep it honest.
 *
 * ⛔ THE ASSERTION THAT MATTERS MOST is the one proving nothing in this path
 * transcribes anything. The whole reason the voice changer exists here is that
 * it works on Yiddish, and it only works on Yiddish because the audio is never
 * turned into text. A future "improvement" that routes this through speech
 * recognition and text-to-speech would look like a quality upgrade in a diff
 * and would silently break every language the platform actually serves.
 *
 * Several tests read SOURCE rather than calling a function, because the defects
 * this file is protecting against are all in callers and wiring — a unit test
 * of convertSpeech passes straight through a route that forgot a permission
 * gate or a server.ts that never passed the gate in.
 *
 * ⛔ Every source read normalises CRLF. Izzy's checkout is core.autocrlf=true,
 * so a literal "\n" match finds nothing on Windows and the test fails in a way
 * that reads exactly like a real regression.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

import {
  convertSpeech,
  isVoiceChangerModelId,
  VOICE_CHANGER_MODELS,
  MAX_CONVERT_SECONDS,
  MAX_CONVERT_BYTES,
  ElevenLabsError,
} from "./elevenLabs";

// ⛔ __dirname, not import.meta.url. This repo compiles as CommonJS (import.meta
// is a TS1343 error here), and the URL form also percent-encodes the space in
// "Connect 2" — producing an ENOENT that reads like a missing file.
const read = (...p: string[]): string => fs.readFileSync(path.join(__dirname, ...p), "utf8").replace(/\r\n/g, "\n");

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** Fake provider. `statuses` is consumed one per call. */
function fakeProvider(statuses: number[], captured: Captured[]): void {
  let i = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    captured.push({
      url: String(url),
      headers: Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
      body: init?.body,
    });
    if (status !== 200) {
      return new Response(JSON.stringify({ detail: { status: "bad_thing" } }), { status });
    }
    return new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 });
  }) as any;
}

function restore(): void {
  globalThis.fetch = realFetch;
}

const AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22]);

// ─── The engine ──────────────────────────────────────────────────────────────

test("converts through the speech-to-speech endpoint, asking for phone-native 8 kHz", async () => {
  const captured: Captured[] = [];
  fakeProvider([200], captured);
  try {
    const out = await convertSpeech("k", { voiceId: "voice-1", audio: AUDIO, filename: "a.mp3", contentType: "audio/mpeg" });
    assert.equal(out.sampleRate, 8000);
    assert.equal(out.model, "eleven_multilingual_sts_v2", "multilingual is the default — it is the one that serves Yiddish");
    assert.equal(captured.length, 1);
    assert.match(captured[0].url, /\/speech-to-speech\/voice-1\?output_format=pcm_8000$/);
  } finally {
    restore();
  }
});

test("⛔ never sets Content-Type on the multipart body — fetch owns the boundary", async () => {
  const captured: Captured[] = [];
  fakeProvider([200], captured);
  try {
    await convertSpeech("k", { voiceId: "v", audio: AUDIO, filename: "a.wav" });
    assert.ok(captured[0].body instanceof FormData, "the recording must go as multipart, not JSON");
    assert.ok(
      !("content-type" in captured[0].headers),
      "setting Content-Type ourselves strips the multipart boundary and the provider answers a generic 400",
    );
    assert.equal(captured[0].headers["xi-api-key"], "k");
  } finally {
    restore();
  }
});

test("⛔ voice_settings goes as a single JSON string, not as separate fields", async () => {
  const captured: Captured[] = [];
  fakeProvider([200], captured);
  try {
    await convertSpeech("k", {
      voiceId: "v",
      audio: AUDIO,
      filename: "a.wav",
      tuning: { stability: 0.9, similarityBoost: 0.4, style: 0.1, useSpeakerBoost: true },
    });
    const form = captured[0].body as FormData;
    const raw = form.get("voice_settings");
    assert.equal(typeof raw, "string", "sent as separate fields it is silently ignored and every dial does nothing");
    const parsed = JSON.parse(String(raw));
    assert.equal(parsed.stability, 0.9);
    assert.equal(parsed.similarity_boost, 0.4);
    assert.equal(parsed.style, 0.1);
    assert.equal(parsed.use_speaker_boost, true);
    assert.ok(!("speed" in parsed), "the voice changer exposes no speed control — sending one implies a dial that does not exist");
  } finally {
    restore();
  }
});

test("falls back to 16 kHz when the plan refuses 8 kHz, rather than failing the request", async () => {
  const captured: Captured[] = [];
  fakeProvider([400, 200], captured);
  try {
    const out = await convertSpeech("k", { voiceId: "v", audio: AUDIO, filename: "a.wav" });
    assert.equal(out.sampleRate, 16000);
    assert.equal(captured.length, 2);
    assert.match(captured[1].url, /output_format=pcm_16000$/);
  } finally {
    restore();
  }
});

test("⛔ does NOT retry when the key was rejected — the second failure buries the useful message", async () => {
  const captured: Captured[] = [];
  let i = 0;
  globalThis.fetch = (async () => {
    i += 1;
    return new Response(JSON.stringify({ detail: { status: "invalid_api_key" } }), { status: 401 });
  }) as any;
  try {
    await assert.rejects(() => convertSpeech("bad", { voiceId: "v", audio: AUDIO, filename: "a.wav" }), ElevenLabsError);
    assert.equal(i, 1, "a rejected key cannot be fixed by asking again at a different sample rate");
  } finally {
    restore();
  }
});

test("refuses an empty upload and an oversized one before spending anything", async () => {
  const captured: Captured[] = [];
  fakeProvider([200], captured);
  try {
    await assert.rejects(() => convertSpeech("k", { voiceId: "v", audio: Buffer.alloc(0), filename: "a.wav" }), ElevenLabsError);
    await assert.rejects(
      () => convertSpeech("k", { voiceId: "v", audio: Buffer.alloc(MAX_CONVERT_BYTES + 1), filename: "a.wav" }),
      ElevenLabsError,
    );
    await assert.rejects(() => convertSpeech("k", { voiceId: "", audio: AUDIO, filename: "a.wav" }), ElevenLabsError);
    assert.equal(captured.length, 0, "not one of those should have reached the provider");
  } finally {
    restore();
  }
});

test("only the two real conversion models are accepted", () => {
  assert.ok(isVoiceChangerModelId("eleven_multilingual_sts_v2"));
  assert.ok(isVoiceChangerModelId("eleven_english_sts_v2"));
  // Text-to-speech models cannot do voice conversion — no model does both.
  assert.ok(!isVoiceChangerModelId("eleven_flash_v2_5"));
  assert.ok(!isVoiceChangerModelId("eleven_multilingual_v2"));
  assert.equal(VOICE_CHANGER_MODELS.length, 2);
});

// ─── The guards that outlive this session ────────────────────────────────────

/**
 * Strip comments before scanning for forbidden calls.
 *
 * ⛔ This is load-bearing, not tidiness. The doc blocks in both files EXPLAIN
 * that nothing here transcribes or translates — so a naive substring search
 * matches the prose and fails on correct code. Worse, the inverse: someone
 * could add a real transcription call and the guard would already be "failing"
 * for the harmless reason, so nobody would notice. Same lesson as
 * nodeEnvGates.test.ts.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

test("⛔⛔ nothing in the conversion path transcribes, translates or speaks text", () => {
  const engine = read("elevenLabs.ts");
  const routes = code(read("elevenLabsRoutes.ts"));
  const convertBody = code(engine.slice(engine.indexOf("export async function convertSpeech")));
  assert.ok(convertBody.length > 200, "convertSpeech not found — this guard would silently pass");
  assert.ok(routes.includes("/voice/ivr/prompts/convert"), "comment stripping ate the code — the guard would pass vacuously");

  for (const [label, blob] of [["engine", convertBody], ["routes", routes]] as const) {
    assert.ok(!/speech-to-text/i.test(blob), `${label}: no speech-to-text endpoint may appear in this path`);
    assert.ok(!/\bwhisper\b/i.test(blob), `${label}: no Whisper`);
    assert.ok(!/transcribe|transcription/i.test(blob), `${label}: nothing may transcribe the customer's audio`);
    assert.ok(!/translate|translation/i.test(blob), `${label}: nothing may translate it either`);
  }
  // And the endpoint it DOES call is the audio-to-audio one.
  assert.ok(convertBody.includes("/speech-to-speech/"), "the conversion must go to the speech-to-speech endpoint");
});

test("⛔ the convert route needs BOTH the prompt-manager gate and the voice-changer key", () => {
  const src = read("elevenLabsRoutes.ts");
  assert.ok(
    src.includes("async function requireVoiceChangerUser"),
    "the two-gate helper must exist — can_manage_ivr_prompts alone must never be enough",
  );
  const gate = src.slice(src.indexOf("async function requireVoiceChangerUser"), src.indexOf("// ── GET /voice/elevenlabs/voice-changer/status"));
  assert.ok(gate.includes("requirePromptManager"), "gate must still require the prompt-manager permission");
  assert.ok(gate.includes("hasVoiceChangerPermission"), "gate must also require can_use_voice_changer");

  const route = src.slice(src.indexOf('app.post("/voice/ivr/prompts/convert"'));
  assert.ok(route.length > 200, "convert route not found — this guard would silently pass");
  assert.ok(route.includes("requireVoiceChangerUser"), "the convert route must use the two-gate helper, not the single one");
});

test("⛔ the status route answers allowed:false, never 403 — an unpermitted user is not an error", () => {
  const src = read("elevenLabsRoutes.ts");
  const start = src.indexOf('app.get("/voice/elevenlabs/voice-changer/status"');
  assert.ok(start > 0, "status route not found");
  const route = src.slice(start, src.indexOf('app.post("/voice/ivr/prompts/convert"'));
  assert.ok(route.includes("allowed: false"), "must report the ordinary un-permitted case as data");
  assert.ok(
    !/reply\.code\(403\)/.test(route),
    "a 403 here fills the console on every page open for every user who simply does not have the feature",
  );
  // It must use the plain prompt-manager gate, so it can REPORT the answer
  // rather than refusing before it can.
  assert.ok(route.includes("requirePromptManager"), "status must resolve the user without the voice-changer gate refusing first");
});

test("⛔ the cost guard runs BEFORE the provider is called", () => {
  const src = read("elevenLabsRoutes.ts");
  const route = src.slice(src.indexOf('app.post("/voice/ivr/prompts/convert"'));
  const probeAt = route.indexOf("probeAudioSeconds");
  const convertAt = route.indexOf("convertSpeech(key");
  assert.ok(probeAt > 0, "the duration probe must be in the route");
  assert.ok(convertAt > 0, "the conversion call must be in the route");
  assert.ok(probeAt < convertAt, "billing is per minute — the length must be known before any audio is sent");
  assert.ok(route.includes("MAX_CONVERT_SECONDS"), "the cap must actually be applied");
  assert.ok(
    route.includes("audio_unreadable"),
    "a file whose length we cannot read must be refused, not forwarded on trust — that would be billing blind",
  );
});

test("⛔ server.ts passes the voice-changer key through, and it is an authoritative key check", () => {
  const src = read("..", "server.ts");
  assert.ok(
    src.includes('hasVoiceChangerPermission: (user) => userHasActionPermission(user, "can_use_voice_changer")'),
    "without this wiring the feature registers but nobody can ever reach it",
  );
  // No role fallback: a tenant admin does not get the voice changer merely for
  // being a tenant admin, exactly as with Polly.
  const block = src.slice(src.indexOf("registerElevenLabsRoutes({"), src.indexOf("registerPollyRoutes({"));
  assert.ok(!/isAdminRole|TENANT_ADMIN/.test(block), "no role shortcut may bypass the key");
});

test("the duration and size caps are deliberately below the provider's own limits", () => {
  // ElevenLabs allows 5 minutes / 50 MB. Ours are a SPENDING limit, not a
  // technical one, so the refusal is ours and in plain English.
  assert.ok(MAX_CONVERT_SECONDS < 300, "must refuse before the provider does");
  assert.ok(MAX_CONVERT_BYTES < 50 * 1024 * 1024, "must refuse before the provider does");
});
