/**
 * Creative Studio — engines.
 *
 * Loopcom's own vocabulary on the outside ("make me a 15-second production
 * shot, 16:9"), each provider's vocabulary on the inside. Nothing above this
 * file knows what a model is called, how long a clip it can natively make, or
 * what its parameters are spelled.
 *
 * ⛔ An engine may only be used if its licence permits commercial use. That is
 * a column on CreativeEngine, checked in chooseEngine(), not a comment.
 *
 * Verified against the live APIs on 2026-09-16:
 *   - images: gpt-image-2.5-flare / -sunburst, gpt-image-2, gpt-image-1*
 *   - video:  sora-2 and sora-2-pro; seconds ∈ {4,8,12}; sizes ∈
 *             {720x1280, 1280x720, 1024x1792, 1792x1024}
 * Those two facts are why longer shots are COMPOSED (see planVideoSegments).
 */

const PLACEHOLDER = /paste|your-?(new|real)?-?key|\.\.\./i;
const SECRET_CACHE_MS = 60_000;
const secretCache = new Map<string, { value: string | null; at: number }>();

/** Provider keys live encrypted in AgentSecret, same as ElevenLabs and Polly. */
export async function resolveCreativeSecret(db: any, key: string): Promise<string | null> {
  const hit = secretCache.get(key);
  if (hit && Date.now() - hit.at < SECRET_CACHE_MS) return hit.value;
  let value: string | null = null;
  try {
    const sec = await import("@connect/security");
    if (sec.hasCredentialsMasterKey()) {
      const row = await db.agentSecret.findUnique({ where: { key } });
      if (row?.valueEnc) {
        const decrypted = sec.decryptJson<string>(row.valueEnc);
        if (typeof decrypted === "string" && decrypted.trim()) value = decrypted.trim();
      }
    }
  } catch {
    value = null;
  }
  if (!value) {
    const envName = key === "openai_api_key" ? "OPENAI_API_KEY" : key === "elevenlabs_api_key" ? "ELEVENLABS_API_KEY" : "";
    const env = envName ? process.env[envName] : "";
    if (env && env.trim() && !PLACEHOLDER.test(env)) value = env.trim();
  }
  secretCache.set(key, { value, at: Date.now() });
  return value;
}

export function clearCreativeSecretCache(): void {
  secretCache.clear();
}

export type Capability =
  | "image.generate" | "image.edit" | "video.generate" | "audio.speech" | "audio.music";

