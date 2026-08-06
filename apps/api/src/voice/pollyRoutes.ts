/**
 * Amazon Polly routes — a second voice source for IVR recordings.
 *
 * Shaped to mirror the ElevenLabs routes deliberately: same status/voices/
 * preview/generate quartet, same rate limit and concurrency gate, same rule
 * about who is allowed to be told the real reason for a failure. The recording
 * modal can then treat the two as interchangeable rather than growing a second
 * set of special cases.
 *
 * What is NOT the same is who may use it. Polly is billed per character against
 * Connect's own AWS account, so it sits behind `can_use_amazon_polly` — a
 * permission that is in NEITHER default bucket (not even tenant admin) and is
 * handed out one custom role at a time. On top of that, every route still
 * requires the ordinary prompt-manager gate: the Polly permission widens WHAT a
 * prompt manager can use, it never makes someone a prompt manager.
 *
 * The credentials routes are stricter still — platform owner only — because
 * they write a secret that spends real money.
 *
 * Registered from server.ts, which passes in the pieces that live there.
 */

import { z } from "zod";
import type { Buffer } from "node:buffer";
import { saveGeneratedPrompt } from "./generatedPromptStore";

export interface PollyRouteDeps {
  app: any;
  db: any;
  /** Resolves the caller and enforces the IVR-prompt permission, or replies. */
  requirePromptManager: (req: any, reply: any) => Promise<any | undefined>;
  /** Resolves the caller and enforces platform-owner access, or replies. */
  requireOwner: (req: any, reply: any) => Promise<any | undefined>;
  /** Whether this user effectively holds `can_use_amazon_polly`. */
  hasPollyPermission: (user: any) => Promise<boolean>;
  resolvePbxRouteHelperConfig: (pbxInstanceId?: string | null) => any;
  pushPromptToHelper: (cfg: any, body: any, bytes: Buffer) => Promise<unknown>;
  PromptPushError: any;
}

/** Same guards as the ElevenLabs path, and for the same reasons: every
 *  synthesis spends real money and can hold a connection to the provider for up
 *  to a minute. Auditioning voices is one call every few seconds; four in
 *  flight at once is already unusual. */
const SYNTH_RATE_LIMIT = { max: 12, timeWindow: "1 minute" as const };
const MAX_CONCURRENT_SYNTH = 4;
let synthInFlight = 0;

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
 * telling them "the IAM user needs polly:SynthesizeSpeech" names an account
 * they have no relationship with and hands them our infrastructure problem.
 */
function isConnectStaff(user: any): boolean {
  return String(user?.role || "").toUpperCase() === "SUPER_ADMIN";
}

/**
 * One admin alert per hour, per distinct reason.
 *
 * The point of hiding the cause from customers is that WE find out instead — a
 * silent neutral message that reaches nobody is worse than the leak it
 * replaced. Deduped because broken credentials affect every customer at once
 * and every one of them will press the button a few times.
 */
const ALERT_INTERVAL_MS = 60 * 60_000;
const lastAlertAt = new Map<string, number>();

async function alertStaffOnce(app: any, reason: string, detail: string[]): Promise<void> {
  const now = Date.now();
  const previous = lastAlertAt.get(reason) ?? 0;
  if (now - previous < ALERT_INTERVAL_MS) return;
  lastAlertAt.set(reason, now);
  app.log.error({ reason }, "[POLLY] customers are being denied voice generation");
  try {
    const { queueBillingAdminAlertEmail } = await import("../billing/billingEmailLifecycle");
    await queueBillingAdminAlertEmail("Amazon Polly voice generation is failing", [
      "Customers with Amazon Polly access cannot generate IVR recordings right now.",
      "",
      ...detail,
      "",
      "They are being shown a neutral message — they are NOT told the reason.",
      "Check the Amazon Polly page in Connect for the full detail.",
    ]);
  } catch {
    // An alert that fails must never turn into a second customer-facing error.
  }
}

