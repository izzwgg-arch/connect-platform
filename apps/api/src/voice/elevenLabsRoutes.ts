/**
 * ElevenLabs routes — generating a greeting instead of recording one.
 *
 * Most small businesses have no way to produce a decent greeting. They record
 * one on a mobile in a noisy office, or never get round to it and callers hear
 * the stock prompt forever. Typing the words and picking a voice removes that
 * whole problem.
 *
 * The pipeline reuses the existing upload path end to end — synthesise,
 * normalise to 8 kHz mono WAV, store tenant-scoped, push to the PBX helper,
 * record the sync status on the catalog row. A generated greeting and an
 * uploaded one are the same kind of thing by the time they reach Asterisk; only
 * `source` differs.
 *
 * `source: "generated"` is load-bearing: it is how the UI knows never to offer
 * a download. Honest limit — audio that plays in a browser can always be
 * captured by someone determined enough. What this prevents is a download
 * button, which is the ordinary way a file walks out of a product.
 *
 * Registered from server.ts, which passes in the pieces that live there
 * (permission gate, db, PBX helper) rather than this module reaching back into
 * the monolith.
 */

import crypto from "node:crypto";
import { z } from "zod";
import type { Buffer } from "node:buffer";

export interface ElevenLabsRouteDeps {
  app: any;
  db: any;
  /** Resolves the caller and enforces the IVR-prompt permission, or replies. */
  requirePromptManager: (req: any, reply: any) => Promise<any | undefined>;
  resolvePbxRouteHelperConfig: (pbxInstanceId?: string | null) => any;
  pushPromptToHelper: (cfg: any, body: any, bytes: Buffer) => Promise<unknown>;
  PromptPushError: any;
}

const TUNING_SCHEMA = z
  .object({
    stability: z.number().min(0).max(1).optional(),
    similarityBoost: z.number().min(0).max(1).optional(),
    style: z.number().min(0).max(1).optional(),
    useSpeakerBoost: z.boolean().optional(),
    speed: z.number().min(0.7).max(1.2).optional(),
  })
  .optional();

/**
 * Every synthesis call spends real money from a monthly character allowance
 * shared by the whole platform, and each one can hold a connection to the
 * provider for up to a minute. Two independent guards:
 *
 *  - a per-caller rate limit (route config, enforced by @fastify/rate-limit,
 *    which server.ts already registers globally) — stops one stuck client or
 *    script from draining the quota;
 *  - a small global concurrency gate — stops a burst from many callers piling
 *    up minute-long provider calls. Auditioning voices is one call every few
 *    seconds; four in flight at once is already unusual.
 */
/** Mirror of server.ts `toIvrSlug`: catalog rows only line up with the rest of
 *  the prompt catalog (list scoping, PBX prefix matching) when every writer
 *  normalises the tenant name the same way. */
function toTenantSlug(name: string): string | null {
  const slug = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug : null;
}

const SYNTH_RATE_LIMIT = { max: 12, timeWindow: "1 minute" as const };
const MAX_CONCURRENT_SYNTH = 4;
let synthInFlight = 0;

/**
 * Preview → save reuse. "Use this recording" used to synthesise the SAME
 * text/voice/tuning a second time from scratch — the slowest button in the
 * flow paid full provider latency twice and burned double the characters.
 * The preview's PCM is kept for a few minutes keyed by exactly what produced
 * it; a save with identical inputs reuses the bytes the customer just heard
 * (which is also more honest: they get the take they approved, not a re-roll).
 */
const PREVIEW_CACHE_TTL_MS = 10 * 60_000;
const PREVIEW_CACHE_MAX = 40; // ~0.5 MB per 30s greeting at 8 kHz — bounded memory
const previewCache = new Map<string, { pcm: Buffer; sampleRate: number; model: string; at: number }>();

function previewCacheKey(input: { voiceId: string; text: string; model?: string; tuning?: unknown }): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([input.voiceId, input.text, input.model ?? "", input.tuning ?? {}]))
    .digest("hex");
}

function previewCacheGet(key: string): { pcm: Buffer; sampleRate: number; model: string } | null {
  const hit = previewCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PREVIEW_CACHE_TTL_MS) {
    previewCache.delete(key);
    return null;
  }
  return hit;
}

function previewCacheSet(key: string, value: { pcm: Buffer; sampleRate: number; model: string }): void {
  previewCache.set(key, { ...value, at: Date.now() });
  while (previewCache.size > PREVIEW_CACHE_MAX) {
    const oldest = previewCache.keys().next().value;
    if (oldest === undefined) break;
    previewCache.delete(oldest);
  }
}