export interface EngineOutput {
  buffer: Buffer;
  mime: string;
  name: string;
  width?: number;
  height?: number;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

export interface EngineResult {
  status: "succeeded" | "running" | "failed";
  outputs?: EngineOutput[];
  providerJobId?: string;
  progress?: number;
  error?: string;
  errorCode?: string;
  costMicros?: number;
  meta?: Record<string, unknown>;
}

export interface EngineContext {
  db: any;
  /** Set by the runner so an engine can fetch a reference image it owns. */
  readAsset?: (assetId: string) => Promise<{ buffer: Buffer; mime: string } | null>;
  log?: (msg: string, extra?: any) => void;
}

export interface EngineAdapter {
  id: string;
  capabilities: Capability[];
  start(request: any, ctx: EngineContext): Promise<EngineResult>;
  poll?(providerJobId: string, ctx: EngineContext): Promise<EngineResult>;
  cancel?(providerJobId: string, ctx: EngineContext): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const IMAGE_SIZES: Record<string, string> = {
  "1:1": "1024x1024",
  "4:5": "1024x1536",
  "3:4": "1024x1536",
  "9:16": "1024x1536",
  "16:9": "1536x1024",
  "3:2": "1536x1024",
  "4:3": "1536x1024",
};

export function imageSizeFor(ratio: string | undefined): string {
  return IMAGE_SIZES[String(ratio || "1:1")] || "1024x1024";
}

const VIDEO_SIZES: Record<string, string> = {
  "16:9": "1280x720",
  "9:16": "720x1280",
  "1:1": "1280x720",
  "4:5": "720x1280",
};

export function videoSizeFor(ratio: string | undefined, hd = false): string {
  const base = VIDEO_SIZES[String(ratio || "16:9")] || "1280x720";
  if (!hd) return base;
  return base === "720x1280" ? "1024x1792" : "1792x1024";
}

/** What Sora will actually accept, nearest at or below what we want. */
export const SORA_SECONDS = [4, 8, 12];

/**
 * Loopcom promises up to 15 seconds for one shot. Sora's longest native clip
 * is 12. So a longer ask becomes several segments that continue from each
 * other and are joined: the customer asked for one shot and gets one shot.
 */
export function planVideoSegments(seconds: number, maxNative = 12): number[] {
  const want = Math.max(1, Math.min(15, Math.round(seconds)));
  const segs: number[] = [];
  let left = want;
  while (left > 0) {
    // Largest allowed value that does not overshoot what is left, except the
    // last piece, which rounds UP to the smallest allowed value and is trimmed
    // during the join (asking for less than 4s is not possible).
    const fit = SORA_SECONDS.filter((s) => s <= Math.min(left, maxNative));
    const pick = fit.length ? Math.max(...fit) : Math.min(...SORA_SECONDS);
    segs.push(pick);
    left -= pick;
  }
  return segs;
}

async function openaiFetch(path: string, key: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 180_000);
  try {
    return await fetch(`https://api.openai.com/v1${path}`, {
      ...init,
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, ...(init.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

function errorFrom(body: any, fallback: string): { error: string; errorCode: string } {
  const msg = body?.error?.message || body?.message || fallback;
  const code = body?.error?.code || body?.error?.type || "provider_error";
  return { error: String(msg).slice(0, 500), errorCode: String(code).slice(0, 80) };
}

/* ------------------------------------------------------------------ */
/* OpenAI images                                                       */
/* ------------------------------------------------------------------ */

const IMAGE_QUALITY_MICROS: Record<string, number> = { low: 12_000, medium: 45_000, high: 170_000 };

export const openaiImageAdapter: EngineAdapter = {
  id: "loopcom.image",
  capabilities: ["image.generate", "image.edit"],
  async start(request, ctx) {
    const key = await resolveCreativeSecret(ctx.db, "openai_api_key");
    if (!key) return { status: "failed", error: "No OpenAI key is configured for this platform.", errorCode: "no_key" };

    const model = String(request.model || "gpt-image-2.5-flare");
    const size = imageSizeFor(request.ratio);
    const quality = ["low", "medium", "high"].includes(String(request.quality)) ? String(request.quality) : "low";
    const n = Math.max(1, Math.min(4, Number(request.count || 1)));
    const started = Date.now();

    let res: Response;
    const refs: Array<{ buffer: Buffer; mime: string }> = [];
    for (const id of (request.referenceAssetIds || []).slice(0, 4)) {
      const got = ctx.readAsset ? await ctx.readAsset(String(id)) : null;
      if (got) refs.push(got);
    }

    if (refs.length || request.maskAssetId) {
      // Editing: multipart, the reference images ride as files.
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", String(request.prompt || ""));
      form.append("size", size);
      form.append("quality", quality);
      form.append("n", String(n));
      refs.forEach((r, i) => form.append("image[]", new Blob([new Uint8Array(r.buffer)], { type: r.mime }), `ref-${i}.png`));
      if (request.maskAssetId && ctx.readAsset) {
        const mask = await ctx.readAsset(String(request.maskAssetId));
        if (mask) form.append("mask", new Blob([new Uint8Array(mask.buffer)], { type: mask.mime }), "mask.png");
      }
      res = await openaiFetch("/images/edits", key, { method: "POST", body: form as any, timeoutMs: 240_000 });
    } else {
      res = await openaiFetch("/images/generations", key, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: String(request.prompt || ""), size, quality, n }),
        timeoutMs: 240_000,
      });
    }

    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = errorFrom(body, `Image generation failed (${res.status})`);
      // A refusal is not a bug: tell the person plainly rather than retrying.
      const permanent = res.status === 400 || res.status === 403;
      return { status: "failed", ...e, errorCode: permanent ? "refused" : e.errorCode };
    }

    const [w, h] = size.split("x").map((v) => Number(v));
    const outputs: EngineOutput[] = (body.data || [])
      .filter((d: any) => d?.b64_json)
      .map((d: any, i: number) => ({
        buffer: Buffer.from(d.b64_json, "base64"),
        mime: "image/png",
        name: `image-${i + 1}.png`,
        width: w,
        height: h,
        meta: { revisedPrompt: d.revised_prompt || null },
      }));

    if (!outputs.length) return { status: "failed", error: "The engine returned no image.", errorCode: "empty_result" };

    return {
      status: "succeeded",
      outputs,
      costMicros: (IMAGE_QUALITY_MICROS[quality] || 12_000) * outputs.length,
      meta: { model, size, quality, renderMs: Date.now() - started, usage: body.usage || null },
    };
  },
};

/* ------------------------------------------------------------------ */
/* OpenAI video (Sora)                                                 */
/* ------------------------------------------------------------------ */

const VIDEO_MICROS_PER_SEC: Record<string, number> = { "sora-2": 100_000, "sora-2-pro": 300_000 };

export const openaiVideoAdapter: EngineAdapter = {
  id: "loopcom.video",
  capabilities: ["video.generate"],
  async start(request, ctx) {
    const key = await resolveCreativeSecret(ctx.db, "openai_api_key");
    if (!key) return { status: "failed", error: "No OpenAI key is configured for this platform.", errorCode: "no_key" };

    const model = String(request.model || "sora-2");
    const seconds = SORA_SECONDS.includes(Number(request.seconds)) ? String(Number(request.seconds)) : "4";
    const size = videoSizeFor(request.ratio, !!request.hd && model === "sora-2-pro");

    let res: Response;
    const first = request.firstFrameAssetId && ctx.readAsset ? await ctx.readAsset(String(request.firstFrameAssetId)) : null;
    if (first) {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", String(request.prompt || ""));
      form.append("seconds", seconds);
      form.append("size", size);
      form.append("input_reference", new Blob([new Uint8Array(first.buffer)], { type: first.mime }), "first-frame.png");
      res = await openaiFetch("/videos", key, { method: "POST", body: form as any, timeoutMs: 120_000 });
    } else {
      res = await openaiFetch("/videos", key, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: String(request.prompt || ""), seconds, size }),
        timeoutMs: 120_000,
      });
    }

    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = errorFrom(body, `Video generation failed (${res.status})`);
      return { status: "failed", ...e, errorCode: res.status === 400 || res.status === 403 ? "refused" : e.errorCode };
    }
    if (!body?.id) return { status: "failed", error: "The engine accepted the job but returned no id.", errorCode: "no_job_id" };

    return {
      status: "running",
      providerJobId: String(body.id),
      progress: Number(body.progress || 0),
      meta: { model, size, seconds: Number(seconds) },
      costMicros: (VIDEO_MICROS_PER_SEC[model] || 100_000) * Number(seconds),
    };
  },

  async poll(providerJobId, ctx) {
    const key = await resolveCreativeSecret(ctx.db, "openai_api_key");
    if (!key) return { status: "failed", error: "No OpenAI key is configured.", errorCode: "no_key" };

    const res = await openaiFetch(`/videos/${encodeURIComponent(providerJobId)}`, key, { timeoutMs: 60_000 });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = errorFrom(body, `Could not read the video job (${res.status})`);
      return { status: res.status >= 500 ? "running" : "failed", ...e };
    }

    const status = String(body.status || "queued");
    if (status === "queued" || status === "in_progress" || status === "processing") {
      return { status: "running", providerJobId, progress: Number(body.progress || 0) };
    }
    if (status !== "completed") {
      return {
        status: "failed",
        error: String(body?.error?.message || `The engine reported "${status}".`).slice(0, 500),
        errorCode: String(body?.error?.code || status).slice(0, 80),
      };
    }

    // Completed: fetch the rendered MP4.
    const content = await openaiFetch(`/videos/${encodeURIComponent(providerJobId)}/content`, key, { timeoutMs: 300_000 });
    if (!content.ok) {
      const text = await content.text().catch(() => "");
      return { status: "failed", error: `The finished video could not be downloaded (${content.status}). ${text.slice(0, 200)}`, errorCode: "download_failed" };
    }
    const buffer = Buffer.from(await content.arrayBuffer());
    const size = String(body.size || "1280x720");
    const [w, h] = size.split("x").map((v) => Number(v));
    return {
      status: "succeeded",
      outputs: [{
        buffer,
        mime: "video/mp4",
        name: "clip.mp4",
        width: w,
        height: h,
        durationMs: Number(body.seconds || 4) * 1000,
        meta: { model: body.model, size },
      }],
      meta: { model: body.model, size, seconds: Number(body.seconds || 4) },
    };
  },

  async cancel(providerJobId, ctx) {
    const key = await resolveCreativeSecret(ctx.db, "openai_api_key");
    if (!key) return;
    // Cancelling reaches the provider too, not just our own row.
    await openaiFetch(`/videos/${encodeURIComponent(providerJobId)}`, key, { method: "DELETE", timeoutMs: 30_000 }).catch(() => null);
  },
};