export function registerPollyRoutes(deps: PollyRouteDeps): void {
  const {
    app,
    db,
    requirePromptManager,
    requireOwner,
    hasPollyPermission,
    resolvePbxRouteHelperConfig,
    pushPromptToHelper,
    PromptPushError,
  } = deps;

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

  /**
   * Prompt manager AND Polly-permitted. Returns the user, or replies and
   * returns undefined.
   *
   * Two gates rather than one: `can_manage_ivr_prompts` says a person may make
   * recordings at all, `can_use_amazon_polly` says they may make them THIS way.
   * Neither implies the other.
   */
  async function requirePollyUser(req: any, reply: any): Promise<any | undefined> {
    const user = await requirePromptManager(req, reply);
    if (!user) return undefined;
    if (!(await hasPollyPermission(user))) {
      reply.code(403).send({
        error: "polly_not_permitted",
        message: "Amazon Polly isn't switched on for your account. An administrator can enable it on your role.",
      });
      return undefined;
    }
    return user;
  }

  /** Common guard: no credentials is a 503 with an actionable message, not a
   *  mystery 500. The message names the page where they are set. */
  async function credsOr503(reply: any, user?: any): Promise<any | null> {
    const { resolvePollyCredentials } = await import("./pollyCredentials");
    const creds = await resolvePollyCredentials(db);
    if (!creds) {
      // A customer has no settings page to go to and no credentials to set.
      // Telling them something is missing only makes the product look broken to
      // the person least able to do anything about it.
      reply.code(503).send({
        error: "polly_not_configured",
        message: isConnectStaff(user)
          ? "Amazon Polly isn't set up yet. Add the access key on the Amazon Polly page."
          : "Making recordings isn't available right now. You can upload your own recording instead, or try again later.",
      });
      return null;
    }
    return creds;
  }

  // ── GET /voice/polly/status ───────────────────────────────────────────────
  // Whether Polly is available to THIS person, and if so what they can use.
  // Never returns the secret. Carries the voice list so the recording modal
  // opens in one round-trip rather than two sequential ones.
  //
  // Not being permitted answers 200 with `allowed: false`, not 403: the Studio
  // asks this on every open to decide whether to offer Polly at all, and a
  // console full of 403s for the ordinary case of "this user doesn't have it"
  // makes real failures impossible to spot.
  app.get("/voice/polly/status", async (req: any, reply: any) => {
    const user = await requirePromptManager(req, reply);
    if (!user) return;

    if (!(await hasPollyPermission(user))) {
      return reply.send({ allowed: false, configured: false });
    }

    const { resolvePollyCredentials } = await import("./pollyCredentials");
    const creds = await resolvePollyCredentials(db);
    if (!creds) return reply.send({ allowed: true, configured: false });

    const { checkPollyCredentials, listPollyVoices, POLLY_ENGINES, POLLY_DEFAULT_SPEED, POLLY_DEFAULT_ENGINE, engineSupportsSpeed } =
      await import("./polly");
    const [check, voices] = await Promise.all([
      checkPollyCredentials(creds),
      // Best-effort: a voice-list hiccup must not break the status answer.
      listPollyVoices(creds).catch(() => null),
    ]);
    // A customer must not learn WHY from this endpoint either — the Studio
    // renders `message` verbatim.
    if (check.ourProblem && !check.usable) {
      await alertStaffOnce(app, `status_${check.ok ? "unusable" : "unreachable"}`, [
        `Reason: ${check.userMessage ?? "unknown"}`,
        `Credentials reachable: ${check.ok ? "yes" : "no"}`,
        `Region: ${creds.region}`,
      ]);
    }

    return reply.send({
      allowed: true,
      configured: true,
      keyWorks: check.ok,
      usable: check.usable ?? false,
      message: (isConnectStaff(user) ? check.userMessage : check.customerMessage ?? check.userMessage) ?? null,
      region: creds.region,
      // `supportsSpeed` rides along per engine so the client can hide a control
      // that would do nothing, rather than each screen hard-coding which
      // engines Amazon quietly ignores prosody on.
      engines: POLLY_ENGINES.map((e) => ({ ...e, supportsSpeed: engineSupportsSpeed(e.id) })),
      defaultEngine: POLLY_DEFAULT_ENGINE,
      defaultSpeed: POLLY_DEFAULT_SPEED,
      /** null = list unavailable right now; the client falls back to /voices. */
      voices,
    });
  });

  // ── GET /voice/polly/voices ───────────────────────────────────────────────
  app.get("/voice/polly/voices", async (req: any, reply: any) => {
    const user = await requirePollyUser(req, reply);
    if (!user) return;
    const creds = await credsOr503(reply, user);
    if (!creds) return;

    const { listPollyVoices, PollyError } = await import("./polly");
    try {
      return reply.send({ voices: await listPollyVoices(creds) });
    } catch (err: any) {
      if (err instanceof PollyError) {
        return reply
          .code(err.httpStatus === 400 || err.httpStatus === 403 ? 400 : 502)
          .send({ error: "polly_failed", message: await messageFor(user, err) });
      }
      return reply.code(502).send({ error: "polly_failed", message: "Couldn't load the voice list." });
    }
  });

  // ── POST /voice/polly/preview ─────────────────────────────────────────────
  // Synthesise WITHOUT saving anything. Nothing here touches the database or
  // the PBX, so someone can audition freely before committing to a voice.
  app.post("/voice/polly/preview", { config: { rateLimit: SYNTH_RATE_LIMIT } }, async (req: any, reply: any) => {
    const user = await requirePollyUser(req, reply);
    if (!user) return;

    const body = z
      .object({
        voiceId: z.string().min(1),
        text: z.string().min(1),
        engine: z.string().optional(),
        speed: z.number().min(0.7).max(1.2).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const creds = await credsOr503(reply, user);
    if (!creds) return;

    const { synthesisePollySpeech, PollyError, isPollyEngineId } = await import("./polly");
    const { pcmToWav } = await import("./elevenLabs");
    return withSynthSlot(reply, async () => {
      try {
        const out = await synthesisePollySpeech(creds, {
          voiceId: body.data.voiceId,
          text: body.data.text,
          engine: isPollyEngineId(body.data.engine) ? body.data.engine : undefined,
          speed: body.data.speed,
        });
        const wav = pcmToWav(out.pcm, out.sampleRate);
        reply.header("Content-Type", "audio/wav");
        reply.header("Content-Length", String(wav.byteLength));
        // A preview is never a file to keep — it isn't even saved server-side.
        reply.header("Content-Disposition", "inline");
        reply.header("Cache-Control", "no-store");
        return reply.send(wav);
      } catch (err: any) {
        if (err instanceof PollyError) {
          return reply
            .code(err.httpStatus === 400 || err.httpStatus === 403 ? 400 : 502)
            .send({ error: "polly_failed", message: await messageFor(user, err) });
        }
        app.log.error({ err: err?.message }, "[POLLY_PREVIEW] failed");
        return reply.code(500).send({ error: "preview_failed", message: "Couldn't generate the preview." });
      }
    });
  });

  // ── POST /voice/ivr/prompts/generate-polly ────────────────────────────────
  // Turn text into a real, playable, PBX-installed greeting.
  //
  // A separate path from the ElevenLabs generate route rather than a `provider`
  // field on it: the two take different inputs (engine vs model, no tuning
  // block here), and a single endpoint that validates one shape or the other
  // would have to reject half its own schema on every call.
  app.post(
    "/voice/ivr/prompts/generate-polly",
    { config: { rateLimit: SYNTH_RATE_LIMIT } },
    async (req: any, reply: any) => {
      const user = await requirePollyUser(req, reply);
      if (!user) return;

      const body = z
        .object({
          tenantId: z.string().optional(),
          /** What the customer calls it — "Main greeting", "After hours". */
          displayName: z.string().min(1).max(120),
          text: z.string().min(1),
          voiceId: z.string().min(1),
          engine: z.string().optional(),
          speed: z.number().min(0.7).max(1.2).optional(),
          category: z.enum(["greeting", "invalid", "timeout", "general"]).optional(),
        })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

      const isSuperAdmin = String(user.role || "").toUpperCase() === "SUPER_ADMIN";
      // A tenant admin can only ever generate into their own tenant, whatever
      // the body says. A super admin must land on one — a greeting with no
      // owner is invisible to the customer it was made for.
      const tenantId = isSuperAdmin ? body.data.tenantId || user.tenantId || null : user.tenantId || null;
      if (!tenantId) {
        return reply.code(400).send({ error: "tenant_required", message: "Choose which customer this greeting belongs to." });
      }

      const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
      if (!tenant) return reply.code(404).send({ error: "tenant_not_found" });

      const creds = await credsOr503(reply, user);
      if (!creds) return;

      const { synthesisePollySpeech, PollyError, isPollyEngineId } = await import("./polly");
      const { pcmToWav, pcmDurationSeconds } = await import("./elevenLabs");

      // 1) Synthesise. Nothing is written anywhere until this succeeds, so a
      //    provider failure leaves no half-made greeting behind. The
      //    concurrency slot covers only this step — storage and the PBX push
      //    are ours and don't need to hold a provider slot.
      let wav: Buffer;
      let seconds = 0;
      let sampleRate = 8000;
      try {
        const out = await withSynthSlot(reply, () =>
          synthesisePollySpeech(creds, {
            voiceId: body.data.voiceId,
            text: body.data.text,
            engine: isPollyEngineId(body.data.engine) ? body.data.engine : undefined,
            speed: body.data.speed,
          }),
        );
        if (!out) return; // over the concurrency cap — a 429 has already been sent
        wav = pcmToWav(out.pcm, out.sampleRate);
        seconds = pcmDurationSeconds(out.pcm, out.sampleRate);
        sampleRate = out.sampleRate;
      } catch (err: any) {
        if (err instanceof PollyError) {
          return reply
            .code(err.httpStatus === 400 || err.httpStatus === 403 ? 400 : 502)
            .send({ error: "polly_failed", message: await messageFor(user, err) });
        }
        app.log.error({ err: err?.message }, "[POLLY_GENERATE] synthesis failed");
        return reply.code(500).send({ error: "generate_failed", message: "Couldn't generate the audio. Nothing was changed." });
      }

      // 2) Store it, catalog it, push it to the PBX — the same tail the
      //    ElevenLabs path runs. From here on the provider is irrelevant.
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
          provider: "polly",
          logContext: { voiceId: body.data.voiceId, engine: body.data.engine, chars: body.data.text.length },
        },
      );
      if (!saved.ok) return reply.code(saved.code).send({ error: saved.error, message: saved.message });
      return reply.send(saved.body);
    },
  );

  // ── GET /voice/polly/credentials ──────────────────────────────────────────
  // What the Amazon Polly page shows: whether credentials are set, which access
  // key ID (an identifier, not a secret — it appears in AWS's own console), the
  // last four of the secret, and whether AWS actually accepts them. The secret
  // itself is never returned by anything, ever.
  app.get("/voice/polly/credentials", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;

    const { describePollyCredentials, SUGGESTED_POLLY_REGIONS, resolvePollyCredentials } = await import("./pollyCredentials");
    const described = await describePollyCredentials(db);
    if (!described.configured) {
      return reply.send({ ...described, regions: SUGGESTED_POLLY_REGIONS, keyWorks: false, usable: false, message: null, voices: [] });
    }

    const creds = await resolvePollyCredentials(db);
    const { checkPollyCredentials, listPollyVoices, POLLY_ENGINES, POLLY_DEFAULT_ENGINE, engineSupportsSpeed } = await import("./polly");
    const [check, voices] = await Promise.all([
      checkPollyCredentials(creds!),
      listPollyVoices(creds!).catch(() => []),
    ]);

    return reply.send({
      ...described,
      regions: SUGGESTED_POLLY_REGIONS,
      engines: POLLY_ENGINES.map((e) => ({ ...e, supportsSpeed: engineSupportsSpeed(e.id) })),
      defaultEngine: POLLY_DEFAULT_ENGINE,
      keyWorks: check.ok,
      usable: check.usable ?? false,
      // This page is owner-only, so the full detail is the right thing to show.
      message: check.userMessage ?? null,
      voiceCount: check.voiceCount ?? voices.length,
      voices,
    });
  });

  // ── PUT /voice/polly/credentials ──────────────────────────────────────────
  // Save or clear. Sending a blank access key ID clears everything — the same
  // "empty means remove" convention the ElevenLabs key uses.
  app.put("/voice/polly/credentials", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;

    const body = z
      .object({
        accessKeyId: z.string().optional(),
        secretAccessKey: z.string().optional(),
        region: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const { validatePollyCredentials, storePollyCredentials } = await import("./pollyCredentials");

    if (!String(body.data.accessKeyId ?? "").trim()) {
      try {
        await storePollyCredentials(db, null, `user:${user.sub}`);
      } catch (err: any) {
        app.log.error({ err: err?.message }, "[POLLY_CREDENTIALS] clear failed");
        return reply.code(500).send({ error: "clear_failed", message: "Couldn't remove the credentials. Try again." });
      }
      app.log.info({ by: user.sub }, "[POLLY_CREDENTIALS] cleared");
      return reply.send({ ok: true, cleared: true });
    }

    // Shape-check before anything is stored: a key with a trailing space and a
    // key that AWS rejects produce the same 403, and only one of them is worth
    // someone's afternoon.
    const validated = validatePollyCredentials(body.data);
    if (!validated.ok) return reply.code(400).send({ error: "invalid_credentials", message: validated.message });

    try {
      await storePollyCredentials(db, validated.value, `user:${user.sub}`);
    } catch (err: any) {
      const missingMaster = String(err?.message || "") === "credentials_master_key_missing";
      app.log.error({ err: err?.message }, "[POLLY_CREDENTIALS] save failed");
      return reply.code(missingMaster ? 503 : 500).send({
        error: missingMaster ? "encryption_unavailable" : "save_failed",
        message: missingMaster
          ? "This server can't store credentials securely yet (CREDENTIALS_MASTER_KEY isn't set). Nothing was saved."
          : "Couldn't save the credentials. Try again.",
      });
    }

    // Tell them straight away whether AWS accepts what they just saved, rather
    // than letting them find out the first time a customer presses Generate.
    const { checkPollyCredentials } = await import("./polly");
    const check = await checkPollyCredentials(validated.value);
    app.log.info(
      { by: user.sub, region: validated.value.region, works: check.ok, usable: check.usable },
      "[POLLY_CREDENTIALS] saved",
    );
    return reply.send({
      ok: true,
      keyWorks: check.ok,
      usable: check.usable ?? false,
      message: check.userMessage ?? null,
      voiceCount: check.voiceCount ?? null,
    });
  });
}
