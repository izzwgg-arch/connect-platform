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
import { saveGeneratedPrompt } from "./generatedPromptStore";

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

/**
 * Who is allowed to be told the real reason.
 *
 * Only Connect's own staff. A tenant admin using the IVR Studio is a CUSTOMER:
 * they were shown "ElevenLabs has an unpaid invoice on the account — settle the
 * bill at elevenlabs.io", which names a supplier they have no relationship
 * with and hands them our billing problem. Whatever state our account is in,
 * the customer gets the neutral version and we get told instead.
 */
function isConnectStaff(user: any): boolean {
  return String(user?.role || "").toUpperCase() === "SUPER_ADMIN";
}

/**
 * One admin alert per hour, per distinct reason.
 *
 * The point of hiding the cause from customers is that WE find out instead —
 * a silent neutral message that reaches nobody is worse than the leak it
 * replaced. Deduped because a broken provider affects every customer at once
 * and every one of them will press the button a few times.
 */
const ALERT_INTERVAL_MS = 60 * 60_000;
const lastAlertAt = new Map<string, number>();

async function alertStaffOnce(app: any, reason: string, detail: string[]): Promise<void> {
  const now = Date.now();
  const previous = lastAlertAt.get(reason) ?? 0;
  if (now - previous < ALERT_INTERVAL_MS) return;
  lastAlertAt.set(reason, now);
  app.log.error({ reason }, "[ELEVENLABS] customers are being denied voice generation");
  try {
    const { queueBillingAdminAlertEmail } = await import("../billing/billingEmailLifecycle");
    await queueBillingAdminAlertEmail("Voice generation is failing for customers", [
      "Customers cannot generate IVR recordings right now.",
      "",
      ...detail,
      "",
      "They are being shown a neutral message — they are NOT told the reason.",
      "Check the ElevenLabs settings page in Connect for the full detail.",
    ]);
  } catch {
    // An alert that fails must never turn into a second customer-facing error.
  }
}

export function registerElevenLabsRoutes(deps: ElevenLabsRouteDeps): void {
  const { app, db, requirePromptManager, resolvePbxRouteHelperConfig, pushPromptToHelper, PromptPushError } = deps;

  /** The message this caller is allowed to see, plus an alert when it's ours. */
  async function messageFor(user: any, err: any): Promise<string> {
    const staff = isConnectStaff(user);
    const ownerMessage = err?.userMessage || "Couldn't generate the audio. Nothing was changed.";
    if (err?.ourProblem) {
      await alertStaffOnce(app, err?.providerCode || String(err?.httpStatus ?? "unknown"), [
        `Reason: ${ownerMessage}`,
        `Provider status: ${err?.httpStatus ?? "?"} ${err?.providerCode || ""}`.trim(),
      ]);
    }
    return staff ? ownerMessage : err?.customerMessage || ownerMessage;
  }

  /** Common guard: no key configured is a 503 with an actionable message, not
   *  a mystery 500. The message names the page where the key is set. */
  async function keyOr503(reply: any, user?: any): Promise<string | null> {
    const { resolveElevenLabsKey } = await import("./elevenLabsKey");
    const key = await resolveElevenLabsKey(db);
    if (!key) {
      const { ELEVENLABS_CUSTOMER_UNAVAILABLE } = await import("@connect/shared");
      // A customer has no settings page to go to and no key to set. Telling
      // them one is missing only makes the product look broken to the person
      // least able to do anything about it.
      reply.code(503).send({
        error: "elevenlabs_not_configured",
        message: isConnectStaff(user)
          ? "No ElevenLabs key is set yet. Add one on the ElevenLabs settings page."
          : ELEVENLABS_CUSTOMER_UNAVAILABLE,
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
    // A customer must not learn WHY from this endpoint either — the Studio
    // modal renders `message` verbatim, which is how "settle the bill at
    // elevenlabs.io" reached a customer's screen in the first place.
    if (check.ourProblem && !check.usable) {
      await alertStaffOnce(app, `status_${check.ok ? "unusable" : "unreachable"}`, [
        `Reason: ${check.userMessage ?? "unknown"}`,
        `Key reachable: ${check.ok ? "yes" : "no"}`,
      ]);
    }
    return reply.send({
      configured: true,
      keyWorks: check.ok,
      /** The account can actually synthesise right now — a valid key on an
       *  unpaid account is `keyWorks: true, usable: false`. */
      usable: check.usable ?? false,
      message: (isConnectStaff(user) ? check.userMessage : check.customerMessage ?? check.userMessage) ?? null,
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
    const key = await keyOr503(reply, user);
    if (!key) return;

    const { listElevenLabsVoices, ElevenLabsError } = await import("./elevenLabs");
    try {
      return reply.send({ voices: await listElevenLabsVoices(key) });
    } catch (err: any) {
      if (err instanceof ElevenLabsError) {
        return reply
          .code(err.httpStatus === 400 || err.httpStatus === 401 ? 400 : 502)
          .send({ error: "elevenlabs_failed", message: await messageFor(user, err) });
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

    const key = await keyOr503(reply, user);
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
          return reply
            .code(err.httpStatus === 400 || err.httpStatus === 401 ? 400 : 502)
            .send({ error: "elevenlabs_failed", message: await messageFor(user, err) });
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

    const key = await keyOr503(reply, user);
    if (!key) return;

    const { synthesiseSpeech, pcmToWav, pcmDurationSeconds, ElevenLabsError, isTtsModelId } = await import("./elevenLabs");

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
        return reply
          .code(err.httpStatus === 400 || err.httpStatus === 401 ? 400 : 502)
          .send({ error: "elevenlabs_failed", message: await messageFor(user, err) });
      }
      app.log.error({ err: err?.message }, "[ELEVENLABS_GENERATE] synthesis failed");
      return reply.code(500).send({ error: "generate_failed", message: "Couldn't generate the audio. Nothing was changed." });
    }

    // 2) Store it, catalog it, push it to the PBX. Shared with the Amazon Polly
    //    path — everything from here on is identical whoever made the audio.
    const saved = await saveGeneratedPrompt(
      { app, db, resolvePbxRouteHelperConfig, pushPromptToHelper, PromptPushError },
      {
        tenantId,
        tenantName: tenant.name,
        displayName: body.data.displayName,
        category: body.data.category || "greeting",
        wav,
        sampleRate,
        seconds,
        requestedBy: `user:${user.sub}`,
        provider: "elevenlabs",
        logContext: { voiceId: body.data.voiceId, chars: body.data.text.length },
      },
    );
    if (!saved.ok) return reply.code(saved.code).send({ error: saved.error, message: saved.message });
    return reply.send(saved.body);
  });
}