/* ------------------------------------------------------------------ */
/* ElevenLabs voice + music                                            */
/* ------------------------------------------------------------------ */

export const elevenSpeechAdapter: EngineAdapter = {
  id: "loopcom.voice",
  capabilities: ["audio.speech"],
  async start(request, ctx) {
    const key = await resolveCreativeSecret(ctx.db, "elevenlabs_api_key");
    if (!key) return { status: "failed", error: "No ElevenLabs key is configured for this platform.", errorCode: "no_key" };

    const voiceId = String(request.voiceId || "21m00Tcm4TlvDq8ikWAM");
    const text = String(request.text || "").slice(0, 5000);
    if (!text.trim()) return { status: "failed", error: "There is nothing to say.", errorCode: "empty_text" };

    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: String(request.modelId || "eleven_multilingual_v2"),
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: Number(request.style || 0) },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      let parsed: any = null;
      try { parsed = JSON.parse(t); } catch { /* text is fine */ }
      const e = errorFrom(parsed, `The voice engine refused (${res.status})`);
      return { status: "failed", ...e };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    // ElevenLabs bills per character; ~$0.05/min is the working estimate.
    return {
      status: "succeeded",
      outputs: [{ buffer, mime: "audio/mpeg", name: "voiceover.mp3" }],
      costMicros: Math.round(text.length * 90),
      meta: { voiceId, characters: text.length },
    };
  },
};

