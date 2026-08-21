/**
 * ElevenLabs text-to-speech for IVR greetings.
 *
 * Why this lives in apps/api and not apps/agent
 * ─────────────────────────────────────────────
 * The agent owns the API key (SecretStore → AgentSecret, AES-256-GCM), but the
 * API owns everything a greeting needs after it exists: prompt storage, the
 * TenantPbxPrompt catalog, the tenant-scoped stream route, and the Connect→PBX
 * push. Moving audio across a process boundary to reach all of that would buy
 * nothing. Both processes hold the same CREDENTIALS_MASTER_KEY and talk to the
 * same database, so the API reads the key the agent stored — one owner of the
 * secret, one owner of the audio.
 *
 * The key is never returned to a caller and never logged, here or anywhere.
 *
 * Format: we ask ElevenLabs for `pcm_8000` — 8 kHz mono 16-bit, which is the
 * native rate of the phone network. Anything higher gets resampled downstream
 * (by us, or failing that by Asterisk), and every resample is a chance to sound
 * worse. Some plans don't expose pcm_8000; we fall back to pcm_16000 and let
 * ffmpeg do the one downsample. Either way the bytes that reach the PBX are the
 * 8 kHz WAV the dialplan expects.
 */

import { Buffer } from "node:buffer";
import {
  classifyElevenLabsFailure,
  describeElevenLabsFailure,
  ELEVENLABS_CUSTOMER_BUSY,
  ELEVENLABS_CUSTOMER_UNAVAILABLE,
} from "@connect/shared";

const API_ROOT = "https://api.elevenlabs.io/v1";

/** How long we'll wait on ElevenLabs before giving up. Generous — synthesis of
 *  a long greeting is genuinely slow — but not unbounded. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Account checks and voice lists are quick calls that gate page loads; if
 *  they haven't answered in this long they aren't going to. Synthesis keeps
 *  the generous default. */
const METADATA_TIMEOUT_MS = 15_000;

/** Guard against someone pasting an essay into the greeting box. ElevenLabs
 *  charges per character and a phone greeting is never this long. */
export const MAX_TTS_CHARS = 2_500;

export interface ElevenVoice {
  voiceId: string;
  name: string;
  /** ElevenLabs' own descriptors — accent, age, gender, use case. */
  labels: Record<string, string>;
  previewUrl: string | null;
  category: string | null;
}

/**
 * Voice settings, tuned for a phone menu rather than an audiobook.
 *
 * These are the knobs ElevenLabs exposes, in the terms a customer actually
 * cares about. The defaults below are the IVR preset:
 *
 *   stability 0.75 — a greeting is read the same way every time. High
 *     stability removes the performance-y variation that sounds charming once
 *     and grating on the fortieth listen. Too high (1.0) goes flat and robotic.
 *   similarity 0.75 — stays recognisably the chosen voice without over-fitting
 *     to artefacts in the original sample, which 8 kHz makes worse, not better.
 *   style 0 — style exaggeration adds emotion AND latency AND instability.
 *     A menu does not need emotion.
 *   speaker boost on — modest clarity gain, and clarity is the whole job when
 *     the audio has already been squeezed into a phone line.
 *   speed 0.95 — very slightly slower than natural. Callers are listening for
 *     a number to press, often in traffic, often on a bad line.
 */
export interface VoiceTuning {
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
  speed: number;
}

export const IVR_VOICE_TUNING: VoiceTuning = {
  stability: 0.75,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: true,
  speed: 0.95,
};

/**
 * Model choice, again in plain terms:
 *  - flash v2.5  — fastest and cheapest. On an 8 kHz phone line the quality
 *    difference is mostly inaudible, which makes it the right default here.
 *  - turbo v2.5  — middle ground.
 *  - multilingual v2 — best quality and the widest language support; worth it
 *    for a greeting that a whole business is judged by, or non-English text.
 */
