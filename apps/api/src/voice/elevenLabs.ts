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

const API_ROOT = "https://api.elevenlabs.io/v1";

/** How long we'll wait on ElevenLabs before giving up. Generous — synthesis of
 *  a long greeting is genuinely slow — but not unbounded. */
const REQUEST_TIMEOUT_MS = 60_000;

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
  constructor(
    message: string,
    readonly httpStatus: number,
    /** Safe to show a customer — never contains the key or raw provider JSON. */
    readonly userMessage: string,
  ) {
    super(message);
    this.name = "ElevenLabsError";
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

/** Read ElevenLabs' structured `detail` object, when there is one. */
export function classify(body: string): string | null {
  let code = "";
  try {
    const j = JSON.parse(body);
    code = String(j?.detail?.status || j?.detail?.code || j?.detail?.type || "");
  } catch {
    // Some errors come back as plain text; the substring checks below still work.
  }
  const hay = `${code} ${body}`.toLowerCase();

  if (/payment_issue|payment_required|past_due|failed or incomplete payment/.test(hay)) {
    return "ElevenLabs has an unpaid invoice on the account, so it won't make new recordings. The key is fine — settle the bill at elevenlabs.io and this starts working again.";
  }
  if (/quota_exceeded|character limit|out of credits/.test(hay)) {
    return "The ElevenLabs account has used all its characters for this month. It resets on the next billing date, or you can upgrade the plan.";
  }
  if (/detected_unusual_activity|abuse/.test(hay)) {
    return "ElevenLabs has flagged unusual activity on the account and paused it. You'll need to sort that out with them directly.";
  }
  if (/invalid_api_key|missing_api_key|needs_authorization/.test(hay)) {
    return "The ElevenLabs key was rejected. Check it on the ElevenLabs settings page.";
  }
  if (/voice_not_found/.test(hay)) {
    return "That voice is no longer on the ElevenLabs account. Pick another one.";
  }
  return null;
}

async function call(
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown; accept?: string } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_ROOT}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "xi-api-key": apiKey,
        Accept: init.accept ?? "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      // Read at most a snippet: provider errors can be enormous, and the body
      // is only ever used to classify, never shown verbatim.
      const text = (await res.text().catch(() => "")).slice(0, 400);
      throw new ElevenLabsError(`elevenlabs_${res.status}`, res.status, explain(res.status, text));
    }
    return res;
  } catch (err: any) {
    if (err instanceof ElevenLabsError) throw err;
    if (err?.name === "AbortError") {
      throw new ElevenLabsError("elevenlabs_timeout", 504, "ElevenLabs took too long to answer. Try again.");
    }
    throw new ElevenLabsError(`elevenlabs_unreachable: ${err?.message}`, 502, "Couldn't reach ElevenLabs.");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is this key real, AND can the account actually make a recording?
 *
 * Those are two different questions and the settings page needs both. A key
 * whose account is `past_due` answers this endpoint happily with 200 — so
 * checking only "did the request succeed" produces a green "connected" badge on
 * a system that fails the moment anyone presses Generate. `status` and
 * `has_open_invoices` say so up front, for free, without spending a character.
 */
export async function checkElevenLabsKey(apiKey: string): Promise<{
  ok: boolean;
  /** The key works AND the account is in a state that can synthesise. */
  usable?: boolean;
  characterCount?: number;
  characterLimit?: number;
  tier?: string;
  /** Present whenever `usable` is false — always says what to do about it. */
  userMessage?: string;
}> {
  try {
    const res = await call(apiKey, "/user/subscription");
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
    if (status === "past_due" || j?.has_open_invoices === true) {
      return {
        ...base,
        usable: false,
        userMessage:
          "ElevenLabs has an unpaid invoice on the account, so it won't make new recordings. The key is fine — settle the bill at elevenlabs.io and this starts working again.",
      };
    }
    if (limit > 0 && used >= limit) {
      return {
        ...base,
        usable: false,
        userMessage:
          "The ElevenLabs account has used all its characters for this month. It resets on the next billing date, or you can upgrade the plan.",
      };
    }
    return { ...base, usable: true };
  } catch (err: any) {
    return { ok: false, usable: false, userMessage: err?.userMessage || "Couldn't check the key." };
  }
}

export async function listElevenLabsVoices(apiKey: string): Promise<ElevenVoice[]> {
  const res = await call(apiKey, "/voices");
  const j: any = await res.json();
  const raw: any[] = Array.isArray(j?.voices) ? j.voices : [];
  return raw
    .map((v) => ({
      voiceId: String(v?.voice_id ?? ""),
      name: String(v?.name ?? "Unnamed"),
      labels: v?.labels && typeof v.labels === "object" ? (v.labels as Record<string, string>) : {},
      previewUrl: typeof v?.preview_url === "string" ? v.preview_url : null,
      category: typeof v?.category === "string" ? v.category : null,
    }))
    .filter((v) => v.voiceId);
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
        throw new ElevenLabsError("empty_audio", 502, "ElevenLabs returned no audio. Try again.");
      }
      return { pcm, sampleRate: rate, model };
    } catch (err: any) {
      const canRetryAtHigherRate = format === "pcm_8000" && err instanceof ElevenLabsError && (err.httpStatus === 400 || err.httpStatus === 403 || err.httpStatus === 422);
      if (!canRetryAtHigherRate) throw err;
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new ElevenLabsError("elevenlabs_no_format", 502, "Couldn't generate the audio. Nothing was changed.");
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