export const elevenMusicAdapter: EngineAdapter = {
  id: "loopcom.music",
  capabilities: ["audio.music"],
  async start(request, ctx) {
    const key = await resolveCreativeSecret(ctx.db, "elevenlabs_api_key");
    if (!key) return { status: "failed", error: "No ElevenLabs key is configured for this platform.", errorCode: "no_key" };

    const ms = Math.max(3000, Math.min(120_000, Number(request.durationMs || 15_000)));
    const res = await fetch("https://api.elevenlabs.io/v1/music", {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: String(request.prompt || "calm cinematic underscore"), music_length_ms: ms }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      let parsed: any = null;
      try { parsed = JSON.parse(t); } catch { /* text is fine */ }
      const e = errorFrom(parsed, `The music engine refused (${res.status})`);
      return { status: "failed", ...e };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      status: "succeeded",
      outputs: [{ buffer, mime: "audio/mpeg", name: "music.mp3", durationMs: ms }],
      costMicros: Math.round((ms / 60_000) * 150_000),
      meta: { durationMs: ms },
    };
  },
};

export const ADAPTERS: Record<string, EngineAdapter> = {
  [openaiImageAdapter.id]: openaiImageAdapter,
  [openaiVideoAdapter.id]: openaiVideoAdapter,
  [elevenSpeechAdapter.id]: elevenSpeechAdapter,
  [elevenMusicAdapter.id]: elevenMusicAdapter,
};