export const TTS_MODELS = [
  { id: "eleven_flash_v2_5", label: "Fast", detail: "Quickest and cheapest. Sounds the same over a phone line." },
  { id: "eleven_turbo_v2_5", label: "Balanced", detail: "A little more natural, still quick." },
  { id: "eleven_multilingual_v2", label: "Best quality", detail: "Slowest, and the best choice for other languages." },
] as const;

export type TtsModelId = (typeof TTS_MODELS)[number]["id"];

export function isTtsModelId(v: unknown): v is TtsModelId {
  return TTS_MODELS.some((m) => m.id === v);
}

export class ElevenLabsError extends Error {
  /** Safe for a customer — see the constructor note. */
  readonly customerMessage: string;

  constructor(
    message: string,
    readonly httpStatus: number,
    /**
     * For Connect staff. Never contains the key or raw provider JSON, but it
     * DOES name the provider and our account state — so it is not for a
     * customer's eyes. Route handlers choose by role; see `customerMessage`.
     */
    readonly userMessage: string,
    /** ElevenLabs' own `detail.status`, when they sent one ("quota_exceeded",
     *  "invalid_api_key_prefix", …). Lets callers branch on the actual reason
     *  rather than on a status code that means several different things. */
    readonly providerCode: string = "",
    /**
     * Safe for a customer. Defaults to `userMessage`, which is correct for the
     * errors we raise ourselves — "type the greeting first", "pick a voice" —
     * because those are about what the customer just did. Provider failures
     * pass an explicit neutral message instead.
     */
    customerMessage?: string,
    /** Our account or our supplier — not the customer, and not their fault. */
    readonly ourProblem: boolean = false,
  ) {
    super(message);
    this.name = "ElevenLabsError";
    this.customerMessage = customerMessage ?? userMessage;
  }
}

/** ElevenLabs' machine-readable reason, or "" if they didn't send one. */
function providerCodeOf(body: string): string {
  try {
    const j = JSON.parse(body);
    return String(j?.detail?.status || j?.detail?.code || j?.detail?.type || "");
  } catch {
    return "";
  }
}

/**
 * Turn a provider failure into something a non-technical person can act on.
 *
 * The status code alone is not enough, and reading it as though it were sends
 * people to fix the wrong thing. A real example: a perfectly valid key with an
 * unpaid ElevenLabs invoice returns **401** on synthesis while `/voices` and
 * `/user/subscription` both answer 200. Reported as "the key was rejected",
 * that costs someone an afternoon re-pasting a key that was never wrong.
 * ElevenLabs puts the actual reason in `detail.status` / `detail.code`, so we
 * read that first and fall back to the status code.
 */
function explain(status: number, body: string): string {
  const reason = classify(body);
  if (reason) return reason;
  if (status === 401) return "The ElevenLabs key was rejected. Check it on the ElevenLabs settings page.";
  if (status === 429) return "ElevenLabs is rate-limiting us right now. Try again in a moment.";
  if (status === 422 && /quota|credit/i.test(body)) return "The ElevenLabs account is out of credits.";
  if (status === 422) return "ElevenLabs couldn't read that text. Try shortening it or removing unusual characters.";
  if (status >= 500) return "ElevenLabs is having trouble at their end. Try again shortly.";
  return "Couldn't generate the audio. Nothing was changed.";
}

/**
 * The same failure, told to a customer.
 *
 * Never names the supplier and never mentions our account. The one exception
 * is text the customer typed — 422 on unreadable text is genuinely theirs to
 * fix, and hiding that would leave them stuck with no way forward.
 */