async function withSynthSlot<T>(reply: any, fn: () => Promise<T>): Promise<T | undefined> {
  if (synthInFlight >= MAX_CONCURRENT_SYNTH) {
    reply.code(429).send({
      error: "busy",
      message: "A few recordings are being generated right now. Give it a moment and try again.",
    });
    return undefined;
  }
  synthInFlight += 1;
  try {
    return await fn();
  } finally {
    synthInFlight -= 1;
  }
}

export function registerElevenLabsRoutes(deps: ElevenLabsRouteDeps): void {
  const { app, db, requirePromptManager, resolvePbxRouteHelperConfig, pushPromptToHelper, PromptPushError } = deps;

  /** Common guard: no key configured is a 503 with an actionable message, not
   *  a mystery 500. The message names the page where the key is set. */
  async function keyOr503(reply: any): Promise<string | null> {
    const { resolveElevenLabsKey } = await import("./elevenLabsKey");
    const key = await resolveElevenLabsKey(db);
    if (!key) {
      reply.code(503).send({
        error: "elevenlabs_not_configured",
        message: "No ElevenLabs key is set yet. Add one on the ElevenLabs settings page.",
      });
      return null;
    }
    return key;
  }

  // ── GET /voice/elevenlabs/status ──────────────────────────────────────────
  // Whether generation is available at all, plus how many characters are left.
  // Never returns the key. Also carries the voice list: the modal used to make
  // TWO strictly sequential round-trips (status, then voices) before showing
  // anything — folding them into one request, fetched in parallel, roughly
  // halves the "Loading voices…" wait. The separate /voices route stays for
  // compatibility and as the client's fallback when `voices` is null here.
  app.get("/voice/elevenlabs/status", async (req: any, reply: any) => {
    const user = await requirePromptManager(req, reply);
    if (!user) return;

    const { resolveElevenLabsKey } = await import("./elevenLabsKey");
    const key = await resolveElevenLabsKey(db);
    if (!key) return reply.send({ configured: false });

    const { checkElevenLabsKey, listElevenLabsVoices, TTS_MODELS, IVR_VOICE_TUNING } = await import("./elevenLabs");
    const [check, voices] = await Promise.all([
      checkElevenLabsKey(key),
      // Best-effort: a voice-list hiccup must not break the status answer.
      listElevenLabsVoices(key).catch(() => null),
    ]);
    return reply.send({
      configured: true,
      keyWorks: check.ok,
      /** The account can actually synthesise right now — a valid key on an
       *  unpaid account is `keyWorks: true, usable: false`. */
      usable: check.usable ?? false,
      message: check.userMessage ?? null,
      charactersUsed: check.characterCount ?? null,
      characterLimit: check.characterLimit ?? null,
      tier: check.tier ?? null,
      models: TTS_MODELS,
      defaultTuning: IVR_VOICE_TUNING,
      /** null = list unavailable right now; the client falls back to /voices. */
      voices,
    });
  });

  // ── GET /voice/elevenlabs/voices ──────────────────────────────────────────
  app.get("/voice/elevenlabs/voices", async (req: any, reply: any) => {
    const user = await requirePromptManager(req, reply);
    if (!user) return;
    const key = await keyOr503(reply);
    if (!key) return;

    const { listElevenLabsVoices, ElevenLabsError } = await import("./elevenLabs");
    try {
      return reply.send({ voices: await listElevenLabsVoices(key) });
    } catch (err: any) {
      if (err instanceof ElevenLabsError) {
        return reply.code(err.httpStatus === 400 || err.httpStatus === 401 ? 400 : 502).send({ error: "elevenlabs_failed", message: err.userMessage });
      }
      return reply.code(502).send({ error: "elevenlabs_failed", message: "Couldn't load the voice list." });
    }
  });

  // ── POST /voice/elevenlabs/preview ────────────────────────────────────────
  // Synthesise WITHOUT saving anything. This is what makes the voice picker
  // usable — hearing a candidate voice read your own words before it becomes a
  // prompt row, a file on disk and a push to the PBX. Nothing here touches the
  // database or the PBX, so someone can audition freely.
  app.post("/voice/elevenlabs/preview", { config: { rateLimit: SYNTH_RATE_LIMIT } }, async (req: any, reply: any) => {
    const user = await requirePromptManager(req, reply);
    if (!user) return;

    const body = z
      .object({ voiceId: z.string().min(1), text: z.string().min(1), model: z.string().optional(), tuning: TUNING_SCHEMA })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const key = await keyOr503(reply);
    if (!key) return;

    const { synthesiseSpeech, pcmToWav, ElevenLabsError, isTtsModelId } = await import("./elevenLabs");
    return withSynthSlot(reply, async () => {
      try {
        const out = await synthesiseSpeech(key, {
          voiceId: body.data.voiceId,
          text: body.data.text,
          model: isTtsModelId(body.data.model) ? body.data.model : undefined,
          tuning: body.data.tuning,
        });
        // Keep the take: if they save these exact words in this exact voice,
        // /prompts/generate reuses this audio instead of synthesising again.
        previewCacheSet(
          previewCacheKey({ voiceId: body.data.voiceId, text: body.data.text, model: body.data.model, tuning: body.data.tuning }),
          { pcm: out.pcm, sampleRate: out.sampleRate, model: out.model },
        );
        const wav = pcmToWav(out.pcm, out.sampleRate);
        reply.header("Content-Type", "audio/wav");
        reply.header("Content-Length", String(wav.byteLength));
        // A preview is never a file to keep — it isn't even saved server-side.
        reply.header("Content-Disposition", "inline");
        reply.header("Cache-Control", "no-store");
        return reply.send(wav);
      } catch (err: any) {
        if (err instanceof ElevenLabsError) {
          return reply.code(err.httpStatus === 400 || err.httpStatus === 401 ? 400 : 502).send({ error: "elevenlabs_failed", message: err.userMessage });
        }
        app.log.error({ err: err?.message }, "[ELEVENLABS_PREVIEW] failed");
        return reply.code(500).send({ error: "preview_failed", message: "Couldn't generate the preview." });
      }
    });
  });

  // ── POST /voice/ivr/prompts/generate ──────────────────────────────────────
  // Turn text into a real, playable, PBX-installed greeting.
  app.post("/voice/ivr/prompts/generate", { config: { rateLimit: SYNTH_RATE_LIMIT } }, async (req: any, reply: any) => {
    const user = await requirePromptManager(req, reply);
    if (!user) return;

    const body = z
      .object({
        tenantId: z.string().optional(),
        /** What the customer calls it — "Main greeting", "After hours". */
        displayName: z.string().min(1).max(120),
        text: z.string().min(1),
        voiceId: z.string().min(1),
        model: z.string().optional(),
        category: z.enum(["greeting", "invalid", "timeout", "general"]).optional(),
        tuning: TUNING_SCHEMA,
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const isSuperAdmin = String(user.role || "").toUpperCase() === "SUPER_ADMIN";
    // A tenant admin can only ever generate into their own tenant, whatever the
    // body says. A super admin must land on one — a greeting with no owner is
    // invisible to the customer it was made for.
    const tenantId = isSuperAdmin ? body.data.tenantId || user.tenantId || null : user.tenantId || null;
    if (!tenantId) {
      return reply.code(400).send({ error: "tenant_required", message: "Choose which customer this greeting belongs to." });
    }

    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
    if (!tenant) return reply.code(404).send({ error: "tenant_not_found" });

    const key = await keyOr503(reply);
    if (!key) return;

    const { synthesiseSpeech, pcmToWav, pcmDurationSeconds, ElevenLabsError, isTtsModelId } = await import("./elevenLabs");
    const { sanitizeBaseName, writeAndNormalisePromptFile, writePromptFile, readPromptFile } = await import("../promptStorage");

    // 1) Synthesise. Nothing is written anywhere until this succeeds, so a
    //    provider failure leaves no half-made greeting behind. The concurrency
    //    slot covers only this step — storage and the PBX push are ours and
    //    don't need to hold a provider slot.
    let wav: Buffer;
    let seconds = 0;
    let sampleRate = 8000;
    try {
      // The take the customer just previewed (identical text/voice/tuning) is
      // reused verbatim — no second synthesis, no second wait, no double
      // character spend, and they get exactly the audio they approved.
      const cached = previewCacheGet(
        previewCacheKey({ voiceId: body.data.voiceId, text: body.data.text, model: body.data.model, tuning: body.data.tuning }),
      );
      const out =
        cached ??
        (await withSynthSlot(reply, () =>
          synthesiseSpeech(key, {
            voiceId: body.data.voiceId,
            text: body.data.text,
            model: isTtsModelId(body.data.model) ? body.data.model : undefined,
            tuning: body.data.tuning,
          }),
        ));
      if (!out) return; // over the concurrency cap — a 429 has already been sent
      wav = pcmToWav(out.pcm, out.sampleRate);
      seconds = pcmDurationSeconds(out.pcm, out.sampleRate);
      sampleRate = out.sampleRate;
    } catch (err: any) {
      if (err instanceof ElevenLabsError) {
        return reply.code(err.httpStatus === 400 || err.httpStatus === 401 ? 400 : 502).send({ error: "elevenlabs_failed", message: err.userMessage });
      }
      app.log.error({ err: err?.message }, "[ELEVENLABS_GENERATE] synthesis failed");
      return reply.code(500).send({ error: "generate_failed", message: "Couldn't generate the audio. Nothing was changed." });
    }

    // 2) A stable, human-readable filename. Two greetings both called "Main"
    //    in one tenant must not fight over a single file on the PBX, so a
    //    random suffix keeps them apart while the name stays recognisable.
    const nameHint = sanitizeBaseName(body.data.displayName) || "greeting";
    const fileBaseName = `${nameHint}_${crypto.randomBytes(3).toString("hex")}`.slice(0, 60);
    const promptRef = `custom/${fileBaseName}`;

    // 3) Store. At 8 kHz the bytes are already exactly what Asterisk wants, so
    //    skip ffmpeg entirely; at 16 kHz let it do the single downsample.
    let stored: { storageKey: string; sha256: string; sizeBytes: number; contentType: string };
    try {
      const args = { tenantScope: tenantId, baseName: fileBaseName, originalFilename: `${fileBaseName}.wav`, buffer: wav };
      stored = sampleRate === 8000 ? await writePromptFile(args) : await writeAndNormalisePromptFile(args);
    } catch (err: any) {
      app.log.error({ err: err?.message }, "[ELEVENLABS_GENERATE] storage write failed");
      return reply.code(500).send({ error: "storage_write_failed", message: "The audio was generated but couldn't be saved. Try again." });
    }

    // 4) Catalog row. `source: "generated"` is what tells the UI never to offer
    //    a download; `ownershipConfidence: "manual"` reflects that a person in
    //    this tenant deliberately created it.
    let row: any;
    try {
      row = await db.tenantPbxPrompt.create({
        data: {
          tenantId,
          // Same normalisation the manual-upload path uses (toIvrSlug in
          // server.ts): the Tenant model has no slug column, so the catalog
          // slug is always derived from the tenant's name.
          tenantSlug: toTenantSlug(tenant.name),
          promptRef,
          fileBaseName,
          relativePath: promptRef,
          displayName: body.data.displayName.trim(),
          category: body.data.category || "greeting",
          source: "generated",
          isActive: true,
          storageKey: stored.storageKey,
          sha256: stored.sha256,
          sizeBytes: stored.sizeBytes,
          contentType: stored.contentType,
          syncedAt: new Date(),
          ownershipConfidence: "manual",
        },
      });
    } catch (err: any) {
      // An uncaught throw here becomes Fastify's default 500, whose message is
      // the raw ORM error — and the dialog renders that verbatim to customers.
      app.log.error({ err: err?.message, tenantId, promptRef }, "[ELEVENLABS_GENERATE] catalog write failed");
      return reply.code(500).send({
        error: "catalog_write_failed",
        message: "The audio was generated and saved, but couldn't be added to the recordings list. Try again.",
      });
    }

    // 5) Push to the PBX so the very next caller hears it. A failed push is not
    //    a failed generation — the cron catch-up retries, and the status we
    //    return lets the UI say "saved, installing" rather than "error".
    let pushStatus: "pushed" | "skipped_no_helper" | "failed" = "skipped_no_helper";
    let pushDetail: string | null = null;
    try {
      // Resolve the helper for THIS tenant's PBX instance — every other push
      // site passes the instance id; calling with none silently falls back to
      // the global helper, which is the wrong box once per-instance helpers
      // are configured.
      const link = await db.tenantPbxLink
        .findFirst({ where: { tenantId }, select: { pbxInstanceId: true } })
        .catch(() => null);
      const helperCfg = resolvePbxRouteHelperConfig(link?.pbxInstanceId);
      if (helperCfg) {
        const wavBytes = await readPromptFile(stored.storageKey);
        await pushPromptToHelper(
          helperCfg,
          {
            fileBaseName,
            sha256: stored.sha256,
            sizeBytes: stored.sizeBytes,
            tenantSlug: row.tenantSlug,
            promptRef,
            requestedBy: `user:${user.sub}`,
          },
          wavBytes,
        );
        pushStatus = "pushed";
      } else {
        pushDetail = "PBX_ROUTE_HELPER_BASE_URL/SECRET not configured — audio will sync on the next cron tick.";
      }
    } catch (err: any) {
      pushStatus = "failed";
      pushDetail =
        err instanceof PromptPushError
          ? `helper_${err.httpStatus}: ${err.message}`
          : `push_error: ${err?.message || String(err)}`;
      app.log.warn({ promptRef, pushDetail }, "[ELEVENLABS_GENERATE] PBX push failed; cron will retry");
    }

    app.log.info(
      { promptId: row.id, tenantId, promptRef, voiceId: body.data.voiceId, chars: body.data.text.length, seconds, pushStatus },
      "[ELEVENLABS_GENERATE] greeting generated",
    );

    return reply.send({
      ok: true,
      prompt: {
        id: row.id,
        promptRef: row.promptRef,
        displayName: row.displayName,
        category: row.category,
        source: row.source,
        seconds,
        sizeBytes: row.sizeBytes,
        /** The UI keys its download button off this. Generated audio: never. */
        downloadable: false,
        hasAudio: true,
      },
      pbxPush: { status: pushStatus, detail: pushDetail },
    });
  });
}
