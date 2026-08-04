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
  resolvePbxRouteHelperConfig: () => any;
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
  // Never returns the key.
  app.get("/voice/elevenlabs/status", async (req: any, reply: any) => {
    const user = await requirePromptManager(req, reply);
    if (!user) return;

    const { resolveElevenLabsKey } = await import("./elevenLabsKey");
    const key = await resolveElevenLabsKey(db);
    if (!key) return reply.send({ configured: false });

    const { checkElevenLabsKey, TTS_MODELS, IVR_VOICE_TUNING } = await import("./elevenLabs");
    const check = await checkElevenLabsKey(key);
    return reply.send({
      configured: true,
      keyWorks: check.ok,
      message: check.userMessage ?? null,
      charactersUsed: check.characterCount ?? null,
      characterLimit: check.characterLimit ?? null,
      tier: check.tier ?? null,
      models: TTS_MODELS,
      defaultTuning: IVR_VOICE_TUNING,
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
        return reply.code(err.httpStatus === 401 ? 400 : 502).send({ error: "elevenlabs_failed", message: err.userMessage });
      }
      return reply.code(502).send({ error: "elevenlabs_failed", message: "Couldn't load the voice list." });
    }
  });

  // ── POST /voice/elevenlabs/preview ────────────────────────────────────────
  // Synthesise WITHOUT saving anything. This is what makes the voice picker
  // usable — hearing a candidate voice read your own words before it becomes a
  // prompt row, a file on disk and a push to the PBX. Nothing here touches the
  // database or the PBX, so someone can audition freely.
  app.post("/voice/elevenlabs/preview", async (req: any, reply: any) => {
    const user = await requirePromptManager(req, reply);
    if (!user) return;

    const body = z
      .object({ voiceId: z.string().min(1), text: z.string().min(1), model: z.string().optional(), tuning: TUNING_SCHEMA })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const key = await keyOr503(reply);
    if (!key) return;

    const { synthesiseSpeech, pcmToWav, ElevenLabsError, isTtsModelId } = await import("./elevenLabs");
    try {
      const out = await synthesiseSpeech(key, {
        voiceId: body.data.voiceId,
        text: body.data.text,
        model: isTtsModelId(body.data.model) ? body.data.model : undefined,
        tuning: body.data.tuning,
      });
      const wav = pcmToWav(out.pcm, out.sampleRate);
      reply.header("Content-Type", "audio/wav");
      reply.header("Content-Length", String(wav.byteLength));
      // A preview is never a file to keep — it isn't even saved server-side.
      reply.header("Content-Disposition", "inline");
      reply.header("Cache-Control", "no-store");
      return reply.send(wav);
    } catch (err: any) {
      if (err instanceof ElevenLabsError) {
        return reply.code(err.httpStatus === 401 ? 400 : 502).send({ error: "elevenlabs_failed", message: err.userMessage });
      }
      app.log.error({ err: err?.message }, "[ELEVENLABS_PREVIEW] failed");
      return reply.code(500).send({ error: "preview_failed", message: "Couldn't generate the preview." });
    }
  });

  // ── POST /voice/ivr/prompts/generate ──────────────────────────────────────
  // Turn text into a real, playable, PBX-installed greeting.
  app.post("/voice/ivr/prompts/generate", async (req: any, reply: any) => {
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

    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, slug: true } });
    if (!tenant) return reply.code(404).send({ error: "tenant_not_found" });

    const key = await keyOr503(reply);
    if (!key) return;

    const { synthesiseSpeech, pcmToWav, pcmDurationSeconds, ElevenLabsError, isTtsModelId } = await import("./elevenLabs");
    const { sanitizeBaseName, writeAndNormalisePromptFile, writePromptFile, readPromptFile } = await import("../promptStorage");

    // 1) Synthesise. Nothing is written anywhere until this succeeds, so a
    //    provider failure leaves no half-made greeting behind.
    let wav: Buffer;
    let seconds = 0;
    let sampleRate = 8000;
    try {
      const out = await synthesiseSpeech(key, {
        voiceId: body.data.voiceId,
        text: body.data.text,
        model: isTtsModelId(body.data.model) ? body.data.model : undefined,
        tuning: body.data.tuning,
      });
      wav = pcmToWav(out.pcm, out.sampleRate);
      seconds = pcmDurationSeconds(out.pcm, out.sampleRate);
      sampleRate = out.sampleRate;
    } catch (err: any) {
      if (err instanceof ElevenLabsError) {
        return reply.code(err.httpStatus === 401 ? 400 : 502).send({ error: "elevenlabs_failed", message: err.userMessage });
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
    const row = await db.tenantPbxPrompt.create({
      data: {
        tenantId,
        tenantSlug: tenant.slug ? String(tenant.slug).toLowerCase() : null,
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

    // 5) Push to the PBX so the very next caller hears it. A failed push is not
    //    a failed generation — the cron catch-up retries, and the status we
    //    return lets the UI say "saved, installing" rather than "error".
    let pushStatus: "pushed" | "skipped_no_helper" | "failed" = "skipped_no_helper";
    let pushDetail: string | null = null;
    try {
      const helperCfg = resolvePbxRouteHelperConfig();
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