/**
 * The engines the platform ships with. Seeded on boot; an admin may disable
 * one or change the default, but may never enable one whose licence forbids
 * commercial use — commercialOk:false is refused in the admin route.
 */
export const SEED_ENGINES = [
  {
    id: "loopcom.image", label: "Loopcom image", provider: "openai", placement: "hosted",
    capabilities: ["image.generate", "image.edit"], model: "gpt-image-2.5-flare",
    license: "Commercial API (OpenAI)", commercialOk: true, enabled: true, isDefault: true,
    limits: { sizes: ["1024x1024", "1024x1536", "1536x1024"], quality: ["low", "medium", "high"], maxCount: 4, supportsEdit: true, supportsMask: true },
    costModel: { unit: "image", micros: 12_000, note: "estimate; low quality" },
    secretKey: "openai_api_key", sortOrder: 10,
    notes: "Text to image, editing, inpainting with a mask, and reference images.",
  },
  {
    id: "loopcom.video", label: "Loopcom video · production", provider: "openai", placement: "hosted",
    capabilities: ["video.generate"], model: "sora-2",
    license: "Commercial API (OpenAI)", commercialOk: true, enabled: true, isDefault: true,
    limits: { seconds: [4, 8, 12], maxSeconds: 15, sizes: ["1280x720", "720x1280", "1024x1792", "1792x1024"], supportsFirstFrame: true, supportsLastFrame: false, composesLongerShots: true },
    costModel: { unit: "second", micros: 100_000 },
    secretKey: "openai_api_key", sortOrder: 20,
    notes: "Native clips are 4, 8 or 12 seconds; anything longer is composed from continuing segments and joined.",
  },
  {
    id: "loopcom.voice", label: "Loopcom voiceover", provider: "elevenlabs", placement: "hosted",
    capabilities: ["audio.speech"], model: "eleven_multilingual_v2",
    license: "Commercial API (ElevenLabs)", commercialOk: true, enabled: true, isDefault: true,
    limits: { maxCharacters: 5000, perSentence: true },
    costModel: { unit: "character", micros: 90 },
    secretKey: "elevenlabs_api_key", sortOrder: 30,
    notes: "The same account the phone system already uses for IVR greetings.",
  },
  {
    id: "loopcom.music", label: "Loopcom music", provider: "elevenlabs", placement: "hosted",
    capabilities: ["audio.music"], model: "eleven_music",
    license: "Commercial API (ElevenLabs) — generated effects may not be resold as a sample library",
    commercialOk: true, enabled: true, isDefault: true,
    limits: { maxMs: 120_000 },
    costModel: { unit: "minute", micros: 150_000 },
    secretKey: "elevenlabs_api_key", sortOrder: 40,
    notes: "Music beds and sound effects.",
  },
];

/** Seed or refresh the engine catalogue. Never turns an engine back on. */
export async function seedEngines(db: any): Promise<void> {
  for (const e of SEED_ENGINES) {
    await db.creativeEngine.upsert({
      where: { id: e.id },
      create: e as any,
      // An admin's enabled/default choices are theirs; only facts are refreshed.
      update: {
        label: e.label, provider: e.provider, placement: e.placement, capabilities: e.capabilities,
        model: e.model, license: e.license, commercialOk: e.commercialOk, limits: e.limits as any,
        costModel: e.costModel as any, secretKey: e.secretKey, notes: e.notes, sortOrder: e.sortOrder,
      } as any,
    });
  }
}

/**
 * Which engine runs this job. Order: what the customer pinned, then the
 * default, then anything enabled — and never an engine we may not sell with.
 */
export async function chooseEngine(db: any, capability: Capability, preferredId?: string | null): Promise<any | null> {
  const rows = await db.creativeEngine.findMany({ where: { enabled: true }, orderBy: [{ isDefault: "desc" }, { sortOrder: "asc" }] });
  const usable = rows.filter((r: any) => r.commercialOk && Array.isArray(r.capabilities) && r.capabilities.includes(capability));
  if (!usable.length) return null;
  if (preferredId) {
    const pinned = usable.find((r: any) => r.id === preferredId);
    if (pinned) return pinned;
  }
  return usable[0];
}