function explainForCustomer(status: number, body: string): { message: string; ourProblem: boolean } {
  const known = describeElevenLabsFailure(body);
  if (known) return { message: known.customerMessage, ourProblem: known.ourProblem };
  if (status === 429) return { message: ELEVENLABS_CUSTOMER_BUSY, ourProblem: false };
  if (status === 422 && !/quota|credit/i.test(body)) {
    return { message: "Some of that text couldn't be read. Try shortening it or removing unusual characters.", ourProblem: false };
  }
  if (status >= 500) return { message: "The voice service is having trouble right now. Try again shortly.", ourProblem: true };
  return { message: ELEVENLABS_CUSTOMER_UNAVAILABLE, ourProblem: true };
}

/**
 * Read ElevenLabs' structured `detail` object, when there is one.
 *
 * The rules themselves live in @connect/shared so the agent's settings page
 * and this app cannot drift apart and describe the same failure two different
 * ways — which is what let a retired-format key read as "unreachable" on one
 * screen and "rejected" on the other.
 */
export function classify(body: string): string | null {
  return classifyElevenLabsFailure(body);
}

async function call(
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown; accept?: string; timeoutMs?: number } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_ROOT}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "xi-api-key": apiKey,
        Accept: init.accept ?? "application/json",
        // ⛔ Never set Content-Type for FormData. fetch generates a multipart
        // boundary token and puts it IN that header; overriding it produces a
        // body the provider cannot parse, and the failure comes back as a
        // generic 400 that reads like a bad request rather than a bad header.
        ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body instanceof FormData ? init.body : init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      // Read at most a snippet: provider errors can be enormous, and the body
      // is only ever used to classify, never shown verbatim.
      const text = (await res.text().catch(() => "")).slice(0, 400);
      const forCustomer = explainForCustomer(res.status, text);
      throw new ElevenLabsError(
        `elevenlabs_${res.status}`,
        res.status,
        explain(res.status, text),
        providerCodeOf(text),
        forCustomer.message,
        forCustomer.ourProblem,
      );
    }
    return res;
  } catch (err: any) {
    if (err instanceof ElevenLabsError) throw err;
    if (err?.name === "AbortError") {
      throw new ElevenLabsError("elevenlabs_timeout", 504, "ElevenLabs took too long to answer. Try again.", "", "The voice service took too long to answer. Try again.", true);
    }
    throw new ElevenLabsError(`elevenlabs_unreachable: ${err?.message}`, 502, "Couldn't reach ElevenLabs.", "", "Couldn't reach the voice service. Try again shortly.", true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retry a READ once on the failures that are usually transient — rate limits,
 * provider 5xx, network drops. Never used for synthesis: retrying a POST that
 * may already have been billed spends the customer's characters twice.
 */
async function callRead(apiKey: string, path: string): Promise<Response> {
  try {
    return await call(apiKey, path, { timeoutMs: METADATA_TIMEOUT_MS });
  } catch (err: any) {
    const transient = err instanceof ElevenLabsError && (err.httpStatus === 429 || err.httpStatus >= 500);
    if (!transient) throw err;
    await new Promise((r) => setTimeout(r, 400));
    return call(apiKey, path, { timeoutMs: METADATA_TIMEOUT_MS });
  }
}

/**
 * Short-lived caches for the two read calls.
 *
 * The status endpoint is hit every time the recording modal or the settings
 * page opens, and each hit was two live round-trips to ElevenLabs. Caching for
 * half a minute makes those opens instant, stops a page-refresh storm from
 * tripping their rate limiter, and rides out short provider blips. Thirty
 * seconds is short enough that a just-paid invoice or a just-added voice still
 * shows up while the person is looking at the page.
 *
 * Only successes are cached — a failure must stay a live question, or saving a
 * corrected key would keep reporting the old failure for half a minute.
 */
const READ_CACHE_MS = 30_000;
const subscriptionCache = new Map<string, { at: number; value: KeyCheck }>();
const voicesCache = new Map<string, { at: number; value: ElevenVoice[] }>();

/** Tests (and a key change mid-session) need a clean slate. */
export function clearElevenLabsReadCaches(): void {
  subscriptionCache.clear();
  voicesCache.clear();
}

function cacheGet<T>(map: Map<string, { at: number; value: T }>, key: string): T | null {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < READ_CACHE_MS) return hit.value;
  if (hit) map.delete(key);
  return null;
}

function cacheSet<T>(map: Map<string, { at: number; value: T }>, key: string, value: T): void {
  // One key exists in practice; the bound is just a leak guard for key churn.
  if (map.size > 8) map.clear();
  map.set(key, { at: Date.now(), value });
}

export interface KeyCheck {
  ok: boolean;
  /** The key works AND the account is in a state that can synthesise. */
  usable?: boolean;
  characterCount?: number;
  characterLimit?: number;
  tier?: string;
  /** Present whenever `usable` is false — always says what to do about it.
   *  Written for Connect staff: it names the provider and our account state. */
  userMessage?: string;
  /** The same situation told to a customer — no provider, no billing, no key. */
  customerMessage?: string;
  /** Our account or supplier, not anything the customer did. */
  ourProblem?: boolean;
}

/**
 * Is this key real, AND can the account actually make a recording?
 *
 * Those are two different questions and the settings page needs both. A key
 * whose account is `past_due` answers this endpoint happily with 200 — so
 * checking only "did the request succeed" produces a green "connected" badge on
 * a system that fails the moment anyone presses Generate. `status` says so up
 * front, for free, without spending a character.
 *
 * The opposite mistake is worse, and we made it: blocking on a signal that
 * does NOT mean the account is stuck. Only refuse on evidence the provider
 * will actually refuse — see the note in the body.
 */
export async function checkElevenLabsKey(apiKey: string): Promise<KeyCheck> {
  const cached = cacheGet(subscriptionCache, apiKey);
  if (cached) return cached;
  try {
    const res = await callRead(apiKey, "/user/subscription");
    const j: any = await res.json();
    const used = Number(j?.character_count ?? 0);
    const limit = Number(j?.character_limit ?? 0);
    const base = {
      ok: true as const,
      characterCount: used,
      characterLimit: limit,
      tier: typeof j?.tier === "string" ? j.tier : undefined,
    };

    const status = String(j?.status ?? "").toLowerCase();
    let result: KeyCheck;
    // ⛔ `has_open_invoices` is NOT proof of arrears and must never block on
    // its own. Proven on the live account 2026-08-06: status "active",
    // has_open_invoices true, next payment attempt a month away — and
    // synthesis answered 200 with real audio. We were refusing to even try,
    // and telling the customer about an unpaid bill that did not exist. An
    // "open invoice" includes the NEXT one, which is open on every healthy
    // account for most of every month.
    //
    // `past_due` is different and is the one that genuinely blocks: proven the
    // same night on another key, where /voices and /user/subscription both
    // answered 200 while synthesis was refused 401 payment_issue.
    //
    // The rule this encodes: let the provider refuse. Pre-emptively refusing
    // on a soft signal turns a working account into a broken feature, and the
    // customer cannot tell the difference.
    if (status === "past_due") {
      result = {
        ...base,
        usable: false,
        userMessage:
          "ElevenLabs has an unpaid invoice on the account, so it won't make new recordings. The key is fine — settle the bill at elevenlabs.io and this starts working again.",
        // Proven live 2026-08-06: with the account past_due, ElevenLabs refuses
        // synthesis outright (401 payment_issue) even though this endpoint and
        // /voices both answer 200. So this really is unusable — but why is our
        // business, not the customer's.
        customerMessage: ELEVENLABS_CUSTOMER_UNAVAILABLE,
        ourProblem: true,
      };
    } else if (limit > 0 && used >= limit) {
      result = {
        ...base,
        usable: false,
        userMessage:
          "The ElevenLabs account has used all its characters for this month. It resets on the next billing date, or you can upgrade the plan.",
        customerMessage: ELEVENLABS_CUSTOMER_UNAVAILABLE,
        ourProblem: true,
      };
    } else {
      result = { ...base, usable: true };
    }
    // "Not usable" is still a definitive answer from the provider, so it
    // caches too; only a failure to ASK stays uncached.
    cacheSet(subscriptionCache, apiKey, result);
    return result;
  } catch (err: any) {
    return {
      ok: false,
      usable: false,
      userMessage: err?.userMessage || "Couldn't check the key.",
      customerMessage: err?.customerMessage || ELEVENLABS_CUSTOMER_UNAVAILABLE,
      ourProblem: err?.ourProblem ?? true,
    };
  }
}

export async function listElevenLabsVoices(apiKey: string): Promise<ElevenVoice[]> {
  const cached = cacheGet(voicesCache, apiKey);
  if (cached) return cached;
  const res = await callRead(apiKey, "/voices");
  const j: any = await res.json();
  const raw: any[] = Array.isArray(j?.voices) ? j.voices : [];
  const voices = raw
    .map((v) => ({
      voiceId: String(v?.voice_id ?? ""),
      name: String(v?.name ?? "Unnamed"),
      labels: v?.labels && typeof v.labels === "object" ? (v.labels as Record<string, string>) : {},
      previewUrl: typeof v?.preview_url === "string" ? v.preview_url : null,
      category: typeof v?.category === "string" ? v.category : null,
    }))
    .filter((v) => v.voiceId);
  cacheSet(voicesCache, apiKey, voices);
  return voices;
}

/**
 * Synthesise a greeting.
 *
 * Returns raw PCM plus the sample rate it actually came back at, because the
 * caller has to wrap it in a WAV header and only it knows the rate for certain
 * — asking for pcm_8000 does not guarantee getting it on every plan.
 */
export async function synthesiseSpeech(
  apiKey: string,
  input: {
    voiceId: string;
    text: string;
    model?: TtsModelId;
    tuning?: Partial<VoiceTuning>;
  },
): Promise<{ pcm: Buffer; sampleRate: number; model: TtsModelId }> {
  const text = String(input.text ?? "").trim();
  if (!text) throw new ElevenLabsError("empty_text", 400, "There's nothing to say — type the greeting first.");
  if (text.length > MAX_TTS_CHARS) {
    throw new ElevenLabsError("text_too_long", 400, `That's longer than a phone greeting should be (max ${MAX_TTS_CHARS} characters).`);
  }
  if (!input.voiceId) throw new ElevenLabsError("no_voice", 400, "Pick a voice first.");

  const model: TtsModelId = isTtsModelId(input.model) ? input.model : "eleven_flash_v2_5";
  const t = { ...IVR_VOICE_TUNING, ...(input.tuning ?? {}) };

  const body = {
    text,
    model_id: model,
    voice_settings: {
      stability: clamp01(t.stability),
      similarity_boost: clamp01(t.similarityBoost),
      style: clamp01(t.style),
      use_speaker_boost: Boolean(t.useSpeakerBoost),
      speed: Math.min(1.2, Math.max(0.7, Number(t.speed) || 1)),
    },
  };

  // Ask for phone-native 8 kHz first. If the plan doesn't allow it, fall back
  // to 16 kHz rather than failing the whole request — one downsample by ffmpeg
  // is a far better outcome for the customer than an error.
  for (const [format, rate] of [["pcm_8000", 8000], ["pcm_16000", 16000]] as const) {
    try {
      const res = await call(apiKey, `/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=${format}`, {
        method: "POST",
        body,
        accept: "audio/*",
      });
      const pcm = Buffer.from(await res.arrayBuffer());
      if (pcm.length === 0) {
        throw new ElevenLabsError("empty_audio", 502, "ElevenLabs returned no audio. Try again.", "", "No audio came back. Try again.", true);
      }
      return { pcm, sampleRate: rate, model };
    } catch (err: any) {
      // Only the format is worth retrying at a higher rate. A rejected key
      // also answers 400 — asking again in 16 kHz cannot possibly help, and
      // the second failure is what buries the first, useful message.
      const aboutTheKey = err instanceof ElevenLabsError && /api_key|authentication/i.test(err.providerCode);
      const canRetryAtHigherRate =
        format === "pcm_8000" &&
        err instanceof ElevenLabsError &&
        !aboutTheKey &&
        (err.httpStatus === 400 || err.httpStatus === 403 || err.httpStatus === 422);
      if (!canRetryAtHigherRate) throw err;
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new ElevenLabsError("elevenlabs_no_format", 502, "Couldn't generate the audio. Nothing was changed.");
}

/**
 * Narration — text to speech for a BROWSER to play, not for a phone line.
 *
 * ⛔⛔ THIS IS A SIBLING OF `synthesiseSpeech`, NOT A FLAG ON IT, AND THAT IS
 * DELIBERATE. That function exists to feed Asterisk: it asks for `pcm_8000`
 * first and falls back to `pcm_16000`, because 8 kHz is what the phone network
 * actually carries and resampling later only ever sounds worse. Every one of
 * those decisions is wrong for a person listening on a laptop. Adding an
 * `outputFormat` branch there would put the IVR greeting path — which is live
 * for real customers — one edit away from a narration change.
 *
 * So: mp3 at 44.1 kHz, ready to hand straight to an <audio> element. No PCM,
 * no WAV header, no ffmpeg, nothing stored anywhere.
 *
 * ⛔ NO FORMAT FALLBACK LADDER. `synthesiseSpeech` retries at a higher sample
 * rate because a plan may not expose pcm_8000; mp3_44100_128 is available on
 * every tier, so a failure here means something real and a second POST would
 * only bill twice for the same words.
 *
 * ⛔ BILLED PER CHARACTER. The caller MUST bound the text — see
 * MAX_NARRATION_CHARS. Nothing about a failure is retryable.
 */
export const MAX_NARRATION_CHARS = 3_000;

/** The mp3 profile every ElevenLabs tier exposes. */
const NARRATION_FORMAT = "mp3_44100_128";

/**
 * Tuning for reading a written answer aloud.
 *
 * Higher stability than the IVR voice because this is prose, not a greeting —
 * an expressive read of a technical paragraph is harder to follow, not easier.
 * Style stays at 0 for the same reason.
 */
export const NARRATION_VOICE_TUNING: VoiceTuning = {
  stability: 0.55,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: true,
  speed: 1,
};

export async function synthesiseNarration(
  apiKey: string,
  input: { voiceId: string; text: string; model?: TtsModelId; tuning?: Partial<VoiceTuning> },
): Promise<{ mp3: Buffer; model: TtsModelId }> {
  const text = String(input.text ?? "").trim();
  if (!text) throw new ElevenLabsError("empty_text", 400, "There's nothing to read out.");
  if (text.length > MAX_NARRATION_CHARS) {
    throw new ElevenLabsError(
      "text_too_long",
      400,
      `That's longer than this reads aloud (max ${MAX_NARRATION_CHARS} characters).`,
    );
  }
  if (!input.voiceId) throw new ElevenLabsError("no_voice", 400, "No voice was chosen.");

  const model: TtsModelId = isTtsModelId(input.model) ? input.model : "eleven_flash_v2_5";
  const t = { ...NARRATION_VOICE_TUNING, ...(input.tuning ?? {}) };

  const res = await call(apiKey, `/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=${NARRATION_FORMAT}`, {
    method: "POST",
    accept: "audio/*",
    body: {
      text,
      model_id: model,
      voice_settings: {
        stability: clamp01(t.stability),
        similarity_boost: clamp01(t.similarityBoost),
        style: clamp01(t.style),
        use_speaker_boost: Boolean(t.useSpeakerBoost),
        speed: Math.min(1.2, Math.max(0.7, Number(t.speed) || 1)),
      },
    },
  });

  const mp3 = Buffer.from(await res.arrayBuffer());
  if (mp3.length === 0) {
    throw new ElevenLabsError("empty_audio", 502, "ElevenLabs returned no audio.", "", "No audio came back.", true);
  }
  return { mp3, model };
}

/**
 * Voice changer (ElevenLabs calls it "speech to speech").
 *
 * ⛔⛔ THIS IS NOT TRANSCRIPTION AND MUST NEVER BECOME IT. Audio goes in, audio
 * comes out; the words are never turned into text at any point. That is the
 * entire reason it works on Yiddish — no speech engine on the market can
 * transcribe or speak Yiddish, but the voice changer does not need to know what
 * was said. It re-voices the sounds. If anyone ever "improves" this by routing
 * it through speech recognition and text-to-speech, every language we actually
 * care about stops working.
 *
 * What the customer keeps: their words, timing, pauses, rhythm, emphasis,
 * accent and emotion. What changes: who it sounds like. There is deliberately
 * no speed or rhythm control — ElevenLabs does not expose one on this endpoint,
 * and the pacing coming from the original performance is the feature.
 *
 * ⛔ Billing is PER MINUTE OF AUDIO here, not per character as it is for
 * text-to-speech, so MAX_TTS_CHARS has no equivalent and the caller MUST bound
 * the duration before calling this. See MAX_CONVERT_SECONDS.
 */
export const VOICE_CHANGER_MODELS = [
  {
    id: "eleven_multilingual_sts_v2",
    label: "Any language",
    detail: "The right choice for Yiddish and anything else. ElevenLabs recommend it even for English.",
  },
  { id: "eleven_english_sts_v2", label: "English only", detail: "Slightly tuned for English. Nothing else." },
] as const;

export type VoiceChangerModelId = (typeof VOICE_CHANGER_MODELS)[number]["id"];

export function isVoiceChangerModelId(v: unknown): v is VoiceChangerModelId {
  return VOICE_CHANGER_MODELS.some((m) => m.id === v);
}

/**
 * How much audio we will convert in one request.
 *
 * ElevenLabs' own ceiling is 5 minutes / 50 MB, but theirs is a technical limit
 * and this is a spending limit — a phone greeting is seconds long, and the
 * difference between a 30-second recording and somebody uploading an hour of a
 * meeting is entirely a billing question. Deliberately well under the provider
 * limit so the refusal is ours, in plain English, before any money moves.
 */
export const MAX_CONVERT_SECONDS = 180;

/** Bytes we will accept regardless of duration — a crude backstop for a file
 *  whose duration we could not read. Well under the provider's 50 MB. */
export const MAX_CONVERT_BYTES = 20 * 1024 * 1024;

/**
 * Re-voice a recording. Returns raw PCM plus the rate it actually arrived at,
 * exactly like synthesiseSpeech, so both feed the same pcmToWav → store →
 * push-to-PBX tail with no special cases downstream.
 */
export async function convertSpeech(
  apiKey: string,
  input: {
    voiceId: string;
    /** The recording as uploaded. Sent to the provider AS-IS — see below. */
    audio: Buffer;
    filename: string;
    contentType?: string;
    model?: VoiceChangerModelId;
    tuning?: Partial<VoiceTuning>;
    /** Ask the provider to strip room noise before converting. Off by default:
     *  it is a real change to the customer's audio and should be a choice. */
    removeBackgroundNoise?: boolean;
  },
): Promise<{ pcm: Buffer; sampleRate: number; model: VoiceChangerModelId }> {
  if (!input.voiceId) throw new ElevenLabsError("no_voice", 400, "Pick the voice to convert into first.");
  if (!input.audio?.length) throw new ElevenLabsError("empty_audio_upload", 400, "That file had no audio in it.");
  if (input.audio.length > MAX_CONVERT_BYTES) {
    throw new ElevenLabsError(
      "audio_too_large",
      400,
      `That recording is too big (limit ${Math.floor(MAX_CONVERT_BYTES / (1024 * 1024))} MB).`,
    );
  }

  const model: VoiceChangerModelId = isVoiceChangerModelId(input.model) ? input.model : "eleven_multilingual_sts_v2";
  const t = { ...IVR_VOICE_TUNING, ...(input.tuning ?? {}) };

  // ⛔ The recording is forwarded to the provider in the format it arrived in.
  // ElevenLabs accepts mp3/m4a/wav/flac/ogg directly, which covers every phone
  // and browser, and transcoding first would throw away quality for nothing —
  // every re-encode of already-lossy phone audio is damage the voice changer
  // then has to work through.
  const build = (): FormData => {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(input.audio)], { type: input.contentType || "application/octet-stream" }), input.filename || "recording");
    form.append("model_id", model);
    // ⛔ voice_settings goes over multipart as a JSON *string*, not as fields.
    // Sent as individual form fields it is silently ignored and every tuning
    // dial in the UI quietly does nothing.
    form.append(
      "voice_settings",
      JSON.stringify({
        stability: clamp01(t.stability),
        similarity_boost: clamp01(t.similarityBoost),
        style: clamp01(t.style),
        use_speaker_boost: Boolean(t.useSpeakerBoost),
      }),
    );
    if (input.removeBackgroundNoise) form.append("remove_background_noise", "true");
    return form;
  };

  // Same 8 kHz-first ladder as synthesiseSpeech, and for the same reason: it is
  // the native rate of the phone network, so a successful pcm_8000 answer needs
  // no resampling at all before it reaches Asterisk.
  for (const [format, rate] of [["pcm_8000", 8000], ["pcm_16000", 16000]] as const) {
    try {
      const res = await call(apiKey, `/speech-to-speech/${encodeURIComponent(input.voiceId)}?output_format=${format}`, {
        method: "POST",
        body: build(),
        accept: "audio/*",
      });
      const pcm = Buffer.from(await res.arrayBuffer());
      if (pcm.length === 0) {
        throw new ElevenLabsError("empty_audio", 502, "The voice service returned no audio. Try again.", "", "No audio came back. Try again.", true);
      }
      return { pcm, sampleRate: rate, model };
    } catch (err: any) {
      // Identical reasoning to synthesiseSpeech: only the FORMAT is worth a
      // second attempt. A rejected key also answers 400, and retrying at 16 kHz
      // cannot help — it only buries the one useful message under a duplicate.
      const aboutTheKey = err instanceof ElevenLabsError && /api_key|authentication/i.test(err.providerCode);
      const canRetryAtHigherRate =
        format === "pcm_8000" &&
        err instanceof ElevenLabsError &&
        !aboutTheKey &&
        (err.httpStatus === 400 || err.httpStatus === 403 || err.httpStatus === 422);
      if (!canRetryAtHigherRate) throw err;
    }
  }
  throw new ElevenLabsError("elevenlabs_no_format", 502, "Couldn't convert the recording. Nothing was changed.");
}

function clamp01(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * Wrap raw signed 16-bit little-endian mono PCM in a WAV header.
 *
 * ElevenLabs returns headerless PCM. Writing the 44-byte header here means an
 * 8 kHz response needs no conversion at all — it is already exactly the format
 * `/var/lib/asterisk/sounds/custom/<base>.wav` wants. (Anything not already at
 * 8 kHz still goes through convertToPbxWav.)
 */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);          // fmt chunk size
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Seconds of audio in a 16-bit mono PCM buffer, for "that's 12 seconds long". */
export function pcmDurationSeconds(pcm: Buffer, sampleRate: number): number {
  if (sampleRate <= 0) return 0;
  return Math.round((pcm.length / 2 / sampleRate) * 10) / 10;
}
